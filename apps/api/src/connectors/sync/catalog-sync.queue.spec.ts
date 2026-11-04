import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import {
  CatalogSyncQueueRuntime,
  FIRST_TICK_MS,
} from './catalog-sync.queue.js';

function runtime(minutes: number): CatalogSyncQueueRuntime {
  const values: Partial<AppEnvironment> = {
    REDIS_URL: 'redis://localhost:6379',
    CATALOG_SYNC_INTERVAL_MINUTES: minutes,
  };
  return new CatalogSyncQueueRuntime(
    {
      get: (key: keyof AppEnvironment) => values[key],
    } as unknown as ConfigService<AppEnvironment, true>,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('catalog sync scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a first tick soon after start, then one per interval', async () => {
    vi.useFakeTimers();
    const subject = runtime(60);
    const schedule = vi.spyOn(subject, 'schedule').mockResolvedValue();
    subject.startTimers();
    expect(schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIRST_TICK_MS);
    expect(schedule).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60_000);
    expect(schedule).toHaveBeenCalledTimes(2);
    await subject.onModuleDestroy();
    vi.advanceTimersByTime(60 * 60_000);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('schedules nothing when the interval is 0', () => {
    vi.useFakeTimers();
    const subject = runtime(0);
    const schedule = vi.spyOn(subject, 'schedule').mockResolvedValue();
    subject.startTimers();
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(schedule).not.toHaveBeenCalled();
  });
});
