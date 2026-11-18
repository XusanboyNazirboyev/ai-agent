/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import {
  CannedResponsesController,
  MAX_CANNED_RESPONSES,
} from './canned-responses.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Quick reply tests require agentcore_test');
// RLS plan S8b: fixtures on the owner, the code under test on the app role
// under the principal's tenant, as the session guard sets it.
const db = ownerClient();
const app = appClient();
const controller = tenantScoped(
  new CannedResponsesController(app as unknown as PrismaService),
);
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `canned-${id}`,
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
  return { tenantId: t.id, as };
}

const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

describe('quick replies (P1.8, ADR 070)', () => {
  it('managers write, everyone reads in order, writes are audited without the text', async () => {
    const w = await world();
    const a = await controller.create(w.as('ADMIN'), {
      title: ' Greeting ',
      text: 'Hello! How can I help?',
    });
    const b = await controller.create(w.as('OWNER'), {
      title: 'Bye',
      text: 'Thank you, goodbye.',
    });
    expect(a).toMatchObject({ title: 'Greeting', position: 0 });
    expect(b.position).toBe(1);
    await controller.update(w.as('ADMIN'), b.id, { position: 0 });
    await controller.update(w.as('ADMIN'), a.id, { position: 5, text: 'Hi!' });
    const { items } = await controller.list(w.as('VIEWER'));
    expect(items.map((i) => [i.title, i.text])).toEqual([
      ['Bye', 'Thank you, goodbye.'],
      ['Greeting', 'Hi!'],
    ]);
    await controller.remove(w.as('OWNER'), a.id);
    expect((await controller.list(w.as('OPERATOR'))).items).toHaveLength(1);
    const audits = await db.auditEvent.findMany({
      where: { tenantId: w.tenantId, entityType: 'canned_response' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((x) => x.action)).toEqual([
      'canned_response.created',
      'canned_response.created',
      'canned_response.updated',
      'canned_response.updated',
      'canned_response.deleted',
    ]);
    expect(JSON.stringify(audits)).not.toContain('goodbye');
  });

  it('operators and viewers cannot write; bad bodies and other tenants are refused', async () => {
    const w = await world();
    const other = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as Role[])
      expect(
        await status(() =>
          controller.create(w.as(role), { title: 'x', text: 'y' }),
        ),
        role,
      ).toBe(403);
    for (const body of [
      {},
      { title: '', text: 'y' },
      { title: 'x', text: ' ' },
      { title: 'x'.repeat(81), text: 'y' },
      { title: 'x', text: 'y'.repeat(2001) },
      { title: 'x', text: 'y', extra: 1 },
    ])
      expect(
        await status(() => controller.create(w.as('ADMIN'), body)),
        JSON.stringify(body).slice(0, 40),
      ).toBe(400);
    const mine = await controller.create(w.as('ADMIN'), {
      title: 'Mine',
      text: 'secret wording',
    });
    expect(
      await status(() =>
        controller.update(other.as('OWNER'), mine.id, { title: 'stolen' }),
      ),
    ).toBe(404);
    expect(
      await status(() => controller.remove(other.as('OWNER'), mine.id)),
    ).toBe(404);
    expect((await controller.list(other.as('OWNER'))).items).toEqual([]);
    expect(
      await status(() => controller.update(w.as('ADMIN'), mine.id, {})),
    ).toBe(400);
  });

  it('keeps a workspace under the cap, also when creates race', async () => {
    const w = await world();
    await db.cannedResponse.createMany({
      data: Array.from({ length: MAX_CANNED_RESPONSES - 2 }, (_, i) => ({
        tenantId: w.tenantId,
        title: `t${i}`,
        text: 'x',
        position: i,
      })),
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        status(() =>
          controller.create(w.as('ADMIN'), { title: `r${i}`, text: 'x' }),
        ),
      ),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(2);
    expect(results.filter((s) => s === 409)).toHaveLength(3);
    expect(
      await db.cannedResponse.count({ where: { tenantId: w.tenantId } }),
    ).toBe(MAX_CANNED_RESPONSES);
  });
});
