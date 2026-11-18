/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  AUDIT_CATEGORIES,
  AuditLogController,
  auditCategory,
} from './audit-log.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Audit log tests require agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const controller = new AuditLogController(db as unknown as PrismaService);
afterAll(async () => {
  await db.$disconnect();
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `audit-${id}`,
      name: 'T',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const ops = {} as Record<Role, string>;
  for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as Role[])
    ops[role] = (
      await db.operator.create({
        data: { tenantId: t.id, displayName: `${role} name`, role },
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
  let second = 0;
  const audit = (
    action: string,
    actorType: 'SYSTEM' | 'OPERATOR' | 'CUSTOMER' | 'ADMIN',
    actorId: string | null,
  ) =>
    db.auditEvent.create({
      data: {
        tenantId: t.id,
        actorType,
        actorId,
        action,
        entityType: 'x',
        entityId: 'e',
        safeInputSummary: { n: 1 },
        createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, (second += 1))),
      },
    });
  return { tenantId: t.id, ops, as, audit };
}

const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

describe('tenant audit log (ADR 074)', () => {
  it('lists newest first with operator names, pages and categories', async () => {
    const w = await world();
    const other = await world();
    await w.audit('lead.stage.moved', 'OPERATOR', w.ops.ADMIN);
    await w.audit('channel.telegram_enabled', 'OPERATOR', w.ops.OWNER);
    await w.audit('lead.stage.moved', 'SYSTEM', null);
    await w.audit('fixture.created', 'SYSTEM', null);
    await w.audit('operator.reply', 'OPERATOR', 'not-a-uuid');
    await other.audit('lead.archived', 'OPERATOR', other.ops.OWNER);

    const all = await controller.list(w.as('OWNER'), {});
    expect(all.total).toBe(5);
    expect(all.events.map((e) => e.action)).toEqual([
      'operator.reply',
      'fixture.created',
      'lead.stage.moved',
      'channel.telegram_enabled',
      'lead.stage.moved',
    ]);
    expect(all.events.map((e) => e.actor)).toEqual([
      null,
      null,
      null,
      'OWNER name',
      'ADMIN name',
    ]);
    expect(all.events.map((e) => e.category)).toEqual([
      'conversations',
      'other',
      'leads',
      'channels',
      'leads',
    ]);

    const leads = await controller.list(w.as('ADMIN'), { category: 'leads' });
    expect(leads.total).toBe(2);
    const others = await controller.list(w.as('ADMIN'), { category: 'other' });
    expect(others.events.map((e) => e.action)).toEqual(['fixture.created']);

    const page2 = await controller.list(w.as('OWNER'), {
      page: '2',
      pageSize: '2',
    });
    expect(page2.events.map((e) => e.action)).toEqual([
      'lead.stage.moved',
      'channel.telegram_enabled',
    ]);
  });

  it('operators and viewers are refused; bad queries are rejected', async () => {
    const w = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as Role[])
      expect(await status(() => controller.list(w.as(role), {}))).toBe(403);
    expect(
      await status(() => controller.list(w.as('OWNER'), { category: 'x' })),
    ).toBe(400);
    expect(
      await status(() => controller.list(w.as('OWNER'), { pageSize: '500' })),
    ).toBe(400);
  });

  it('every action written in the code base has a category', () => {
    for (const action of [
      'operator.take_over',
      'operator.set_lead_score',
      'operator.password_reset',
      'person.merged',
      'knowledge.faq_created',
      'connector.role.bound',
      'custom_field.created',
      'team.invite_created',
      'auth.mfa_enabled',
      'telegram.bot_blocked',
      'action.confirmed',
      'system.operator_idle_return',
      'export.people',
      'export.leads',
    ])
      expect(auditCategory(action), action).not.toBe('other');
    // Categories do not overlap: each prefix belongs to one category.
    const all = Object.values(AUDIT_CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
