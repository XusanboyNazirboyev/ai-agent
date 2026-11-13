import { ManualLeadService } from '../leads/manual-lead.service.js';
import { LeadArchiveService } from '../leads/lead-archive.service.js';
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { ensureLeadStages } from '../leads/lead-stage.util.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { CustomFieldsService } from '../tags/custom-fields.service.js';
import { TagsService } from '../tags/tags.service.js';
import { OperatorInviteService } from '../team/operator-invite.service.js';
import { LeadPipelineController } from '../webinbox/lead-pipeline.controller.js';
import { LeadsController } from '../webinbox/leads.controller.js';
import { PipelinesController } from '../webinbox/pipelines.controller.js';
import { TeamController } from '../webinbox/team.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Pipelines integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const pipelines = new PipelinesController(prisma);
const leadsApi = new LeadPipelineController(
  prisma,
  new TagsService(prisma),
  new CustomFieldsService(prisma),
  new ManualLeadService(prisma),
  new LeadArchiveService(prisma),
);
const board = new LeadsController(prisma);
const team = new TeamController(prisma, new OperatorInviteService(prisma));

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];

interface World {
  tenantId: string;
  contactId: string;
  conversationId: string;
  as: Record<Role, never>;
  ids: Record<Role, string>;
}

const request = (tenantId: string, operatorId: string, role: Role) =>
  ({
    principal: { tenantId, operatorId, role, sessionId: randomUUID() },
  }) as never;

async function world(): Promise<World> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('pl'),
      name: 'Pipelines fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: unique('tg'),
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: unique('u'),
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: unique('chat'),
      state: 'BOT_ACTIVE',
    },
  });
  const as = {} as Record<Role, never>;
  const ids = {} as Record<Role, string>;
  for (const role of ROLES) {
    const op = await db.operator.create({
      data: { tenantId: tenant.id, displayName: `Op ${role}`, role },
    });
    ids[role] = op.id;
    as[role] = request(tenant.id, op.id, role);
  }
  return {
    tenantId: tenant.id,
    contactId: contact.id,
    conversationId: conversation.id,
    as,
    ids,
  };
}

const newLead = (
  w: World,
  data: Record<string, unknown> = {},
): Promise<{ id: string }> =>
  db.lead.create({
    data: {
      tenantId: w.tenantId,
      contactId: w.contactId,
      conversationId: w.conversationId,
      summary: 's',
      crmSyncStatus: 'NOT_REQUIRED',
      idempotencyKey: unique('lead'),
      ...data,
    } as never,
    select: { id: true },
  });

const fail = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the call to be rejected');
    },
    (error: {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    }) => ({
      status: error.getStatus(),
      code: error.getResponse().code,
      body: error.getResponse(),
    }),
  );

const defaultPipeline = async (w: World) => {
  await db.$transaction((tx) => ensureLeadStages(tx, w.tenantId));
  return db.pipeline.findFirstOrThrow({
    where: { tenantId: w.tenantId, isDefault: true, archivedAt: null },
  });
};

describe('migration backfill and ensureLeadStages (ADR 057)', () => {
  it('ensures one unnamed default pipeline with the four coded stages, idempotently', async () => {
    const w = await world();
    expect(await db.pipeline.count({ where: { tenantId: w.tenantId } })).toBe(
      0,
    );
    const first = await db.$transaction((tx) =>
      ensureLeadStages(tx, w.tenantId),
    );
    const second = await db.$transaction((tx) =>
      ensureLeadStages(tx, w.tenantId),
    );
    expect(second).toBe(first);
    const all = await db.pipeline.findMany({ where: { tenantId: w.tenantId } });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ isDefault: true, name: null });
    const stages = await db.leadStage.findMany({
      where: { tenantId: w.tenantId },
      orderBy: { position: 'asc' },
    });
    expect(stages.map((s) => s.code)).toEqual([
      'NEW',
      'CONTACTED',
      'QUALIFIED',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    expect(stages[0]!.id).toBe(first);
    expect(stages.every((s) => s.pipelineId === all[0]!.id)).toBe(true);
  });

  it('has NOT NULL pipeline columns, so no stage or lead is left without a pipeline', async () => {
    const rows = await db.$queryRaw<Array<{ t: string; n: string }>>`
      SELECT table_name AS t, is_nullable AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'pipeline_id'
        AND table_name IN ('lead_stages', 'leads')`;
    expect(rows.map((r) => r.n)).toEqual(['NO', 'NO']);
  });

  it('a lead insert without pipeline joins its stage pipeline or the default one', async () => {
    const w = await world();
    const bare = await newLead(w);
    const def = await db.pipeline.findFirstOrThrow({
      where: { tenantId: w.tenantId, isDefault: true },
    });
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: bare.id } })).pipelineId,
    ).toBe(def.id);
    const other = await db.pipeline.create({
      data: { tenantId: w.tenantId, name: 'Other' },
    });
    const stage = await db.leadStage.create({
      data: { tenantId: w.tenantId, pipelineId: other.id, name: 'X' },
    });
    const staged = await newLead(w, { pipelineStageId: stage.id });
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: staged.id } })).pipelineId,
    ).toBe(other.id);
  });

  it('re-runs the migration backfill on the old shape: sets every pipeline, touches no other tenant, is idempotent', async () => {
    const a = await world();
    const b = await world();
    const defA = await defaultPipeline(a);
    const defB = await defaultPipeline(b);
    const stageA = await db.leadStage.findFirstOrThrow({
      where: { tenantId: a.tenantId, code: 'QUALIFIED' },
    });
    const staged = await newLead(a, { pipelineStageId: stageA.id });
    const bare = await newLead(a);
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20261121090000_pipelines_and_opportunity/migration.sql',
      ),
      'utf8',
    );
    // The idempotent backfill statements: every INSERT/UPDATE after the
    // first BACKFILL marker (comments and DDL are left out).
    const statements = sql
      .slice(sql.indexOf('-- BACKFILL-1'))
      .split(';\n')
      .map((chunk) => chunk.replace(/^(\s*--[^\n]*\n)+/g, '').trim())
      .filter((chunk) => /^(INSERT|UPDATE)\b/.test(chunk));
    expect(statements).toHaveLength(4);
    const rolledBack = new Error('rollback');
    let counts: unknown;
    await db
      .$transaction(async (tx) => {
        // Old shape for tenant A: no pipeline on stages and leads, no default.
        await tx.$executeRawUnsafe(
          'ALTER TABLE "lead_stages" ALTER COLUMN "pipeline_id" DROP NOT NULL',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "leads" ALTER COLUMN "pipeline_id" DROP NOT NULL',
        );
        await tx.$executeRawUnsafe(
          `UPDATE "leads" SET "pipeline_id" = NULL WHERE "tenant_id" = '${a.tenantId}'`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "lead_stages" SET "pipeline_id" = NULL WHERE "tenant_id" = '${a.tenantId}'`,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM "pipelines" WHERE "tenant_id" = '${a.tenantId}'`,
        );
        for (let run = 0; run < 2; run++)
          for (const match of statements) await tx.$executeRawUnsafe(match);
        const pipes = await tx.pipeline.findMany({
          where: { tenantId: a.tenantId },
        });
        const stages = await tx.leadStage.findMany({
          where: { tenantId: a.tenantId },
        });
        const leads = await tx.lead.findMany({
          where: { id: { in: [staged.id, bare.id] } },
        });
        const otherB = await tx.pipeline.findMany({
          where: { tenantId: b.tenantId },
        });
        counts = {
          pipes: pipes.length,
          isDefault: pipes[0]?.isDefault,
          unnamed: pipes[0]?.name,
          stagesAll: stages.every((s) => s.pipelineId === pipes[0]?.id),
          leadsAll: leads.every((l) => l.pipelineId === pipes[0]?.id),
          bTouched: otherB.map((p) => p.id),
        };
        throw rolledBack;
      })
      .catch((error: unknown) => {
        if (error !== rolledBack) throw error;
      });
    expect(counts).toEqual({
      pipes: 1,
      isDefault: true,
      unnamed: null,
      stagesAll: true,
      leadsAll: true,
      bTouched: [defB.id],
    });
    // The rollback restored the real shape and data.
    expect(
      (await db.pipeline.findFirstOrThrow({ where: { id: defA.id } })).id,
    ).toBe(defA.id);
  });
});

describe('pipelines CRUD, limits and make-default', () => {
  it('lists the default pipeline for every role, with counts', async () => {
    const w = await world();
    for (const role of ROLES) {
      const { items } = await pipelines.list(w.as[role]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        name: null,
        isDefault: true,
        stageCount: 7,
        leadCount: 0,
      });
    }
  });

  it('creates, renames and counts a pipeline; OWNER and ADMIN only', async () => {
    const w = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as Role[]) {
      expect(
        (await fail(pipelines.create(w.as[role], { name: 'X' }))).status,
      ).toBe(403);
    }
    const created = await pipelines.create(w.as.ADMIN, { name: ' Support ' });
    expect(created).toMatchObject({
      name: 'Support',
      isDefault: false,
      stageCount: 7,
    });
    const renamed = await pipelines.update(w.as.OWNER, created.id, {
      name: 'Care',
      position: 5,
    });
    expect(renamed).toMatchObject({ name: 'Care', position: 5 });
    expect(
      (await fail(pipelines.update(w.as.OPERATOR, created.id, { name: 'z' })))
        .status,
    ).toBe(403);
    expect(
      (await fail(pipelines.update(w.as.OWNER, created.id, {}))).code,
    ).toBe('INVALID_BODY');
    const events = await db.auditEvent.findMany({
      where: { tenantId: w.tenantId, entityType: 'pipeline' },
    });
    expect(events.map((e) => e.action).sort()).toEqual([
      'pipeline.created',
      'pipeline.updated',
    ]);
  });

  it('refuses the 11th active pipeline (PIPELINE_LIMIT) and counts archived ones out', async () => {
    const w = await world();
    const made: string[] = [];
    for (let i = 0; i < 9; i++)
      made.push((await pipelines.create(w.as.OWNER, { name: `P${i}` })).id);
    const refused = await fail(
      pipelines.create(w.as.OWNER, { name: 'one more' }),
    );
    expect(refused).toMatchObject({ status: 409, code: 'PIPELINE_LIMIT' });
    await pipelines.archive(w.as.OWNER, made[0]!);
    expect(
      (await pipelines.create(w.as.OWNER, { name: 'fits now' })).name,
    ).toBe('fits now');
  });

  it('make-default is exclusive: exactly one default, the old one gets a name', async () => {
    const w = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const { items } = await pipelines.makeDefault(w.as.ADMIN, sup.id);
    expect(items.filter((p) => p.isDefault).map((p) => p.id)).toEqual([sup.id]);
    expect(items.find((p) => !p.isDefault)?.name).toBe('Sales');
    expect(
      await db.pipeline.count({
        where: { tenantId: w.tenantId, isDefault: true, archivedAt: null },
      }),
    ).toBe(1);
    expect(
      (await fail(pipelines.makeDefault(w.as.OPERATOR, sup.id))).status,
    ).toBe(403);
    // The database refuses a second active default.
    await expect(
      db.pipeline.updateMany({
        where: { tenantId: w.tenantId, isDefault: false, archivedAt: null },
        data: { isDefault: true },
      }),
    ).rejects.toBeDefined();
    // New leads follow the new default.
    const stageId = await db.$transaction((tx) =>
      ensureLeadStages(tx, w.tenantId),
    );
    expect(
      (await db.leadStage.findFirstOrThrow({ where: { id: stageId } }))
        .pipelineId,
    ).toBe(sup.id);
  });

  it('archive refusals: default, with leads; success otherwise; 404 across tenants', async () => {
    const w = await world();
    const other = await world();
    const def = await defaultPipeline(w);
    expect(await fail(pipelines.archive(w.as.OWNER, def.id))).toMatchObject({
      status: 409,
      code: 'PIPELINE_IS_DEFAULT',
    });
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const stage = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, pipelineId: sup.id },
    });
    const lead = await newLead(w);
    await leadsApi.move(w.as.OWNER, lead.id, { stageId: stage.id });
    const refused = await fail(pipelines.archive(w.as.OWNER, sup.id));
    expect(refused).toMatchObject({ status: 409, code: 'PIPELINE_HAS_LEADS' });
    expect(refused.body.leadCount).toBe(1);
    expect((await fail(pipelines.archive(w.as.OPERATOR, sup.id))).status).toBe(
      403,
    );
    expect((await fail(pipelines.archive(other.as.OWNER, sup.id))).status).toBe(
      404,
    );
    await leadsApi.move(w.as.OWNER, lead.id, {
      stageId: (
        await db.leadStage.findFirstOrThrow({
          where: { tenantId: w.tenantId, pipelineId: def.id, code: 'NEW' },
        })
      ).id,
    });
    await pipelines.archive(w.as.OWNER, sup.id);
    expect((await pipelines.list(w.as.VIEWER)).items.map((p) => p.id)).toEqual([
      def.id,
    ]);
    expect((await fail(pipelines.archive(w.as.OWNER, sup.id))).status).toBe(
      404,
    );
  });
});

describe('stages per pipeline', () => {
  it('lists stages of the default pipeline unless pipelineId is given; foreign pipeline is 404', async () => {
    const w = await world();
    const other = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const custom = await leadsApi.createStage(w.as.ADMIN, {
      name: 'Triage',
      pipelineId: sup.id,
    });
    expect(custom.pipelineId).toBe(sup.id);
    const dflt = await leadsApi.stages(w.as.VIEWER);
    expect(dflt.map((s) => s.code)).toEqual([
      'NEW',
      'CONTACTED',
      'QUALIFIED',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    const inSup = await leadsApi.stages(w.as.VIEWER, { pipelineId: sup.id });
    expect(inSup.map((s) => s.name ?? s.code)).toEqual([
      'NEW',
      'CONTACTED',
      'QUALIFIED',
      'PROPOSAL',
      'NEGOTIATION',
      'Triage',
      'WON',
      'LOST',
    ]);
    expect(
      (await fail(leadsApi.stages(other.as.OWNER, { pipelineId: sup.id })))
        .status,
    ).toBe(404);
    expect(
      (
        await fail(
          leadsApi.createStage(other.as.OWNER, {
            name: 'x',
            pipelineId: sup.id,
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('refuses the 21st stage of a pipeline but each pipeline has its own budget', async () => {
    const w = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    for (let i = 0; i < 13; i++)
      await leadsApi.createStage(w.as.OWNER, {
        name: `S${i}`,
        pipelineId: sup.id,
      });
    expect(
      await fail(
        leadsApi.createStage(w.as.OWNER, { name: 'over', pipelineId: sup.id }),
      ),
    ).toMatchObject({ status: 409, code: 'LEAD_STAGE_LIMIT' });
    expect(
      (await leadsApi.createStage(w.as.OWNER, { name: 'default has room' }))
        .name,
    ).toBe('default has room');
  });

  it('reorders exactly the active stages; wrong sets are INVALID_BODY; roles and tenants enforced', async () => {
    const w = await world();
    const other = await world();
    const def = await defaultPipeline(w);
    const stages = await leadsApi.stages(w.as.OWNER);
    const reversed = [...stages].reverse().map((s) => s.id);
    const result = await pipelines.reorder(w.as.ADMIN, def.id, {
      stageIds: reversed,
    });
    expect(result.map((s) => s.id)).toEqual(reversed);
    expect((await leadsApi.stages(w.as.OWNER)).map((s) => s.id)).toEqual(
      reversed,
    );
    for (const bad of [
      reversed.slice(1),
      [...reversed, randomUUID()],
      [reversed[0]!, ...reversed.slice(0, 3)],
    ])
      expect(
        (await fail(pipelines.reorder(w.as.OWNER, def.id, { stageIds: bad })))
          .code,
      ).toBe('INVALID_BODY');
    expect(
      (
        await fail(
          pipelines.reorder(w.as.OPERATOR, def.id, { stageIds: reversed }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fail(
          pipelines.reorder(other.as.OWNER, def.id, { stageIds: reversed }),
        )
      ).status,
    ).toBe(404);
  });

  it('deletes an empty custom stage; refuses coded default stages and stages with leads', async () => {
    const w = await world();
    const stages = await leadsApi.stages(w.as.OWNER);
    expect(
      await fail(leadsApi.deleteStage(w.as.OWNER, stages[0]!.id)),
    ).toMatchObject({ status: 409, code: 'STAGE_IS_DEFAULT' });
    const custom = await leadsApi.createStage(w.as.OWNER, { name: 'Custom' });
    const lead = await newLead(w);
    await leadsApi.move(w.as.OWNER, lead.id, { stageId: custom.id });
    const refused = await fail(leadsApi.deleteStage(w.as.OWNER, custom.id));
    expect(refused).toMatchObject({ status: 409, code: 'STAGE_HAS_LEADS' });
    expect(refused.body.leadCount).toBe(1);
    expect(
      (await fail(leadsApi.deleteStage(w.as.OPERATOR, custom.id))).status,
    ).toBe(403);
    await leadsApi.move(w.as.OWNER, lead.id, { stageId: stages[0]!.id });
    await leadsApi.deleteStage(w.as.OWNER, custom.id);
    expect(await db.leadStage.count({ where: { id: custom.id } })).toBe(0);
  });
});

describe('moving a lead across pipelines', () => {
  it('changes pipeline and stage in one update and audits both pipelines', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const target = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, pipelineId: sup.id, code: 'CONTACTED' },
    });
    const lead = await newLead(w);
    const moved = await leadsApi.move(w.as.OPERATOR, lead.id, {
      stageId: target.id,
    });
    expect(moved).toEqual({
      id: lead.id,
      pipelineStageId: target.id,
      pipelineId: sup.id,
      status: 'NEW',
    });
    const row = await db.lead.findFirstOrThrow({ where: { id: lead.id } });
    expect(row).toMatchObject({
      pipelineId: sup.id,
      pipelineStageId: target.id,
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, entityId: lead.id },
    });
    expect(event.action).toBe('lead.stage.moved');
    expect(event.safeInputSummary).toMatchObject({
      fromPipelineId: def.id,
      toPipelineId: sup.id,
      to: target.id,
      actor: 'OPERATOR',
    });
    expect(
      (await leadsApi.list(w.as.OWNER, { pipelineId: sup.id })).items.map(
        (i) => i.id,
      ),
    ).toEqual([lead.id]);
    expect((await leadsApi.list(w.as.OWNER, {})).items).toHaveLength(0);
  });

  it('rejects a stage of another tenant (404) and a viewer (403)', async () => {
    const w = await world();
    const other = await world();
    const foreign = (await leadsApi.stages(other.as.OWNER))[0]!;
    const lead = await newLead(w);
    expect(
      (await fail(leadsApi.move(w.as.OWNER, lead.id, { stageId: foreign.id })))
        .status,
    ).toBe(404);
    expect(
      (await fail(leadsApi.move(w.as.VIEWER, lead.id, { stageId: foreign.id })))
        .status,
    ).toBe(403);
  });

  it('the composite foreign key refuses a stage of another pipeline at database level', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const supStage = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, pipelineId: sup.id },
    });
    const lead = await newLead(w);
    await expect(
      db.lead.update({
        where: { id: lead.id },
        data: { pipelineId: def.id, pipelineStageId: supStage.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      newLead(w, { pipelineId: def.id, pipelineStageId: supStage.id }),
    ).rejects.toBeDefined();
  });
});

describe('opportunity fields', () => {
  it('edits owner, amount, currency, source, close date; amount is a string and a Decimal in the database', async () => {
    const w = await world();
    const lead = await newLead(w);
    const view = await leadsApi.opportunity(w.as.OPERATOR, lead.id, {
      ownerOperatorId: w.ids.ADMIN,
      amount: '1500.5',
      currency: 'USD',
      source: ' instagram ',
      expectedCloseDate: '2026-12-31',
    });
    expect(view).toMatchObject({
      ownerOperatorId: w.ids.ADMIN,
      owner: { id: w.ids.ADMIN, displayName: 'Op ADMIN' },
      amount: '1500.50',
      currency: 'USD',
      source: 'instagram',
      expectedCloseDate: '2026-12-31',
    });
    expect(typeof view.amount).toBe('string');
    const [raw] = await db.$queryRaw<Array<{ t: string; a: string }>>`
      SELECT pg_typeof("amount")::text AS t, "amount"::text AS a FROM "leads" WHERE "id" = ${lead.id}::uuid`;
    expect(raw).toEqual({ t: 'numeric', a: '1500.50' });
    const row = await db.lead.findFirstOrThrow({ where: { id: lead.id } });
    expect(row.amount?.toFixed(2)).toBe('1500.50');
    // Partial edits keep other fields; null clears.
    const cleared = await leadsApi.opportunity(w.as.OWNER, lead.id, {
      amount: null,
      currency: null,
      ownerOperatorId: null,
    });
    expect(cleared).toMatchObject({
      amount: null,
      currency: null,
      owner: null,
      source: 'instagram',
    });
    // Audit carries field names only, never the amount.
    const events = await db.auditEvent.findMany({
      where: { tenantId: w.tenantId, action: 'lead.opportunity.updated' },
    });
    expect(JSON.stringify(events.map((e) => e.safeInputSummary))).not.toContain(
      '1500',
    );
  });

  it('refuses every invalid value with a stable code and stores nothing', async () => {
    const w = await world();
    const other = await world();
    const lead = await newLead(w);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ amount: '5' }, 'INVALID_VALUE'],
      [{ currency: 'USD' }, 'INVALID_VALUE'],
      [{ amount: 5, currency: 'USD' }, 'INVALID_BODY'],
      [{ amount: '1.234', currency: 'USD' }, 'INVALID_VALUE'],
      [{ amount: '5', currency: 'ZZZ' }, 'INVALID_VALUE'],
      [{ expectedCloseDate: '2026-02-30' }, 'INVALID_VALUE'],
      [{ lostReason: 'nope' }, 'INVALID_VALUE'],
      [{ source: 'x'.repeat(61) }, 'INVALID_VALUE'],
      [{ ownerOperatorId: randomUUID() }, 'UNKNOWN_OPERATOR'],
      [{ ownerOperatorId: other.ids.OWNER }, 'UNKNOWN_OPERATOR'],
      [{ score: 'HOT' }, 'INVALID_BODY'],
    ];
    for (const [body, code] of cases)
      expect(
        (await fail(leadsApi.opportunity(w.as.OWNER, lead.id, body))).code,
      ).toBe(code);
    const inactive = await db.operator.create({
      data: {
        tenantId: w.tenantId,
        displayName: 'Gone',
        role: 'OPERATOR',
        isActive: false,
      },
    });
    expect(
      (
        await fail(
          leadsApi.opportunity(w.as.OWNER, lead.id, {
            ownerOperatorId: inactive.id,
          }),
        )
      ).code,
    ).toBe('UNKNOWN_OPERATOR');
    const row = await db.lead.findFirstOrThrow({ where: { id: lead.id } });
    expect(row).toMatchObject({
      ownerOperatorId: null,
      amount: null,
      currency: null,
      expectedCloseDate: null,
      lostReason: null,
    });
  });

  it('the database refuses an amount without a currency', async () => {
    const w = await world();
    await expect(newLead(w, { amount: 5 })).rejects.toBeDefined();
  });

  it('role matrix and cross-tenant 404', async () => {
    const w = await world();
    const other = await world();
    const lead = await newLead(w);
    for (const role of ['OWNER', 'ADMIN', 'OPERATOR'] as Role[])
      expect(
        (await leadsApi.opportunity(w.as[role], lead.id, { source: role }))
          .source,
      ).toBe(role);
    expect(
      (await fail(leadsApi.opportunity(w.as.VIEWER, lead.id, { source: 'v' })))
        .status,
    ).toBe(403);
    expect(
      (
        await fail(
          leadsApi.opportunity(other.as.OWNER, lead.id, { source: 'x' }),
        )
      ).status,
    ).toBe(404);
  });

  it('lostReason is editable only while LOST; LOST requires it; leaving LOST clears it', async () => {
    const w = await world();
    const lead = await newLead(w);
    const status = (body: Record<string, unknown>, role: Role = 'OPERATOR') =>
      board.status(w.as[role], w.conversationId, body);
    expect(await fail(status({ status: 'LOST' }))).toMatchObject({
      status: 400,
      code: 'LOST_REASON_REQUIRED',
    });
    expect(
      (await fail(status({ status: 'LOST', lostReason: '  ' }))).code,
    ).toBe('LOST_REASON_REQUIRED');
    expect(
      (await fail(status({ status: 'WON', lostReason: 'x' }))).status,
    ).toBe(400);
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: lead.id } })).status,
    ).toBe('NEW');
    await status({ status: 'LOST', lostReason: ' too expensive ' });
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: lead.id } })).lostReason,
    ).toBe('too expensive');
    expect(
      (
        await leadsApi.opportunity(w.as.OWNER, lead.id, {
          lostReason: 'competitor',
        })
      ).lostReason,
    ).toBe('competitor');
    expect(
      (
        await fail(
          leadsApi.opportunity(w.as.OWNER, lead.id, { lostReason: null }),
        )
      ).code,
    ).toBe('INVALID_VALUE');
    await status({ status: 'IN_PROGRESS' });
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: lead.id } })).lostReason,
    ).toBeNull();
    expect(
      (
        await fail(
          leadsApi.opportunity(w.as.OWNER, lead.id, { lostReason: 'x' }),
        )
      ).code,
    ).toBe('INVALID_VALUE');
    expect((await fail(status({ status: 'WON' }, 'VIEWER'))).status).toBe(403);
  });

  it('deactivating an operator clears the leads it owned, in the same transaction', async () => {
    const w = await world();
    const mine = await newLead(w, { ownerOperatorId: w.ids.OPERATOR });
    const theirs = await newLead(w, { ownerOperatorId: w.ids.ADMIN });
    await team.update(w.as.OWNER, w.ids.OPERATOR, { isActive: false });
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: mine.id } }))
        .ownerOperatorId,
    ).toBeNull();
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: theirs.id } }))
        .ownerOperatorId,
    ).toBe(w.ids.ADMIN);
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, action: 'lead.owner_cleared' },
      }),
    ).toBe(1);
  });
});

describe('leads list: filters, new fields, batched owners', () => {
  it('filters by owner, source, close dates and pipeline; carries the additive fields', async () => {
    const w = await world();
    const other = await world();
    const a = await newLead(w, {
      ownerOperatorId: w.ids.ADMIN,
      source: 'telegram',
      expectedCloseDate: new Date('2026-06-10T00:00:00Z'),
      amount: 10,
      currency: 'UZS',
    });
    const b = await newLead(w, {
      ownerOperatorId: w.ids.OWNER,
      source: 'instagram',
      expectedCloseDate: new Date('2026-09-10T00:00:00Z'),
    });
    const c = await newLead(w);
    const ids = (q: Record<string, unknown>) =>
      leadsApi
        .list(w.as.VIEWER, q)
        .then((r) => r.items.map((i) => i.id).sort());
    expect(await ids({})).toEqual([a.id, b.id, c.id].sort());
    expect(await ids({ ownerOperatorId: w.ids.ADMIN })).toEqual([a.id]);
    expect(await ids({ source: 'INSTAGRAM' })).toEqual([b.id]);
    expect(await ids({ closeBefore: '2026-06-10' })).toEqual([a.id]);
    expect(await ids({ closeAfter: '2026-06-11' })).toEqual([b.id]);
    expect(
      await ids({ closeAfter: '2026-06-10', closeBefore: '2026-09-10' }),
    ).toEqual([a.id, b.id].sort());
    const item = (
      await leadsApi.list(w.as.VIEWER, { ownerOperatorId: w.ids.ADMIN })
    ).items[0]!;
    expect(item).toMatchObject({
      owner: { id: w.ids.ADMIN, displayName: 'Op ADMIN' },
      amount: '10.00',
      currency: 'UZS',
      source: 'telegram',
      expectedCloseDate: '2026-06-10',
      lostReason: null,
    });
    expect(item.pipelineId).toBeTruthy();
    expect(
      (await fail(leadsApi.list(w.as.VIEWER, { closeBefore: '2026-02-30' })))
        .code,
    ).toBe('INVALID_QUERY');
    expect(
      (
        await fail(
          leadsApi.list(other.as.VIEWER, {
            pipelineId: (await defaultPipeline(w)).id,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await leadsApi.list(other.as.VIEWER, { ownerOperatorId: w.ids.ADMIN }))
        .items,
    ).toHaveLength(0);
  });

  it('reads all owners of a page in one query (no N+1)', async () => {
    const w = await world();
    for (const role of ROLES)
      await newLead(w, { ownerOperatorId: w.ids[role] });
    const spy = vi.spyOn(db.operator, 'findMany');
    const page = await leadsApi.list(w.as.OWNER, {});
    expect(page.items.map((i) => i.owner?.id).sort()).toEqual(
      Object.values(w.ids).sort(),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
