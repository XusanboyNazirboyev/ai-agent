import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  EXPIRED_EVENT,
  PAST_DUE_EVENT,
  SubscriptionScanService,
} from './subscription-scan.service.js';

const DAY = 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  tenantId: string;
  status: string;
  currentPeriodEnd: Date;
  graceUntil: Date | null;
}

/** Just enough of Prisma for the scan, in memory. */
function fakeDb(rows: Row[]): {
  db: PrismaService;
  audits: { action: string; entityId: string }[];
  inbox: { tenantId: string; type: string }[];
} {
  const audits: { action: string; entityId: string }[] = [];
  const inbox: { tenantId: string; type: string }[] = [];
  const matches = (row: Row, where: Record<string, unknown>): boolean => {
    const status = where.status as string | { in: string[] } | undefined;
    if (typeof status === 'string' && row.status !== status) return false;
    if (status && typeof status === 'object' && !status.in.includes(row.status))
      return false;
    if (where.id && row.id !== where.id) return false;
    const end = where.currentPeriodEnd as { lte: Date } | undefined;
    if (end && !(row.currentPeriodEnd <= end.lte)) return false;
    const grace = where.graceUntil as { lte: Date } | undefined;
    if (grace && !(row.graceUntil && row.graceUntil <= grace.lte)) return false;
    return true;
  };
  const client = {
    tenantSubscription: {
      findMany: async ({
        where,
      }: {
        where: Record<string, unknown>;
      }): Promise<Row[]> =>
        rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Row>;
      }): Promise<{ count: number }> => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    platformAuditEvent: {
      create: async ({
        data,
      }: {
        data: { action: string; entityId: string };
      }): Promise<void> => void audits.push(data),
    },
    inboxEvent: {
      create: async ({
        data,
      }: {
        data: { tenantId: string; type: string };
      }): Promise<void> => void inbox.push(data),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { db: client as unknown as PrismaService, audits, inbox };
}

const config = (grace?: number): never =>
  ({ get: () => grace }) as unknown as never;

describe('subscription scan (ADR 047 §3, fake clock)', () => {
  const end = new Date('2026-11-10T00:00:00Z');

  it('moves an overdue ACTIVE row to PAST_DUE with grace, then to EXPIRED', async () => {
    const rows: Row[] = [
      {
        id: 's1',
        tenantId: 't1',
        status: 'ACTIVE',
        currentPeriodEnd: end,
        graceUntil: null,
      },
    ];
    const { db, audits, inbox } = fakeDb(rows);
    const scan = new SubscriptionScanService(db, config(3));

    expect(await scan.scanDue(new Date(end.getTime() - 1))).toBe(0);
    expect(rows[0]?.status).toBe('ACTIVE');

    expect(await scan.scanDue(new Date(end.getTime() + DAY))).toBe(1);
    expect(rows[0]).toMatchObject({
      status: 'PAST_DUE',
      graceUntil: new Date(end.getTime() + 3 * DAY),
    });
    // Idempotent: the same clock changes nothing more.
    expect(await scan.scanDue(new Date(end.getTime() + DAY))).toBe(0);

    expect(await scan.scanDue(new Date(end.getTime() + 3 * DAY))).toBe(1);
    expect(rows[0]?.status).toBe('EXPIRED');
    expect(await scan.scanDue(new Date(end.getTime() + 9 * DAY))).toBe(0);

    expect(audits.map((a) => a.action)).toEqual([
      'subscription.past_due',
      'subscription.expired',
    ]);
    expect(inbox.map((e) => e.type)).toEqual([PAST_DUE_EVENT, EXPIRED_EVENT]);
  });

  it('a long-missed row goes through both transitions in one pass', async () => {
    const rows: Row[] = [
      {
        id: 's2',
        tenantId: 't2',
        status: 'TRIAL',
        currentPeriodEnd: end,
        graceUntil: null,
      },
    ];
    const { db, audits } = fakeDb(rows);
    const scan = new SubscriptionScanService(db, config(undefined));
    expect(await scan.scanDue(new Date(end.getTime() + 30 * DAY))).toBe(2);
    expect(rows[0]?.status).toBe('EXPIRED');
    expect(rows[0]?.graceUntil).toEqual(new Date(end.getTime() + 3 * DAY));
    expect(audits).toHaveLength(2);
  });

  it('leaves CANCELED and EXPIRED rows alone', async () => {
    const rows: Row[] = [
      {
        id: 's3',
        tenantId: 't3',
        status: 'CANCELED',
        currentPeriodEnd: end,
        graceUntil: null,
      },
      {
        id: 's4',
        tenantId: 't4',
        status: 'EXPIRED',
        currentPeriodEnd: end,
        graceUntil: end,
      },
    ];
    const { db } = fakeDb(rows);
    const scan = new SubscriptionScanService(db, config(3));
    expect(await scan.scanDue(new Date(end.getTime() + 30 * DAY))).toBe(0);
  });
});
