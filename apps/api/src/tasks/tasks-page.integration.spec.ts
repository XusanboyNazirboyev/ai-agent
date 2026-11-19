/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { OPERATOR_ALERT_EVENT } from '../observability/alerts.service.js';
import { HandoverNotificationService } from '../handover/handover-notification.service.js';
import type { OperatorNotifier } from '../handover/operator-notifier.js';
import {
  LeadTaskReminders,
  LeadTasksController,
  localDayBounds,
} from './lead-tasks.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Tasks page tests require agentcore_test');
// RLS plan S8b: fixtures on the owner; the controller on the app role under
// the principal's tenant; the reminder scan finds due tasks on the privileged
// handle and reminds under each task's tenant.
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
const tasks = tenantScoped(new LeadTasksController(prisma));
const reminders = new LeadTaskReminders(prisma, {
  db,
} as PrivilegedDatabase);
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world(
  opts: { chat?: boolean; timezone?: string; locale?: string } = {},
) {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `task-${id}`,
      name: 'T',
      defaultLocale: opts.locale ?? 'en',
      supportedLocales: [opts.locale ?? 'en'],
      timezone: opts.timezone ?? 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `t-${id}`,
      status: 'ACTIVE',
      ...(opts.chat ? { operatorChatId: `-100${id.slice(0, 8)}` } : {}),
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      providerUserId: `u-${id}`,
      name: 'Customer',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${id}`,
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: t.id,
      contactId: contact.id,
      conversationId: conversation.id,
      score: 'WARM',
      summary: 's',
      idempotencyKey: `l-${id}`,
    },
  });
  const ops: Record<Role, string> = {} as never;
  for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as Role[])
    ops[role] = (
      await db.operator.create({
        data: { tenantId: t.id, displayName: role, role },
      })
    ).id;
  const as = (role: Role) =>
    ({
      principal: {
        tenantId: t.id,
        operatorId: ops[role],
        role,
        sessionId: 's',
      },
    }) as never;
  return {
    tenantId: t.id,
    leadId: lead.id,
    conversationId: conversation.id,
    ops,
    as,
  };
}

const code = async (work: () => unknown) => {
  try {
    await work();
    return 200;
  } catch (error) {
    return (error as { getStatus(): number }).getStatus();
  }
};

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('Tasks page API (ADR 068 amendment)', () => {
  it('splits tasks into overdue, today, upcoming and done with matching counts', async () => {
    const w = await world();
    const { end } = localDayBounds(new Date(), 'UTC');
    const me = w.as('OPERATOR');
    const mk = (title: string, dueAt: string) =>
      tasks.create(me, w.leadId, { title, dueAt });
    await mk('late', ago(2 * HOUR));
    const soon = new Date(Math.min(Date.now() + 60_000, end.getTime() - 1));
    await mk('soon', soon.toISOString());
    await mk('next week', ahead(8 * 24 * HOUR));
    const finished = await mk('finished', ago(HOUR));
    await tasks.update(me, finished.id, { done: true });
    const titles = async (status: string) =>
      (await tasks.listAll(me, { status })).items.map((t) => t.title);
    expect(await titles('overdue')).toEqual(['late']);
    expect(await titles('upcoming')).toEqual(['next week']);
    expect(await titles('done')).toEqual(['finished']);
    expect((await tasks.listAll(me, { status: 'overdue' })).counts).toEqual({
      overdue: 1,
      today: expect.any(Number),
      upcoming: 1,
      done: 1,
    });
    // 'soon' is today, unless the test runs in the last minute of the day.
    expect([[], ['soon']]).toContainEqual(await titles('today'));
  });

  it('scope mine / all, assignee filter, cursor paging, contact name', async () => {
    const w = await world();
    const op = w.as('OPERATOR');
    const admin = w.as('ADMIN');
    await tasks.create(op, w.leadId, {
      title: 'a',
      dueAt: ahead(10 * 24 * HOUR),
    });
    await tasks.create(op, w.leadId, {
      title: 'b',
      dueAt: ahead(11 * 24 * HOUR),
    });
    await tasks.create(admin, w.leadId, {
      title: 'c',
      dueAt: ahead(12 * 24 * HOUR),
    });
    const mine = await tasks.listAll(admin, { status: 'upcoming' });
    expect(mine.items.map((t) => t.title)).toEqual(['c']);
    const all = await tasks.listAll(admin, {
      scope: 'all',
      status: 'upcoming',
    });
    expect(all.items.map((t) => t.title)).toEqual(['a', 'b', 'c']);
    expect(all.items[0]!.contactName).toBe('Customer');
    const one = await tasks.listAll(admin, {
      scope: 'all',
      status: 'upcoming',
      assigneeId: w.ops.OPERATOR,
    });
    expect(one.items.map((t) => t.title)).toEqual(['a', 'b']);
    expect(one.counts.upcoming).toBe(2);
    const first = await tasks.listAll(admin, {
      scope: 'all',
      status: 'upcoming',
      limit: '2',
    });
    expect(first.items.map((t) => t.title)).toEqual(['a', 'b']);
    expect(first.nextCursor).not.toBeNull();
    const second = await tasks.listAll(admin, {
      scope: 'all',
      status: 'upcoming',
      limit: '2',
      cursor: first.nextCursor,
    });
    expect(second.items.map((t) => t.title)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
  });

  it('is strict about parameters, leaves out archived leads, never crosses workspaces', async () => {
    const a = await world();
    const b = await world();
    await tasks.create(a.as('OPERATOR'), a.leadId, {
      title: 'A',
      dueAt: ahead(9 * 24 * HOUR),
    });
    await tasks.create(b.as('OPERATOR'), b.leadId, {
      title: 'B',
      dueAt: ahead(9 * 24 * HOUR),
    });
    const seen = await tasks.listAll(a.as('OWNER'), {
      scope: 'all',
      status: 'upcoming',
    });
    expect(seen.items.map((t) => t.title)).toEqual(['A']);
    expect(seen.counts.upcoming).toBe(1);
    expect(await code(() => tasks.listAll(a.as('OWNER'), { bogus: '1' }))).toBe(
      400,
    );
    expect(
      await code(() => tasks.listAll(a.as('OWNER'), { status: 'nope' })),
    ).toBe(400);
    expect(
      await code(() => tasks.listAll(a.as('OWNER'), { assigneeId: 'x' })),
    ).toBe(400);
    // Another workspace's operator id as a filter shows nothing of it.
    expect(
      (
        await tasks.listAll(a.as('OWNER'), {
          scope: 'all',
          status: 'upcoming',
          assigneeId: b.ops.OPERATOR,
        })
      ).items,
    ).toEqual([]);
    await db.lead.update({
      where: { id: a.leadId },
      data: { archivedAt: new Date() },
    });
    const after = await tasks.listAll(a.as('OWNER'), {
      scope: 'all',
      status: 'upcoming',
    });
    expect(after.items).toEqual([]);
    expect(after.counts.upcoming).toBe(0);
  });

  it('computes today in the tenant time zone', () => {
    // 2031-03-20 21:00 UTC is already 21 March 02:00 in Tashkent (UTC+5).
    const { start, end } = localDayBounds(
      new Date('2031-03-20T21:00:00Z'),
      'Asia/Tashkent',
    );
    expect(start.toISOString()).toBe('2031-03-20T19:00:00.000Z');
    expect(end.toISOString()).toBe('2031-03-21T19:00:00.000Z');
    expect(
      localDayBounds(
        new Date('2031-03-20T21:00:00Z'),
        'Nope/Zone',
      ).start.toISOString(),
    ).toBe('2031-03-20T00:00:00.000Z');
  });
});

describe('reminder before the due time', () => {
  it('stores remind_at, announces at the reminder time, re-arms on change', async () => {
    const w = await world();
    const me = w.as('ADMIN');
    const due = new Date(Date.now() + 2 * HOUR);
    const task = await tasks.create(me, w.leadId, {
      title: 'R',
      dueAt: due.toISOString(),
      remindBefore: 60,
    });
    expect(task.remindAt).toBe(new Date(due.getTime() - HOUR).toISOString());
    const events = () =>
      db.inboxEvent.count({
        where: { tenantId: w.tenantId, type: 'task.due' },
      });
    await reminders.scanDue(new Date(), 1000);
    expect(await events()).toBe(0);
    const reminderTime = new Date(due.getTime() - HOUR + 1000);
    await reminders.scanDue(reminderTime, 1000);
    await reminders.scanDue(reminderTime, 1000);
    expect(await events()).toBe(1);
    const event = await db.inboxEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, type: 'task.due' },
    });
    expect(event.taskTitle).toBe('R');
    // A new reminder choice re-arms it; the old lead time is kept on a new due time.
    const again = await tasks.update(me, task.id, { remindBefore: 15 });
    expect(again.remindAt).toBe(
      new Date(due.getTime() - 15 * 60_000).toISOString(),
    );
    const moved = new Date(due.getTime() + HOUR);
    const kept = await tasks.update(me, task.id, {
      dueAt: moved.toISOString(),
    });
    expect(kept.remindAt).toBe(
      new Date(moved.getTime() - 15 * 60_000).toISOString(),
    );
    await reminders.scanDue(
      new Date(moved.getTime() - 15 * 60_000 + 1000),
      1000,
    );
    expect(await events()).toBe(2);
    const cleared = await tasks.update(me, task.id, { remindBefore: null });
    expect(cleared.remindAt).toBeNull();
    expect(
      await code(() => tasks.update(me, task.id, { remindBefore: 7 as never })),
    ).toBe(400);
  });
});

describe('Telegram message for a due task', () => {
  const posted: Array<{ chat: string; text: string }> = [];
  const direct: Array<{ user: string; text: string }> = [];
  let refuse = false;
  const notifier = {
    kind: 'fake',
    postDirect: (user: string, text: string) => {
      if (refuse)
        return Promise.reject(
          Object.assign(new Error('Forbidden'), { errorCode: 403 }),
        );
      direct.push({ user, text });
      return Promise.resolve({ messageId: '2' });
    },
    postCard: (target: { operatorChatId: string }, card: { text: string }) => {
      posted.push({ chat: target.operatorChatId, text: card.text });
      return Promise.resolve({ messageId: '1' });
    },
  } as unknown as OperatorNotifier;
  const service = tenantScoped(
    new HandoverNotificationService(prisma, notifier),
  );
  const outbox = (tenantId: string) =>
    db.outboxEvent.findMany({
      where: { tenantId, type: OPERATOR_ALERT_EVENT },
    });

  it('queues one alert per announcement, builds the text, skips without a group, never uses another tenant', async () => {
    posted.length = 0;
    const withGroup = await world({
      chat: true,
      timezone: 'Asia/Tashkent',
      locale: 'uz-Latn',
    });
    const noGroup = await world();
    const now = new Date();
    const dueAt = new Date('2031-03-20T21:00:00Z');
    const task = await tasks.create(withGroup.as('ADMIN'), withGroup.leadId, {
      title: 'Qo‘ng‘iroq <b>qil</b>\nyangi qator',
      dueAt: ago(1000),
    });
    await db.leadTask.update({ where: { id: task.id }, data: { dueAt } });
    await db.leadTask.update({
      where: { id: task.id },
      data: { dueAt: new Date(now.getTime() - 1000) },
    });
    await tasks.create(noGroup.as('ADMIN'), noGroup.leadId, {
      title: 'X',
      dueAt: ago(1000),
    });
    await Promise.all([
      reminders.scanDue(now, 1000),
      reminders.scanDue(now, 1000),
    ]);
    await reminders.scanDue(now, 1000);
    const queued = await outbox(withGroup.tenantId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      payload: { kind: 'TASK_DUE', taskId: task.id },
    });
    expect(await outbox(noGroup.tenantId)).toHaveLength(0);
    // Without a group the in-app event still exists.
    expect(
      await db.inboxEvent.count({
        where: { tenantId: noGroup.tenantId, type: 'task.due' },
      }),
    ).toBe(1);

    await service.process({
      outboxId: randomUUID(),
      tenantId: withGroup.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: queued[0]!.payload,
    } as never);
    expect(posted).toHaveLength(1);
    const chat = (
      await db.channelAccount.findFirstOrThrow({
        where: { tenantId: withGroup.tenantId },
      })
    ).operatorChatId;
    expect(posted[0]!.chat).toBe(chat);
    expect(posted[0]!.text).toContain(
      '⏰ Vazifa vaqti keldi: Qo‘ng‘iroq <b>qil</b> yangi qator',
    );
    expect(posted[0]!.text).toContain('Mijoz: Customer');
    expect(posted[0]!.text).toContain('Mas’ul: ADMIN');
    expect(posted[0]!.text).toMatch(/Muddat: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);

    // A task id of another workspace sends nothing.
    posted.length = 0;
    await service.process({
      outboxId: randomUUID(),
      tenantId: noGroup.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: queued[0]!.payload,
    } as never);
    expect(posted).toHaveLength(0);
    await service.process({
      outboxId: randomUUID(),
      tenantId: withGroup.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: { kind: 'TASK_DUE', taskId: randomUUID() },
    } as never);
    expect(posted).toHaveLength(0);
  });

  it('formats the due time in the tenant zone (ru)', async () => {
    posted.length = 0;
    const w = await world({
      chat: true,
      timezone: 'Asia/Tashkent',
      locale: 'ru',
    });
    const task = await tasks.create(w.as('OPERATOR'), w.leadId, {
      title: 'Позвонить',
      dueAt: ahead(HOUR),
    });
    await db.leadTask.update({
      where: { id: task.id },
      data: {
        dueAt: new Date('2031-03-20T21:00:00Z'),
        assigneeOperatorId: null,
      },
    });
    await service.process({
      outboxId: randomUUID(),
      tenantId: w.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: { kind: 'TASK_DUE', taskId: task.id },
    } as never);
    expect(posted[0]!.text).toBe(
      '⏰ Пора выполнить задачу: Позвонить\nКлиент: Customer\nОтветственный: не назначен\nСрок: 21.03.2031 02:00',
    );
  });

  it('also messages the assignee privately; a refusal is a skip; no other tenant', async () => {
    posted.length = 0;
    direct.length = 0;
    const w = await world({ chat: true });
    const other = await world({ chat: true });
    const tg = `tg-${randomUUID()}`;
    await db.operator.update({
      where: { id: w.ops.OPERATOR },
      data: { telegramUserId: tg },
    });
    // The same Telegram id in another workspace is never messaged.
    await db.operator.update({
      where: { id: other.ops.OPERATOR },
      data: { telegramUserId: `other-${randomUUID()}` },
    });
    const mk = async (assignee: string | null) => {
      const task = await tasks.create(w.as('ADMIN'), w.leadId, {
        title: 'Call',
        dueAt: ahead(HOUR),
      });
      await db.leadTask.update({
        where: { id: task.id },
        data: { assigneeOperatorId: assignee },
      });
      await service.process({
        outboxId: randomUUID(),
        tenantId: w.tenantId,
        type: OPERATOR_ALERT_EVENT,
        payload: { kind: 'TASK_DUE', taskId: task.id },
      } as never);
    };
    await mk(w.ops.OPERATOR);
    expect(posted).toHaveLength(1);
    expect(direct).toHaveLength(1);
    expect(direct[0]!.user).toBe(tg);
    expect(direct[0]!.text).toBe(posted[0]!.text);

    // No Telegram id on the assignee, or no assignee: group only.
    await mk(w.ops.VIEWER);
    await mk(null);
    expect(posted).toHaveLength(3);
    expect(direct).toHaveLength(1);

    // Telegram refuses (not started): the group message stands, nothing throws.
    refuse = true;
    await mk(w.ops.OPERATOR);
    refuse = false;
    expect(posted).toHaveLength(4);
    expect(direct).toHaveLength(1);

    // A task of this workspace never reaches the other workspace's operator.
    expect(direct.some((d) => d.user.startsWith('other-'))).toBe(false);
  });
});
