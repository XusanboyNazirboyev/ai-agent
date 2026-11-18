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

describe('catalog sync tenant context (RLS plan S6)', () => {
  it('lists connectors with no tenant and builds each one in its own tenant', async () => {
    const { currentTenant } =
      await import('../../persistence/tenant-context.js');
    const tenantA = '01a1ecc9-0000-7000-8000-00000000000a';
    const tenantB = '01a1ecc9-0000-7000-8000-00000000000b';
    const seen: Array<{ step: string; tenant: string | null }> = [];
    const rows = [
      { id: 'c1', tenantId: tenantA },
      { id: 'c2', tenantId: tenantB },
    ];
    const subject = new CatalogSyncQueueRuntime(
      {
        get: (key: string) =>
          ({
            REDIS_URL: 'redis://localhost:6379',
            CATALOG_SYNC_INTERVAL_MINUTES: 0,
          })[key],
      } as unknown as ConfigService<AppEnvironment, true>,
      { staleAfter: 60_000 } as never,
      {
        recoverStaleRuns: () => {
          seen.push({ step: 'recover', tenant: currentTenant() });
          return Promise.resolve(0);
        },
      } as never,
      {
        listActive: () => {
          seen.push({ step: 'list', tenant: currentTenant() });
          return Promise.resolve(rows);
        },
        create: (row: { tenantId: string }) => {
          seen.push({
            step: `create ${row.tenantId}`,
            tenant: currentTenant(),
          });
          return Promise.resolve({ capabilities: { sync: false } });
        },
      } as never,
    );
    await subject.schedule();
    expect(seen).toEqual([
      { step: 'recover', tenant: null },
      { step: 'list', tenant: null },
      { step: `create ${tenantA}`, tenant: tenantA },
      { step: `create ${tenantB}`, tenant: tenantB },
    ]);
  });
});
