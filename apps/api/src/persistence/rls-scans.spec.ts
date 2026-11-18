import { describe, expect, it } from 'vitest';
import { DigestService } from '../handover/digest.service.js';
import { InboxEventsService } from '../webinbox/inbox-events.service.js';
import { currentTenant } from './tenant-context.js';

/**
 * RLS plan S7: a scheduled scan finds due work on the privileged connection
 * without a tenant, then does each tenant's work in that tenant's context.
 */
const A = '01a1ecc9-0000-7000-8000-0000000000aa';
const B = '01a1ecc9-0000-7000-8000-0000000000bb';

type Seen = Array<{ db: string; call: string; tenant: string | null }>;

function recorder(
  name: string,
  seen: Seen,
  models: Record<string, Record<string, (args: unknown) => unknown>>,
): unknown {
  return Object.fromEntries(
    Object.entries(models).map(([model, methods]) => [
      model,
      Object.fromEntries(
        Object.entries(methods).map(([method, result]) => [
          method,
          (args: unknown) => {
            seen.push({
              db: name,
              call: `${model}.${method}`,
              tenant: currentTenant(),
            });
            return Promise.resolve(result(args));
          },
        ]),
      ),
    ]),
  );
}

describe('scheduled scans and the tenant context (RLS plan S7)', () => {
  it('the morning digest finds tenants without one and queues each in its own', async () => {
    const seen: Seen = [];
    const main = recorder('main', seen, {
      outboxEvent: { createMany: () => ({ count: 1 }) },
    });
    const privileged = recorder('privileged', seen, {
      channelAccount: {
        findMany: () => [
          { tenantId: A, tenant: { timezone: 'UTC' } },
          { tenantId: B, tenant: { timezone: 'UTC' } },
        ],
      },
    });
    const digest = new DigestService(
      main as never,
      {
        get: (key: string) => ({ DIGEST_ENABLED: true, DIGEST_HOUR: 0 })[key],
      } as never,
      { db: privileged } as never,
    );
    expect(await digest.scanDue(new Date('2026-11-18T10:00:00Z'))).toBe(2);
    expect(seen).toEqual([
      { db: 'privileged', call: 'channelAccount.findMany', tenant: null },
      { db: 'main', call: 'outboxEvent.createMany', tenant: A },
      { db: 'main', call: 'outboxEvent.createMany', tenant: B },
    ]);
  });

  it('the inbox feed is pruned for every tenant on the privileged connection', async () => {
    const seen: Seen = [];
    const main = recorder('main', seen, {});
    const privileged = recorder('privileged', seen, {
      inboxEvent: { deleteMany: () => ({ count: 3 }) },
    });
    const events = new InboxEventsService(
      main as never,
      { db: privileged } as never,
    );
    expect(await events.scanDue(new Date())).toBe(3);
    expect(seen).toEqual([
      { db: 'privileged', call: 'inboxEvent.deleteMany', tenant: null },
    ]);
  });
});
