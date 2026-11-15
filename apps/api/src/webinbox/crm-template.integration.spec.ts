/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { CrmTemplateController } from './crm-template.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('CRM template tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
const controller = new CrmTemplateController(prisma);
afterAll(async () => {
  await db.$disconnect();
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world(packKey = 'travel', defaultLocale = 'uz-Latn') {
  const t = await db.tenant.create({
    data: {
      slug: `tpl-${randomUUID()}`,
      name: 'Template fixture',
      defaultLocale,
      supportedLocales: ['uz-Latn', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey,
      packVersion: '1',
    },
  });
  const as = (role: Role) =>
    ({
      principal: {
        tenantId: t.id,
        operatorId: randomUUID(),
        role,
        sessionId: randomUUID(),
      },
    }) as never;
  return { tenantId: t.id, as };
}

const call = async (work: () => unknown) => {
  try {
    await work();
    return { status: 200, code: undefined as unknown };
  } catch (error) {
    const e = error as {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    };
    return { status: e.getStatus(), code: e.getResponse().code };
  }
};

const counts = async (tenantId: string) => ({
  pipelines: await db.pipeline.count({ where: { tenantId, archivedAt: null } }),
  stages: await db.leadStage.count({ where: { tenantId } }),
  fields: await db.customFieldDef.count({ where: { tenantId } }),
  tags: await db.tag.count({ where: { tenantId } }),
});

describe('tourism template (UX review step 7)', () => {
  it('shows the template in the workspace language, then creates the pipeline, fields and tags', async () => {
    const w = await world();
    const before = await controller.view(w.as('ADMIN'));
    expect(before).toMatchObject({
      available: true,
      key: 'tourism',
      pipelineName: 'Turlar',
      pipelineExists: false,
    });
    expect(before.stages!.map((s) => `${s.code}:${s.kind}`)).toEqual([
      'INQUIRY:OPEN',
      'OFFER_SENT:OPEN',
      'PREPAYMENT:OPEN',
      'DOCUMENTS:OPEN',
      'PAID:WON',
      'TRAVELLED:WON',
      'LOST:LOST',
    ]);
    expect(before.leadFields!.map((f) => f.label)).toContain('Yo‘nalish');
    expect(before.tags!.map((t) => t.name)).toEqual([
      'Oilaviy',
      'Asal oyi',
      'Qaynoq tur',
    ]);

    const done = await controller.apply(w.as('OWNER'), { makeDefault: true });
    expect(done).toMatchObject({
      created: { pipeline: true, fields: 5, tags: 3 },
      madeDefault: true,
    });
    const tours = await db.pipeline.findUniqueOrThrow({
      where: { id: done.pipelineId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    expect(tours).toMatchObject({ name: 'Turlar', isDefault: true });
    expect(tours.stages.map((s) => s.code)).toEqual([
      'INQUIRY',
      'OFFER_SENT',
      'PREPAYMENT',
      'DOCUMENTS',
      'PAID',
      'TRAVELLED',
      'LOST',
    ]);
    // The old default stays, named, and no longer takes new leads.
    const old = await db.pipeline.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: { not: done.pipelineId } },
    });
    expect(old).toMatchObject({ isDefault: false, name: 'Sales' });
    const fields = await db.customFieldDef.findMany({
      where: { tenantId: w.tenantId, entity: 'LEAD' },
      orderBy: { position: 'asc' },
    });
    expect(fields.map((f) => `${f.key}:${f.type}`)).toEqual([
      'destination:TEXT',
      'departure_date:DATE',
      'travellers:NUMBER',
      'budget:NUMBER',
      'needs_visa:BOOLEAN',
    ]);
    const tags = await db.tag.findMany({ where: { tenantId: w.tenantId } });
    expect(tags.map((t) => `${t.name}:${t.color}`).sort()).toEqual([
      'Asal oyi:purple',
      'Oilaviy:green',
      'Qaynoq tur:red',
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'crm_template.applied' },
    });
    expect(audit.safeInputSummary).toMatchObject({
      template: 'tourism',
      fieldsCreated: 5,
    });

    // Applying again adds nothing and changes nothing.
    const before2 = await counts(w.tenantId);
    const again = await controller.apply(w.as('ADMIN'), { makeDefault: true });
    expect(again).toMatchObject({
      pipelineId: done.pipelineId,
      created: { pipeline: false, fields: 0, tags: 0 },
      madeDefault: false,
    });
    expect(await counts(w.tenantId)).toEqual(before2);
    expect((await controller.view(w.as('ADMIN'))).pipelineExists).toBe(true);
  });

  it('keeps what the workspace already has: an archived field key and a tag with another case are not added again', async () => {
    const w = await world();
    await db.customFieldDef.create({
      data: {
        tenantId: w.tenantId,
        entity: 'LEAD',
        key: 'budget',
        label: 'Old budget',
        type: 'TEXT',
        archivedAt: new Date(),
      },
    });
    await db.tag.create({ data: { tenantId: w.tenantId, name: 'OILAVIY' } });
    const view = await controller.view(w.as('ADMIN'));
    expect(view.leadFields!.find((f) => f.key === 'budget')!.exists).toBe(true);
    expect(view.tags!.find((t) => t.name === 'Oilaviy')!.exists).toBe(true);
    const done = await controller.apply(w.as('ADMIN'), { makeDefault: false });
    expect(done.created).toEqual({ pipeline: true, fields: 4, tags: 2 });
    expect(done.madeDefault).toBe(false);
    // The old field is untouched and the default pipeline did not change.
    expect(
      await db.customFieldDef.findFirstOrThrow({
        where: { tenantId: w.tenantId, key: 'budget' },
      }),
    ).toMatchObject({ label: 'Old budget', type: 'TEXT' });
    expect(
      (await db.pipeline.findUniqueOrThrow({ where: { id: done.pipelineId } }))
        .isDefault,
    ).toBe(false);
  });

  it('names things in the workspace language', async () => {
    const w = await world('travel', 'ru');
    const view = await controller.view(w.as('ADMIN'));
    expect(view.pipelineName).toBe('Туры');
    expect(view.tags!.map((t) => t.name)).toContain('Горящий тур');
  });

  it('is for owners and admins only, and a workspace without a template has none', async () => {
    const w = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as Role[]) {
      expect((await call(() => controller.view(w.as(role)))).status).toBe(403);
      expect(
        (await call(() => controller.apply(w.as(role), { makeDefault: true })))
          .status,
      ).toBe(403);
    }
    expect(
      await call(() => controller.apply(w.as('ADMIN'), { makeDefault: 'yes' })),
    ).toEqual({ status: 400, code: 'INVALID_BODY' });
    const education = await world('education');
    expect(await controller.view(education.as('ADMIN'))).toEqual({
      available: false,
    });
    expect(
      await call(() =>
        controller.apply(education.as('ADMIN'), { makeDefault: true }),
      ),
    ).toEqual({ status: 400, code: 'NO_TEMPLATE' });
    expect(await counts(w.tenantId)).toEqual({
      pipelines: 0,
      stages: 0,
      fields: 0,
      tags: 0,
    });
  });

  it('changes nothing when the pipeline limit is reached', async () => {
    const w = await world();
    await controller.view(w.as('ADMIN'));
    for (let i = 0; i < 10; i += 1)
      await db.pipeline.create({
        data: {
          tenantId: w.tenantId,
          name: `P${i}`,
          position: i + 1,
          isDefault: i === 0,
        },
      });
    const before = await counts(w.tenantId);
    expect(
      await call(() => controller.apply(w.as('ADMIN'), { makeDefault: true })),
    ).toEqual({ status: 409, code: 'PIPELINE_LIMIT' });
    expect(await counts(w.tenantId)).toEqual(before);
  });

  it('never touches another workspace', async () => {
    const a = await world();
    const b = await world();
    await controller.apply(a.as('ADMIN'), { makeDefault: true });
    expect(await counts(b.tenantId)).toEqual({
      pipelines: 0,
      stages: 0,
      fields: 0,
      tags: 0,
    });
  });
});
