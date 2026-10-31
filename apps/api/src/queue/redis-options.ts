import type { RedisOptions } from 'bullmq';

/** BullMQ key namespace; integration tests set a per-run prefix. */
export function bullmqPrefix(): string {
  return process.env.BULLMQ_PREFIX?.trim() || 'bull';
}

/** BullMQ connection options from the validated REDIS_URL. */
export function redisOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis or rediss');
  }
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isSafeInteger(db) || db < 0) {
    throw new Error('REDIS_URL contains an invalid database number');
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}
