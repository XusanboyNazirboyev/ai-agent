import { describe, expect, it } from 'vitest';
import { SubscriptionScanService } from '../access/subscription-scan.service.js';
import { DigestService } from '../handover/digest.service.js';
import { InboxEventBus } from '../webinbox/inbox-event-bus.js';
import { LeadTaskReminders } from '../tasks/lead-tasks.js';
import { InboxEventsService } from '../webinbox/inbox-events.service.js';
import { currentTenant, runWithTenant } from './tenant-context.js';

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
          (args: unknown): Promise<unknown> => {
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

  it('the subscription reminder finds periods without a tenant and queues each in its own', async () => {
    const seen: Seen = [];
    const end = new Date('2026-11-20T09:00:00Z');
    const main = recorder('main', seen, {
      outboxEvent: { createMany: () => ({ count: 1 }) },
    });
    const privileged = recorder('privileged', seen, {
      tenantSubscription: {
        // Only the reminder's query (a period still running) finds rows.
        findMany: (args) =>
          (args as { where: { currentPeriodEnd?: { gt?: Date } } }).where
            .currentPeriodEnd?.gt
            ? [{ id: 's1', tenantId: A, currentPeriodEnd: end }]
            : [],
      },
    });
    const scan = new SubscriptionScanService(
      main as never,
      { get: () => 3 } as never,
      undefined,
      { db: privileged } as never,
    );
    expect(await scan.scanDue(new Date('2026-11-18T09:00:00Z'))).toBe(1);
    expect(seen).toEqual([
      { db: 'privileged', call: 'tenantSubscription.findMany', tenant: null },
      { db: 'privileged', call: 'tenantSubscription.findMany', tenant: null },
      { db: 'privileged', call: 'tenantSubscription.findMany', tenant: null },
      { db: 'main', call: 'outboxEvent.createMany', tenant: A },
    ]);
  });

  it('task reminders find due tasks without a tenant and claim each in its own', async () => {
    const seen: Seen = [];
    const tx = recorder('main', seen, {
      leadTask: { updateMany: () => ({ count: 1 }) },
      inboxEvent: { create: () => ({}) },
      // Tenant A has an operator group (Telegram queued), B has none.
      channelAccount: {
        count: () => (currentTenant() === A ? 1 : 0),
      },
      outboxEvent: { createMany: () => ({ count: 1 }) },
    }) as Record<string, unknown>;
    const main = {
      ...tx,
      $transaction: <T>(work: (client: unknown) => Promise<T>): Promise<T> =>
        work(tx),
    };
    const privileged = recorder('privileged', seen, {
      leadTask: {
        findMany: () => [
          {
            id: 'k1',
            tenantId: A,
            title: 'Call',
            lead: { conversationId: null },
          },
          {
            id: 'k2',
            tenantId: B,
            title: 'Call',
            lead: { conversationId: null },
          },
        ],
      },
    });
    const reminders = new LeadTaskReminders(
      main as never,
      { db: privileged } as never,
    );
    expect(await reminders.scanDue(new Date())).toBe(2);
    expect(seen).toEqual([
      { db: 'privileged', call: 'leadTask.findMany', tenant: null },
      { db: 'main', call: 'leadTask.updateMany', tenant: A },
      { db: 'main', call: 'inboxEvent.create', tenant: A },
      { db: 'main', call: 'channelAccount.count', tenant: A },
      { db: 'main', call: 'outboxEvent.createMany', tenant: A },
      { db: 'main', call: 'leadTask.updateMany', tenant: B },
      { db: 'main', call: 'inboxEvent.create', tenant: B },
      { db: 'main', call: 'channelAccount.count', tenant: B },
    ]);
  });

  it('the inbox event poller reads with no tenant even when a request starts it', async () => {
    const seen: Seen = [];
    const main = recorder('main', seen, {});
    const privileged = recorder('privileged', seen, {
      inboxEvent: { findFirst: () => ({ id: 5n }), findMany: () => [] },
    });
    const bus = new InboxEventBus(main as never, { db: privileged } as never);
    bus.pollMs = 60_000;
    const unsubscribe = await runWithTenant(A, () =>
      bus.subscribe(A, () => undefined),
    );
    await runWithTenant(A, () => bus.tick());
    unsubscribe();
    bus.onModuleDestroy();
    expect(seen.every((entry) => entry.db === 'privileged')).toBe(true);
    expect(seen.map((entry) => entry.tenant)).toEqual([null, null, null]);
  });
});
