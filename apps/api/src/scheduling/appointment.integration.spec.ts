import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AppointmentService, type HoldInput } from './appointment.service.js';
import {
  HoldExpiredError,
  InvalidAppointmentStateError,
  SchedulingNotFoundError,
  SlotTakenError,
  SlotUnavailableError,
} from './scheduling.errors.js';

/** ADR 046 step 1 on the real database, including the exclusion constraint. */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Scheduling integration tests require agentcore_test');

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const service = new AppointmentService(db as unknown as PrismaService);
const suffix = randomUUID().slice(0, 8);
const DAY = 24 * 3_600_000;
const tenantIds: string[] = [];

interface Fixture {
  tenantId: string;
  contactId: string;
  conversationId: string;
  staffId: string;
  serviceId: string;
  /** A bookable start: 7 days ahead at 10:00 Asia/Tashkent (05:00Z). */
  startsAt: Date;
}

async function fixture(label: string): Promise<Fixture> {
  const tenant = await db.tenant.create({
    data: {
      slug: `sched-${label}-${suffix}`,
      name: 'Scheduling fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'generic',
      packVersion: '1',
    },
  });
  tenantIds.push(tenant.id);
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `acc-${label}-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `user-${label}`,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `chat-${label}`,
    },
  });
  const staff = await db.staffMember.create({
    data: {
      tenantId: tenant.id,
      displayName: 'Staff A',
      skills: ['repair'],
    },
  });
  await db.availabilityRule.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      tenantId: tenant.id,
      staffMemberId: staff.id,
      weekday,
      startTime: '09:00',
      endTime: '18:00',
    })),
  });
  const svc = await db.serviceType.create({
    data: {
      tenantId: tenant.id,
      key: 'visit',
      title: 'Visit',
      durationMinutes: 60,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
      leadTimeMinutes: 60,
      requiredSkills: ['repair'],
    },
  });
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 7);
  day.setUTCHours(5, 0, 0, 0);
  return {
    tenantId: tenant.id,
    contactId: contact.id,
    conversationId: conversation.id,
    staffId: staff.id,
    serviceId: svc.id,
    startsAt: day,
  };
}

const holdInput = (
  f: Fixture,
  key: string,
  startsAt = f.startsAt,
): HoldInput => ({
  serviceTypeId: f.serviceId,
  staffMemberId: f.staffId,
  startsAt,
  contactId: f.contactId,
  conversationId: f.conversationId,
  idempotencyKey: key,
});

let a: Fixture;
let b: Fixture;
beforeAll(async () => {
  a = await fixture('a');
  b = await fixture('b');
});
afterAll(async () => {
  for (const id of tenantIds) {
    await db.appointment.deleteMany({ where: { tenantId: id } });
    await db.tenant.delete({ where: { id } });
  }
  await db.$disconnect();
});

describe('appointment service (ADR 046 step 1)', () => {
  it('finds slots, holds and confirms one', async () => {
    const day = new Date(a.startsAt.getTime() - 5 * 3_600_000);
    const slots = await service.findSlots(a.tenantId, {
      serviceTypeId: a.serviceId,
      from: day,
      to: new Date(day.getTime() + 24 * 3_600_000),
      limit: 500,
    });
    expect(
      slots.some((s) => s.startsAt.getTime() === a.startsAt.getTime()),
    ).toBe(true);

    const held = await service.hold(a.tenantId, holdInput(a, `k-${suffix}-1`));
    expect(held.status).toBe('HELD');
    expect(held.holdExpiresAt).not.toBeNull();
    expect(held.blockedFrom.getTime()).toBe(a.startsAt.getTime() - 10 * 60_000);
    expect(held.blockedUntil.getTime()).toBe(
      a.startsAt.getTime() + 75 * 60_000,
    );

    // The held slot no longer shows up.
    const after = await service.findSlots(a.tenantId, {
      serviceTypeId: a.serviceId,
      from: a.startsAt,
      to: new Date(a.startsAt.getTime() + 1),
    });
    expect(after).toHaveLength(0);

    const confirmed = await service.confirm(a.tenantId, held.id);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.holdExpiresAt).toBeNull();
    // Idempotent.
    expect((await service.confirm(a.tenantId, held.id)).status).toBe(
      'CONFIRMED',
    );
  });

  it('cancelling frees the slot', async () => {
    const t = new Date(a.startsAt.getTime() + 1 * DAY);
    const held = await service.hold(
      a.tenantId,
      holdInput(a, `k-${suffix}-c`, t),
    );
    await expect(
      service.hold(a.tenantId, holdInput(a, `k-${suffix}-c2`, t)),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect((await service.cancel(a.tenantId, held.id)).status).toBe(
      'CANCELLED',
    );
    await expect(service.confirm(a.tenantId, held.id)).rejects.toBeInstanceOf(
      InvalidAppointmentStateError,
    );
    const again = await service.hold(
      a.tenantId,
      holdInput(a, `k-${suffix}-c3`, t),
    );
    expect(again.status).toBe('HELD');
  });

  it('lets exactly one of two concurrent holds win (database constraint)', async () => {
    const t = new Date(a.startsAt.getTime() + 2 * DAY);
    const overlapping = new Date(t.getTime() + 15 * 60_000);
    const results = await Promise.allSettled([
      service.hold(a.tenantId, holdInput(a, `k-${suffix}-r1`, t)),
      service.hold(a.tenantId, holdInput(a, `k-${suffix}-r2`, t)),
      service.hold(a.tenantId, holdInput(a, `k-${suffix}-r3`, overlapping)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(2);
    for (const f of failed)
      expect(
        f.reason instanceof SlotTakenError ||
          f.reason instanceof SlotUnavailableError,
      ).toBe(true);
  });

  it('maps the database exclusion violation to SlotTakenError', async () => {
    // Deterministic race: a competing row is committed on another connection
    // after this transaction's engine check but before its insert.
    const t = new Date(a.startsAt.getTime() + 3 * DAY);
    const racing = {
      $transaction: (fn: (tx: PrismaClient) => Promise<unknown>) =>
        db.$transaction((tx) =>
          fn({
            contact: tx.contact,
            conversation: tx.conversation,
            tenant: tx.tenant,
            serviceType: tx.serviceType,
            staffMember: tx.staffMember,
            appointment: {
              findMany: tx.appointment.findMany.bind(tx.appointment),
              updateMany: tx.appointment.updateMany.bind(tx.appointment),
              create: async (
                args: Parameters<typeof tx.appointment.create>[0],
              ) => {
                await db.appointment.create({
                  data: {
                    tenantId: a.tenantId,
                    serviceTypeId: a.serviceId,
                    staffMemberId: a.staffId,
                    contactId: a.contactId,
                    startsAt: t,
                    endsAt: new Date(t.getTime() + 3_600_000),
                    blockedFrom: t,
                    blockedUntil: new Date(t.getTime() + 3_600_000),
                    status: 'CONFIRMED',
                    idempotencyKey: `k-${suffix}-x2`,
                  },
                });
                return tx.appointment.create(args);
              },
            },
          } as unknown as PrismaClient),
        ),
      appointment: db.appointment,
      tenant: db.tenant,
      serviceType: db.serviceType,
      staffMember: db.staffMember,
      contact: db.contact,
      conversation: db.conversation,
    } as unknown as PrismaService;
    await expect(
      new AppointmentService(racing).hold(
        a.tenantId,
        holdInput(a, `k-${suffix}-x1`, t),
      ),
    ).rejects.toBeInstanceOf(SlotTakenError);
    // The loser left nothing behind.
    expect(
      await db.appointment.count({
        where: { tenantId: a.tenantId, idempotencyKey: `k-${suffix}-x1` },
      }),
    ).toBe(0);
  });

  it('treats an expired hold as free and refuses to confirm it', async () => {
    const t = new Date(a.startsAt.getTime() + 4 * DAY);
    const past = new Date(Date.now() - 3_600_000);
    const stale = await service.hold(a.tenantId, {
      ...holdInput(a, `k-${suffix}-e1`, t),
      now: past, // holdExpiresAt = past + 10 min: already expired
    });
    await expect(service.confirm(a.tenantId, stale.id)).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
    const row = await db.appointment.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(row.status).toBe('EXPIRED');

    const fresh = await service.hold(
      a.tenantId,
      holdInput(a, `k-${suffix}-e2`, t),
    );
    expect(fresh.status).toBe('HELD');
  });

  it('sweeps an expired hold that was never confirmed when the slot is re-held', async () => {
    const t = new Date(a.startsAt.getTime() + 5 * DAY);
    const stale = await service.hold(a.tenantId, {
      ...holdInput(a, `k-${suffix}-s1`, t),
      now: new Date(Date.now() - 3_600_000),
    });
    const fresh = await service.hold(
      a.tenantId,
      holdInput(a, `k-${suffix}-s2`, t),
    );
    expect(fresh.id).not.toBe(stale.id);
    const row = await db.appointment.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(row.status).toBe('EXPIRED');
  });

  it('is idempotent by (tenantId, idempotencyKey)', async () => {
    const t = new Date(a.startsAt.getTime() + 6 * DAY);
    const key = `k-${suffix}-i`;
    const first = await service.hold(a.tenantId, holdInput(a, key, t));
    const second = await service.hold(a.tenantId, holdInput(a, key, t));
    expect(second.id).toBe(first.id);
    const parallel = await Promise.all([
      service.hold(
        a.tenantId,
        holdInput(a, `${key}-p`, new Date(t.getTime() + 2 * 3_600_000)),
      ),
      service.hold(
        a.tenantId,
        holdInput(a, `${key}-p`, new Date(t.getTime() + 2 * 3_600_000)),
      ),
    ]);
    expect(parallel[0].id).toBe(parallel[1].id);
  });

  it('isolates tenants', async () => {
    const held = await service.hold(b.tenantId, holdInput(b, `k-${suffix}-t1`));
    // Tenant A cannot see, confirm or cancel tenant B's appointment.
    await expect(service.confirm(a.tenantId, held.id)).rejects.toBeInstanceOf(
      SchedulingNotFoundError,
    );
    await expect(service.cancel(a.tenantId, held.id)).rejects.toBeInstanceOf(
      SchedulingNotFoundError,
    );
    // ...nor use B's service type, staff member or contact.
    await expect(
      service.hold(a.tenantId, {
        ...holdInput(a, `k-${suffix}-t2`),
        serviceTypeId: b.serviceId,
      }),
    ).rejects.toBeInstanceOf(SchedulingNotFoundError);
    await expect(
      service.hold(a.tenantId, {
        ...holdInput(a, `k-${suffix}-t3`),
        staffMemberId: b.staffId,
      }),
    ).rejects.toBeInstanceOf(SchedulingNotFoundError);
    await expect(
      service.hold(a.tenantId, {
        ...holdInput(a, `k-${suffix}-t4`),
        contactId: b.contactId,
      }),
    ).rejects.toBeInstanceOf(SchedulingNotFoundError);
  });

  it('enforces lead time and skills at hold time', async () => {
    // Inside the 60 minute lead time.
    await expect(
      service.hold(a.tenantId, {
        ...holdInput(a, `k-${suffix}-l1`, new Date(Date.now() + 15 * 60_000)),
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    // A staff member without the required skill.
    const other = await db.staffMember.create({
      data: { tenantId: a.tenantId, displayName: 'No skill', skills: [] },
    });
    await db.availabilityRule.create({
      data: {
        tenantId: a.tenantId,
        staffMemberId: other.id,
        weekday: a.startsAt.getUTCDay() === 0 ? 7 : a.startsAt.getUTCDay(),
        startTime: '09:00',
        endTime: '18:00',
      },
    });
    await expect(
      service.hold(a.tenantId, {
        ...holdInput(a, `k-${suffix}-l2`),
        staffMemberId: other.id,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    // Outside working hours (03:00 local).
    await expect(
      service.hold(
        a.tenantId,
        holdInput(
          a,
          `k-${suffix}-l3`,
          new Date(a.startsAt.getTime() - 7 * 3_600_000),
        ),
      ),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });
});
