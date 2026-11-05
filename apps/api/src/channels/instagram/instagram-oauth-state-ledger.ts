import { createHash } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppEnvironment } from '../../config/environment.js';
import { redisOptions } from '../../queue/redis-options.js';

/** The ledger could not be reached: refuse instead of risking a replay. */
export class OAuthStateLedgerUnavailableError extends Error {
  constructor() {
    super('Instagram authorization state ledger is unavailable');
    this.name = 'OAuthStateLedgerUnavailableError';
  }
}

/**
 * Makes each authorization state single-use: the first `consume` of a state
 * wins, every later one (a replayed callback, a second tab) is refused.
 */
export abstract class OAuthStateLedger {
  /** True the first time, false afterwards; throws OAuthStateLedgerUnavailableError. */
  abstract consume(state: string, ttlMs: number): Promise<boolean>;
}

const KEY_PREFIX = 'agentcore:instagram-oauth-state:';
const TIMEOUT_MS = 3_000;

/** Only a hash of the state is stored, never the state itself. */
export const ledgerKey = (state: string): string =>
  `${KEY_PREFIX}${createHash('sha256').update(state).digest('hex')}`;

/** The one Redis command the ledger needs, so tests can fake it. */
export interface LedgerRedis {
  set(
    key: string,
    value: string,
    px: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<string | null>;
  quit(): Promise<unknown>;
}

/** Atomic `SET key 1 PX ttl NX` on the app's Redis (REDIS_URL). */
@Injectable()
export class RedisOAuthStateLedger
  extends OAuthStateLedger
  implements OnModuleDestroy
{
  private client?: LedgerRedis;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  /** Overridden in tests with a fake client. */
  protected connect(url: string): LedgerRedis {
    return new Redis({
      ...redisOptions(url),
      // Fail fast: a callback must not hang while Redis is down.
      maxRetriesPerRequest: 1,
      connectTimeout: TIMEOUT_MS,
      lazyConnect: true,
    });
  }

  private redis(): LedgerRedis {
    this.client ??= this.connect(this.config.get('REDIS_URL', { infer: true }));
    return this.client;
  }

  async consume(state: string, ttlMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        this.redis().set(ledgerKey(state), '1', 'PX', ttlMs, 'NX'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        }),
      ]);
      return answer === 'OK';
    } catch {
      throw new OAuthStateLedgerUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
