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
import { LeadTaskReminders, LeadTasksController } from './lead-tasks.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Lead task tests require agentcore_test');
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

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `task-${id}`,
      name: 'T',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
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

describe('lead tasks (P1.6, ADR 068)', () => {
  it('adds, lists, finishes and deletes a task; the adder is the default assignee', async () => {
    const w = await world();
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const task = await tasks.create(w.as('OPERATOR'), w.leadId, {
      title: '  Call back  ',
      dueAt: due,
    });
    expect(task).toMatchObject({
      title: 'Call back',
      doneAt: null,
      overdue: false,
    });
    expect(task.assignee?.id).toBe(w.ops.OPERATOR);
    const mine = await tasks.mine(w.as('OPERATOR'), {});
    expect(mine.items.map((t) => t.id)).toEqual([task.id]);
    expect(mine.items[0]!.contactName).toBe('Customer');
    const done = await tasks.update(w.as('OPERATOR'), task.id, { done: true });
    expect(done.doneAt).not.toBeNull();
    expect((await tasks.mine(w.as('OPERATOR'), {})).items).toEqual([]);
    expect((await tasks.list(w.as('VIEWER'), w.leadId)).items).toHaveLength(1);
    await tasks.remove(w.as('ADMIN'), task.id);
    expect((await tasks.list(w.as('OWNER'), w.leadId)).items).toHaveLength(0);
  });

  it('refuses a viewer, a bad body, an unknown assignee and another workspace', async () => {
    const w = await world();
    const other = await world();
    const due = new Date(Date.now() + 60_000).toISOString();
    expect(
      await code(() =>
        tasks.create(w.as('VIEWER'), w.leadId, { title: 'x', dueAt: due }),
      ),
    ).toBe(403);
    for (const body of [
      {},
      { title: '', dueAt: due },
      { title: 'x', dueAt: 'tomorrow' },
      { title: 'x', dueAt: due, extra: 1 },
    ])
      expect(
        await code(() => tasks.create(w.as('ADMIN'), w.leadId, body)),
      ).toBe(400);
    expect(
      await code(() =>
        tasks.create(w.as('ADMIN'), w.leadId, {
          title: 'x',
          dueAt: due,
          assigneeId: other.ops.ADMIN,
        }),
      ),
    ).toBe(400);
    expect(
      await code(() =>
        tasks.create(other.as('ADMIN'), w.leadId, { title: 'x', dueAt: due }),
      ),
    ).toBe(404);
    const mineTask = await tasks.create(w.as('ADMIN'), w.leadId, {
      title: 'x',
      dueAt: due,
    });
    expect(
      await code(() =>
        tasks.update(other.as('ADMIN'), mineTask.id, { done: true }),
      ),
    ).toBe(404);
    expect(await code(() => tasks.remove(other.as('ADMIN'), mineTask.id))).toBe(
      404,
    );
    expect(await code(() => tasks.list(other.as('ADMIN'), w.leadId))).toBe(404);
  });

  it('announces a due task once, on the lead conversation, and again only after a new time', async () => {
    const w = await world();
    const now = new Date();
    const task = await tasks.create(w.as('ADMIN'), w.leadId, {
      title: 'Due',
      dueAt: new Date(now.getTime() - 1000).toISOString(),
    });
    await tasks.create(w.as('ADMIN'), w.leadId, {
      title: 'Later',
      dueAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const done = await tasks.create(w.as('ADMIN'), w.leadId, {
      title: 'Done',
      dueAt: new Date(now.getTime() - 1000).toISOString(),
    });
    await tasks.update(w.as('ADMIN'), done.id, { done: true });
    const events = () =>
      db.inboxEvent.count({
        where: {
          tenantId: w.tenantId,
          type: 'task.due',
          conversationId: w.conversationId,
        },
      });
    await reminders.scanDue(now, 1000);
    await reminders.scanDue(now, 1000);
    expect(await events()).toBe(1);
    // Moving the time announces it again when the new time comes.
    await tasks.update(w.as('ADMIN'), task.id, {
      dueAt: new Date(now.getTime() - 500).toISOString(),
    });
    await reminders.scanDue(now, 1000);
    expect(await events()).toBe(2);
  });

  it('two scans running at once announce a task only once', async () => {
    const w = await world();
    const now = new Date();
    await tasks.create(w.as('ADMIN'), w.leadId, {
      title: 'Race',
      dueAt: new Date(now.getTime() - 1000).toISOString(),
    });
    await Promise.all([
      reminders.scanDue(now, 1000),
      reminders.scanDue(now, 1000),
      reminders.scanDue(now, 1000),
    ]);
    expect(
      await db.inboxEvent.count({
        where: { tenantId: w.tenantId, type: 'task.due' },
      }),
    ).toBe(1);
  });
});
