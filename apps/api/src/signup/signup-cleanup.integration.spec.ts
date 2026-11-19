import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { ownerClient } from '../persistence/testing/test-clients.js';
import { SignupCleanupScan } from './signup-cleanup.scan.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Signup cleanup tests require agentcore_test');

/** ADR 080: expired self-serve signups are purged; confirmed ones and trial claims stay. */
const db = ownerClient();
const NOW = new Date('2031-06-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const suffix = randomUUID().slice(0, 8);
let planId = '';
const made: string[] = [];

const signup = async (
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'REFUSED',
  expiredDaysAgo: number,
): Promise<string> => {
  const id = randomUUID();
  made.push(id);
  await db.pendingSignup.create({
    data: {
      id,
      tokenHash:
        randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
      bindingHash: 'b',
      businessName: 'Biz',
      personName: 'Person',
      email: `cleanup-${suffix}-${id.slice(0, 6)}@example.test`,
      passwordHash: 'x',
      planId,
      status,
      expiresAt: new Date(NOW.getTime() - expiredDaysAgo * DAY),
    },
  });
  return id;
};
const exists = async (id: string): Promise<boolean> =>
  (await db.pendingSignup.count({ where: { id } })) === 1;

beforeAll(async () => {
  const plan = await db.subscriptionPlan.create({
    data: {
      code: `cleanup-${suffix}`,
      name: 'Cleanup test',
      priceMinor: 100n,
      periodDays: 30,
      isPublic: false,
    },
  });
  planId = plan.id;
});

afterAll(async () => {
  await db.pendingSignup.deleteMany({ where: { id: { in: made } } });
  await db.subscriptionPlan.delete({ where: { id: planId } });
  await db.$disconnect();
});

describe('signup cleanup scan', () => {
  it('deletes old unconfirmed signups only, in batches, keeping trial claims', async () => {
    const oldPending = await signup('PENDING', 8);
    const oldExpired = await signup('EXPIRED', 30);
    const oldRefused = await signup('REFUSED', 9);
    const recent = await signup('EXPIRED', 3);
    const justInside = await signup('PENDING', 6);
    const confirmed = await signup('CONFIRMED', 400);
    const claim = await db.trialClaim.create({
      data: {
        telegramUserId: `tg-${suffix}`,
        phone: `+998${suffix}`.slice(0, 20),
      },
    });
    try {
      const scan = new SignupCleanupScan({
        db,
      } as unknown as PrivilegedDatabase);
      expect(await scan.scanDue(NOW)).toBe(3);
      expect(await exists(oldPending)).toBe(false);
      expect(await exists(oldExpired)).toBe(false);
      expect(await exists(oldRefused)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(await exists(justInside)).toBe(true);
      expect(await exists(confirmed)).toBe(true);
      expect(await db.trialClaim.count({ where: { id: claim.id } })).toBe(1);
      // Runs at most once an hour per process.
      expect(await scan.scanDue(new Date(NOW.getTime() + 60_000))).toBe(0);
      // An hour later nothing is left to delete.
      expect(await scan.scanDue(new Date(NOW.getTime() + 2 * 3_600_000))).toBe(
        0,
      );
    } finally {
      await db.trialClaim.delete({ where: { id: claim.id } });
    }
  });
});
