import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ledgerKey,
  RedisOAuthStateLedger,
} from './instagram-oauth-state-ledger.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const config = { get: () => REDIS_URL } as never;
const probe = new Redis(REDIS_URL, { lazyConnect: true });
const ledgers: RedisOAuthStateLedger[] = [];
afterAll(async () => {
  await Promise.all(ledgers.map((l) => l.onModuleDestroy()));
  probe.disconnect();
});

describe('RedisOAuthStateLedger on a real Redis', () => {
  it('spends a state exactly once under concurrency and sets the TTL', async () => {
    const state = `test-${randomBytes(24).toString('hex')}`;
    const a = new RedisOAuthStateLedger(config);
    const b = new RedisOAuthStateLedger(config);
    ledgers.push(a, b);
    const results = await Promise.all([
      a.consume(state, 60_000),
      b.consume(state, 60_000),
      a.consume(state, 60_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const ttl = await probe.pttl(ledgerKey(state));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await probe.get(ledgerKey(state))).toBe('1');
    await probe.del(ledgerKey(state));
  });
});
