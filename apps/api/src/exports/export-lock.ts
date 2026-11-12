import { createHash } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppEnvironment } from '../config/environment.js';
import { redisOptions } from '../queue/redis-options.js';
import { EXPORT_LOCK_TTL_MS } from './csv.js';

const KEY_PREFIX = 'agentcore:export-lock:';
const TIMEOUT_MS = 3_000;

export class ExportInProgressError extends Error {
  constructor() {
    super('Export already in progress');
    this.name = 'ExportInProgressError';
  }
}

export class ExportTooLargeError extends Error {
  constructor() {
    super('Export too large');
    this.name = 'ExportTooLargeError';
  }
}

interface LockRedis {
  set(
    key: string,
    value: string,
    px: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<string | null>;
  eval(
    script: string,
    numkeys: number,
    key: string,
    value: string,
  ): Promise<unknown>;
  quit(): Promise<unknown>;
}

export const lockKey = (tenantId: string): string =>
  `${KEY_PREFIX}${createHash('sha256').update(tenantId).digest('hex')}`;

@Injectable()
export class ExportLock implements OnModuleDestroy {
  private readonly local = new Map<string, string>();
  private client?: LockRedis;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protected connect(url: string): LockRedis {
    return new Redis({
      ...redisOptions(url),
      maxRetriesPerRequest: 1,
      connectTimeout: TIMEOUT_MS,
      lazyConnect: true,
    }) as unknown as LockRedis;
  }

  private redis(): LockRedis {
    this.client ??= this.connect(this.config.get('REDIS_URL', { infer: true }));
    return this.client;
  }

  async acquire(tenantId: string): Promise<() => Promise<void>> {
    const token = `${tenantId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (this.local.has(tenantId)) throw new ExportInProgressError();
    this.local.set(tenantId, token);
    let timer: NodeJS.Timeout | undefined;
    try {
      const ok = await Promise.race([
        this.redis().set(
          lockKey(tenantId),
          token,
          'PX',
          EXPORT_LOCK_TTL_MS,
          'NX',
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        }),
      ]);
      if (ok !== 'OK') throw new ExportInProgressError();
    } catch (e) {
      if (this.local.get(tenantId) === token) this.local.delete(tenantId);
      if (e instanceof ExportInProgressError) throw e;
      throw new ExportInProgressError();
    } finally {
      clearTimeout(timer);
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (this.local.get(tenantId) === token) this.local.delete(tenantId);
      const script =
        "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
      await this.redis()
        .eval(script, 1, lockKey(tenantId), token)
        .catch(() => undefined);
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
