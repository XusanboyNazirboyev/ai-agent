import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppEnvironment } from '../../config/environment.js';
import { redisOptions } from '../../queue/redis-options.js';

/** Echoes arrive within seconds; a day covers Meta's webhook retries. */
const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'agentcore:meta-sent:';

export interface MetaSentRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  exists(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/**
 * ADR 088: every message id Meta returns for a send of ours (all text parts,
 * carousels, audio, private replies). An echo whose id is not here was sent
 * by a person from the Instagram or Messenger app. Only a hash of the id is
 * kept, for a day.
 */
@Injectable()
export class MetaSentLedger implements OnModuleDestroy {
  private readonly logger = new Logger(MetaSentLedger.name);
  private client?: MetaSentRedis;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() client?: MetaSentRedis,
  ) {
    this.client = client;
  }

  /** Never throws: the message is already sent, a lost record only pauses the bot. */
  async record(mid: string): Promise<void> {
    try {
      await this.redis().set(key(mid), '1', 'PX', TTL_MS);
    } catch {
      this.logger.warn(JSON.stringify({ event: 'meta_sent_record_failed' }));
    }
  }

  async has(mid: string): Promise<boolean> {
    return (await this.redis().exists(key(mid))) > 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  private redis(): MetaSentRedis {
    this.client ??= new Redis({
      ...redisOptions(this.config.get('REDIS_URL', { infer: true })),
      lazyConnect: false,
    });
    return this.client;
  }
}

function key(mid: string): string {
  return KEY_PREFIX + createHash('sha256').update(mid).digest('hex');
}
