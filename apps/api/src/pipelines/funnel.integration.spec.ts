/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DomainPack } from '@agentcore/shared';
import { PrismaClient } from '../generated/prisma/client.js';
import { LeadService } from '../leads/lead.service.js';
import { ensureLeadStages } from '../leads/lead-stage.util.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { CustomFieldsService } from '../tags/custom-fields.service.js';
import { TagsService } from '../tags/tags.service.js';
import { LeadPipelineController } from '../webinbox/lead-pipeline.controller.js';
import { LeadsController } from '../webinbox/leads.controller.js';
import { PipelinesController } from '../webinbox/pipelines.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Funnel integration tests require agentcore_test');
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
);
const board = new LeadsController(prisma);
const service = new LeadService(prisma);

// Only the fields LeadService reads: one search slot and one intent rule.
const PACK = {
  slots: [{ key: 'city', requiredFor: ['search'] }],
  leadScoring: {
    hot: 5,
    warm: 3,
    rules: [
      {
        code: 'wants_booking',
        points: 10,
        when: { kind: 'intent', intent: 'book' },
      },
    ],
  },
} as unknown as DomainPack;

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];

interface World {
  tenantId: string;
  accountId: string;
  contactId: string;
  conversationId: string;
  as: Record<Role, never>;
}

async function world(): Promise<World> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('fn'),
      name: 'Funnel fixture',
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
  for (const role of ROLES) {
    const op = await db.operator.create({
      data: { tenantId: tenant.id, displayName: `Op ${role}`, role },
    });
    as[role] = {
      principal: {
        tenantId: tenant.id,
        operatorId: op.id,
        role,
        sessionId: randomUUID(),
      },
    } as never;
  }
  return {
    tenantId: tenant.id,
    accountId: account.id,
    contactId: contact.id,
    conversationId: conversation.id,
    as,
  };
}

const fail = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the call to be rejected');
    },
    (error: {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    }) => ({ status: error.getStatus(), code: error.getResponse().code }),
  );

let sequence = 0;
const say = (
  w: World,
  authorType: 'CUSTOMER' | 'BOT',
  text: string,
): Promise<unknown> =>
  db.message.create({
    data: {
      tenantId: w.tenantId,
      conversationId: w.conversationId,
      channelAccountId: w.accountId,
      authorType,
      direction: authorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
      text,
      sequence: ++sequence,
      providerChatId: unique('chat'),
    },
  });

const rescore = (
  w: World,
  slots: Record<string, { value: string | number }> = {},
) =>
  db.$transaction((tx) =>
    service.rescore(tx, {
      tenantId: w.tenantId,
      conversationId: w.conversationId,
      pack: PACK,
      slots,
      intent: 'book',
    }),
  );

const stageOf = async (leadId: string) => {
  const lead = await db.lead.findFirstOrThrow({
    where: { id: leadId },
    include: { pipelineStage: true },
  });
  return { code: lead.pipelineStage?.code, lead };
};
const stageId = async (w: World, pipelineId: string, code: string) =>
  (
    await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, pipelineId, code },
    })
  ).id;
const defaultPipeline = async (w: World) => {
  await db.$transaction((tx) => ensureLeadStages(tx, w.tenantId));
  return db.pipeline.findFirstOrThrow({
    where: { tenantId: w.tenantId, isDefault: true, archivedAt: null },
  });
};

/** A lead of the world on a stage, bypassing the agent. */
const seedLead = async (
  w: World,
  pipelineId: string,
  stage: string,
  data: Record<string, unknown> = {},
) => {
  const contact = await db.contact.create({
    data: {
      tenantId: w.tenantId,
      channelAccountId: w.accountId,
      providerUserId: unique('u'),
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: w.tenantId,
      channelAccountId: w.accountId,
      contactId: contact.id,
      providerChatId: unique('chat'),
      state: 'BOT_ACTIVE',
    },
  });
  return db.lead.create({
    data: {
      tenantId: w.tenantId,
      contactId: contact.id,
      conversationId: conversation.id,
      pipelineId,
      pipelineStageId: await stageId(w, pipelineId, stage),
      summary: 's',
      crmSyncStatus: 'NOT_REQUIRED',
      idempotencyKey: unique('lead'),
      ...data,
    } as never,
    select: { id: true },
  });
};

describe('defaults and migration (ADR 058)', () => {
  it('existing rows keep today behaviour: stages OPEN, pipelines OFF, leads AGENT without suggestion', async () => {
    const w = await world();
    // A pipeline inserted without the new column (the pre-058 shape).
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "pipelines" ("id","tenant_id","name","position","is_default")
      VALUES (gen_random_uuid(), ${w.tenantId}::uuid, 'Old', 0, true) RETURNING "id"`;
    const oldId = rows[0]!.id;
    await db.leadStage.create({
      data: {
        tenantId: w.tenantId,
        pipelineId: oldId,
        code: 'HOT',
        position: 0,
      },
    });
    expect(
      await db.pipeline.findFirstOrThrow({ where: { id: oldId } }),
    ).toMatchObject({ aiStaging: 'OFF' });
    expect(
      await db.leadStage.findFirstOrThrow({ where: { pipelineId: oldId } }),
    ).toMatchObject({ kind: 'OPEN' });
    // ensureCodedStages leaves a pipeline that already has stages untouched.
    await db.$transaction((tx) => ensureLeadStages(tx, w.tenantId));
    expect(await db.leadStage.count({ where: { pipelineId: oldId } })).toBe(1);
    const lead = await seedLead(w, oldId, 'HOT');
    expect(
      await db.lead.findFirstOrThrow({ where: { id: lead.id } }),
    ).toMatchObject({
      stageSetBy: 'AGENT',
      stageSetAt: null,
      suggestedStageId: null,
      suggestedReasonCodes: [],
    });
  });

  it('the migration is additive: no data statements', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20261122090000_funnel_stage_kind_and_ai_staging/migration.sql',
      ),
      'utf8',
    );
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP|TRUNCATE)\b/im);
  });

  it('new default pipelines and POST /pipelines start AUTO; the seven stages carry their kinds', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    expect(def.aiStaging).toBe('AUTO');
    const created = await pipelines.create(w.as.OWNER, { name: 'Support' });
    expect(created.aiStaging).toBe('AUTO');
    const stages = await leadsApi.stages(w.as.VIEWER, {
      pipelineId: created.id,
    });
    expect(stages.map((s) => [s.code, s.kind])).toEqual([
      ['NEW', 'OPEN'],
      ['CONTACTED', 'OPEN'],
      ['QUALIFIED', 'OPEN'],
      ['PROPOSAL', 'OPEN'],
      ['NEGOTIATION', 'OPEN'],
      ['WON', 'WON'],
      ['LOST', 'LOST'],
    ]);
  });

  it('PATCH aiStaging: OWNER and ADMIN only, 404 across tenants', async () => {
    const w = await world();
    const other = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    for (const role of ['OPERATOR', 'VIEWER'] as Role[])
      expect(
        (await fail(pipelines.update(w.as[role], sup.id, { aiStaging: 'OFF' })))
          .status,
      ).toBe(403);
    expect(
      (await pipelines.update(w.as.ADMIN, sup.id, { aiStaging: 'SUGGEST' }))
        .aiStaging,
    ).toBe('SUGGEST');
    expect(
      (
        await fail(
          pipelines.update(other.as.OWNER, sup.id, { aiStaging: 'OFF' }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fail(
          pipelines.update(w.as.OWNER, sup.id, { aiStaging: 'ON' } as never),
        )
      ).status,
    ).toBe(400);
  });
});

describe('moveLeadToStage through the operator routes', () => {
  it('WON and LOST stages drive the status; LOST needs a reason; leaving them reopens', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const lead = await seedLead(w, def.id, 'NEW');
    const won = await stageId(w, def.id, 'WON');
    const lost = await stageId(w, def.id, 'LOST');
    expect(
      await leadsApi.move(w.as.OPERATOR, lead.id, { stageId: won }),
    ).toMatchObject({
      status: 'WON',
    });
    expect(
      await fail(leadsApi.move(w.as.OPERATOR, lead.id, { stageId: lost })),
    ).toMatchObject({ status: 400, code: 'LOST_REASON_REQUIRED' });
    expect(
      await leadsApi.move(w.as.OPERATOR, lead.id, {
        stageId: lost,
        lostReason: 'too dear',
      }),
    ).toMatchObject({ status: 'LOST' });
    expect((await stageOf(lead.id)).lead).toMatchObject({
      status: 'LOST',
      lostReason: 'too dear',
    });
    expect(
      await leadsApi.move(w.as.OPERATOR, lead.id, {
        stageId: await stageId(w, def.id, 'QUALIFIED'),
      }),
    ).toMatchObject({ status: 'IN_PROGRESS' });
    expect((await stageOf(lead.id)).lead).toMatchObject({
      status: 'IN_PROGRESS',
      lostReason: null,
      stageSetBy: 'OPERATOR',
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: {
        tenantId: w.tenantId,
        entityId: lead.id,
        action: 'lead.stage.moved',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.safeInputSummary).toMatchObject({ actor: 'OPERATOR' });
  });

  it('the status route moves the lead to the first WON/LOST stage, or only sets the status without one', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const a = await seedLead(w, def.id, 'NEW');
    const conv = (id: string) =>
      db.lead.findFirstOrThrow({ where: { id } }).then((l) => l.conversationId);
    await board.status(w.as.OPERATOR, await conv(a.id), { status: 'WON' });
    expect((await stageOf(a.id)).code).toBe('WON');
    await board.status(w.as.OPERATOR, await conv(a.id), {
      status: 'LOST',
      lostReason: 'gone',
    });
    expect((await stageOf(a.id)).code).toBe('LOST');
    await board.status(w.as.OPERATOR, await conv(a.id), {
      status: 'IN_PROGRESS',
    });
    expect(await stageOf(a.id)).toMatchObject({ code: 'NEW' });
    expect((await stageOf(a.id)).lead.status).toBe('IN_PROGRESS');
    // A legacy pipeline without a WON stage: only the status changes.
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "pipelines" ("id","tenant_id","name","position")
      VALUES (gen_random_uuid(), ${w.tenantId}::uuid, 'Legacy', 5) RETURNING "id"`;
    const legacy = rows[0]!.id;
    await db.leadStage.create({
      data: {
        tenantId: w.tenantId,
        pipelineId: legacy,
        code: 'HOT',
        position: 0,
      },
    });
    const b = await seedLead(w, legacy, 'HOT');
    await board.status(w.as.OPERATOR, await conv(b.id), { status: 'WON' });
    expect(await stageOf(b.id)).toMatchObject({ code: 'HOT' });
    expect((await stageOf(b.id)).lead.status).toBe('WON');
  });

  it('the score route keeps working (deprecated, API compatibility)', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const lead = await seedLead(w, def.id, 'NEW');
    const conversationId = (await stageOf(lead.id)).lead.conversationId;
    expect(
      await board.score(w.as.OPERATOR, conversationId, { score: 'HOT' }),
    ).toEqual({
      score: 'HOT',
    });
    expect((await stageOf(lead.id)).lead.scoreSetByOperator).toBe(true);
  });
});

describe('stage rules', () => {
  it('a pipeline keeps one OPEN stage (delete and kind patch); kind of a stage with leads is fixed', async () => {
    const w = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const stages = await leadsApi.stages(w.as.OWNER, { pipelineId: sup.id });
    const open = stages.filter((s) => s.kind === 'OPEN');
    for (const stage of open.slice(0, -1))
      await leadsApi.deleteStage(w.as.OWNER, stage.id);
    const last = open[open.length - 1]!;
    expect(await fail(leadsApi.deleteStage(w.as.OWNER, last.id))).toMatchObject(
      {
        status: 409,
        code: 'STAGE_LAST_OPEN',
      },
    );
    expect(
      await fail(leadsApi.renameStage(w.as.OWNER, last.id, { kind: 'WON' })),
    ).toMatchObject({ status: 409, code: 'STAGE_LAST_OPEN' });
    const extra = await leadsApi.createStage(w.as.ADMIN, {
      name: 'Extra',
      pipelineId: sup.id,
    });
    expect(extra.kind).toBe('OPEN');
    expect(
      (await leadsApi.renameStage(w.as.ADMIN, last.id, { kind: 'WON' })).kind,
    ).toBe('WON');
    await seedLead(w, sup.id, 'WON').catch(() => undefined);
    const lead = await db.lead.create({
      data: {
        tenantId: w.tenantId,
        contactId: w.contactId,
        conversationId: w.conversationId,
        pipelineId: sup.id,
        pipelineStageId: extra.id,
        summary: 's',
        crmSyncStatus: 'NOT_REQUIRED',
        idempotencyKey: unique('lead'),
      },
    });
    expect(lead.id).toBeTruthy();
    expect(
      await fail(leadsApi.renameStage(w.as.ADMIN, extra.id, { kind: 'LOST' })),
    ).toMatchObject({ status: 409, code: 'STAGE_HAS_LEADS' });
    for (const role of ['OPERATOR', 'VIEWER'] as Role[])
      expect(
        (
          await fail(
            leadsApi.renameStage(w.as[role], extra.id, { kind: 'WON' }),
          )
        ).status,
      ).toBe(403);
  });

  it('coded stages of the default pipeline stay protected', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    expect(
      await fail(
        leadsApi.deleteStage(w.as.OWNER, await stageId(w, def.id, 'WON')),
      ),
    ).toMatchObject({ status: 409, code: 'STAGE_IS_DEFAULT' });
  });

  it('deleting a stage clears suggestions that point at it', async () => {
    const w = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    const extra = await leadsApi.createStage(w.as.OWNER, {
      name: 'X',
      pipelineId: sup.id,
    });
    const lead = await seedLead(w, sup.id, 'NEW', {
      suggestedStageId: extra.id,
    });
    await leadsApi.deleteStage(w.as.OWNER, extra.id);
    expect(
      (await db.lead.findFirstOrThrow({ where: { id: lead.id } }))
        .suggestedStageId,
    ).toBeNull();
  });
});

describe('agent staging matrix', () => {
  it('AUTO moves forward only, with the agent as actor and reason codes', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const first = await rescore(w);
    expect(first?.created).toBe(true);
    const id = first!.leadId;
    expect((await stageOf(id)).code).toBe('NEW');
    await say(w, 'CUSTOMER', 'hi');
    await say(w, 'CUSTOMER', 'I want a booking');
    await rescore(w);
    expect((await stageOf(id)).code).toBe('CONTACTED');
    await db.contact.updateMany({
      where: { tenantId: w.tenantId, id: w.contactId },
      data: { phone: '+998901234567' },
    });
    await rescore(w, { city: { value: 'Rome' } });
    const qualified = await stageOf(id);
    expect(qualified.code).toBe('QUALIFIED');
    expect(qualified.lead.stageSetBy).toBe('AGENT');
    // Fewer signals later never move the lead backwards.
    await rescore(w, {});
    expect((await stageOf(id)).code).toBe('QUALIFIED');
    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, entityId: id, action: 'lead.stage.moved' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).toMatchObject({ actorType: 'SYSTEM', actorId: null });
    expect(event.safeInputSummary).toMatchObject({
      actor: 'AGENT',
      to: await stageId(w, def.id, 'QUALIFIED'),
      reasonCodes: 'requirements_filled,phone_collected',
    });
    expect(JSON.stringify(event.safeInputSummary)).not.toContain('Rome');
  });

  it('an operator move locks the stage; hand-back lets the agent move it again', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const id = (await rescore(w))!.leadId;
    await leadsApi.move(w.as.OPERATOR, id, {
      stageId: await stageId(w, def.id, 'NEW'),
    });
    // The same stage is a no-op and does not lock; move away and back to lock.
    await leadsApi.move(w.as.OPERATOR, id, {
      stageId: await stageId(w, def.id, 'PROPOSAL'),
    });
    await leadsApi.move(w.as.OPERATOR, id, {
      stageId: await stageId(w, def.id, 'NEW'),
    });
    expect((await stageOf(id)).lead.stageSetBy).toBe('OPERATOR');
    await say(w, 'CUSTOMER', 'a');
    await say(w, 'CUSTOMER', 'b');
    await rescore(w);
    expect((await stageOf(id)).code).toBe('NEW');
    for (const role of ['OWNER', 'ADMIN', 'OPERATOR'] as Role[]) {
      expect(await leadsApi.handBackToAi(w.as[role], id)).toEqual({
        id,
        stageSetBy: 'AGENT',
      });
    }
    await rescore(w);
    expect((await stageOf(id)).code).toBe('CONTACTED');
    expect((await fail(leadsApi.handBackToAi(w.as.VIEWER, id))).status).toBe(
      403,
    );
    const other = await world();
    expect((await fail(leadsApi.handBackToAi(other.as.OWNER, id))).status).toBe(
      404,
    );
  });

  it('SUGGEST stores the proposal only; accept moves as the operator, dismiss clears', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    await pipelines.update(w.as.OWNER, def.id, { aiStaging: 'SUGGEST' });
    const id = (await rescore(w))!.leadId;
    await say(w, 'CUSTOMER', 'a');
    await say(w, 'CUSTOMER', 'b');
    await rescore(w);
    const contacted = await stageId(w, def.id, 'CONTACTED');
    expect(await stageOf(id)).toMatchObject({ code: 'NEW' });
    expect((await stageOf(id)).lead).toMatchObject({
      suggestedStageId: contacted,
      suggestedReasonCodes: ['customer_replied'],
      stageSetBy: 'AGENT',
    });
    const items = (await leadsApi.list(w.as.OWNER, {})).items;
    expect(items[0]).toMatchObject({
      stageSetBy: 'AGENT',
      suggestedStageId: contacted,
      suggestedReasonCodes: ['customer_replied'],
    });
    expect(
      (await fail(leadsApi.acceptSuggestion(w.as.VIEWER, id))).status,
    ).toBe(403);
    expect(await leadsApi.acceptSuggestion(w.as.OPERATOR, id)).toMatchObject({
      pipelineStageId: contacted,
    });
    expect((await stageOf(id)).lead).toMatchObject({
      stageSetBy: 'OPERATOR',
      suggestedStageId: null,
      suggestedReasonCodes: [],
    });
    // Nothing to accept now; dismiss of a pending suggestion clears it.
    expect(
      (await fail(leadsApi.acceptSuggestion(w.as.OPERATOR, id))).status,
    ).toBe(404);
    await leadsApi.handBackToAi(w.as.OPERATOR, id);
    await db.contact.updateMany({
      where: { tenantId: w.tenantId, id: w.contactId },
      data: { phone: '+998901234568' },
    });
    await rescore(w, { city: { value: 'Rome' } });
    expect((await stageOf(id)).lead.suggestedStageId).toBe(
      await stageId(w, def.id, 'QUALIFIED'),
    );
    expect(await leadsApi.dismissSuggestion(w.as.ADMIN, id)).toEqual({
      id,
      suggestedStageId: null,
    });
    expect((await stageOf(id)).lead.suggestedStageId).toBeNull();
    expect(
      (await fail(leadsApi.dismissSuggestion(w.as.VIEWER, id))).status,
    ).toBe(403);
    const other = await world();
    expect(
      (await fail(leadsApi.dismissSuggestion(other.as.OWNER, id))).status,
    ).toBe(404);
    expect(
      (await fail(leadsApi.acceptSuggestion(other.as.OWNER, id))).status,
    ).toBe(404);
  });

  it('OFF does nothing', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    await pipelines.update(w.as.OWNER, def.id, { aiStaging: 'OFF' });
    const id = (await rescore(w))!.leadId;
    await say(w, 'CUSTOMER', 'a');
    await say(w, 'CUSTOMER', 'b');
    await rescore(w);
    expect((await stageOf(id)).lead).toMatchObject({
      suggestedStageId: null,
      stageSetBy: 'AGENT',
    });
    expect((await stageOf(id)).code).toBe('NEW');
  });

  it('never moves a lead sitting in WON or LOST', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const id = (await rescore(w))!.leadId;
    await db.lead.updateMany({
      where: { tenantId: w.tenantId, id },
      data: {
        pipelineStageId: await stageId(w, def.id, 'WON'),
        status: 'WON',
      },
    });
    await say(w, 'CUSTOMER', 'a');
    await say(w, 'CUSTOMER', 'b');
    await rescore(w);
    expect((await stageOf(id)).code).toBe('WON');
  });
});

describe('GET /pipelines/:id/board', () => {
  it('counts per stage and sums per currency exactly, in SQL', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    const mk = (
      stage: string,
      amount: string | null,
      currency: string | null,
      extra = {},
    ) =>
      seedLead(w, def.id, stage, {
        amount: amount === null ? null : amount,
        currency,
        ...extra,
      });
    await mk('NEW', '0.10', 'USD');
    await mk('NEW', '0.20', 'USD');
    await mk('NEW', '5000', 'UZS');
    await mk('NEW', null, null);
    await mk('QUALIFIED', '1500.50', 'USD');
    for (const role of ROLES) {
      const { stages } = await pipelines.board(w.as[role], def.id);
      const byCode = Object.fromEntries(stages.map((s) => [s.code, s]));
      expect(stages.map((s) => s.code)).toEqual([
        'NEW',
        'CONTACTED',
        'QUALIFIED',
        'PROPOSAL',
        'NEGOTIATION',
        'WON',
        'LOST',
      ]);
      expect(byCode.NEW).toMatchObject({ count: 4, kind: 'OPEN', position: 0 });
      expect(byCode.NEW!.totals).toEqual(
        [
          { currency: 'UZS', amount: '5000.00' },
          { currency: 'USD', amount: '0.30' },
        ].sort((a, b) => a.currency.localeCompare(b.currency)),
      );
      expect(byCode.QUALIFIED!.totals).toEqual([
        { currency: 'USD', amount: '1500.50' },
      ]);
      expect(byCode.WON).toMatchObject({ count: 0, totals: [] });
    }
  });

  it('filters on lead creation date (inclusive days) and rejects bad queries', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    await seedLead(w, def.id, 'NEW', {
      createdAt: new Date('2026-01-10T12:00:00Z'),
    });
    await seedLead(w, def.id, 'NEW', {
      createdAt: new Date('2026-01-20T23:30:00Z'),
    });
    await seedLead(w, def.id, 'NEW', {
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const count = async (query: Record<string, string>) =>
      (await pipelines.board(w.as.VIEWER, def.id, query)).stages[0]!.count;
    expect(await count({})).toBe(3);
    expect(await count({ from: '2026-01-20' })).toBe(2);
    expect(await count({ from: '2026-01-11', to: '2026-01-20' })).toBe(1);
    expect(await count({ to: '2026-01-10' })).toBe(1);
    expect(
      (await fail(pipelines.board(w.as.VIEWER, def.id, { from: '2026-02-30' })))
        .status,
    ).toBe(400);
    expect(
      (await fail(pipelines.board(w.as.VIEWER, def.id, { x: '1' }))).status,
    ).toBe(400);
  });

  it('is 404 for another tenant or an archived pipeline and never mixes tenants', async () => {
    const w = await world();
    const other = await world();
    const sup = await pipelines.create(w.as.OWNER, { name: 'Support' });
    expect((await fail(pipelines.board(other.as.OWNER, sup.id))).status).toBe(
      404,
    );
    await seedLead(other, (await defaultPipeline(other)).id, 'NEW', {
      amount: '9.00',
      currency: 'USD',
    });
    const { stages } = await pipelines.board(w.as.OWNER, sup.id);
    expect(stages.every((s) => s.count === 0 && s.totals.length === 0)).toBe(
      true,
    );
    await pipelines.archive(w.as.OWNER, sup.id);
    expect((await fail(pipelines.board(w.as.OWNER, sup.id))).status).toBe(404);
  });

  it('the lead list already pages by stage and cursor', async () => {
    const w = await world();
    const def = await defaultPipeline(w);
    for (let i = 0; i < 3; i++) await seedLead(w, def.id, 'NEW');
    const stage = await stageId(w, def.id, 'NEW');
    const first = await leadsApi.list(w.as.VIEWER, {
      stageId: stage,
      limit: '2',
    });
    expect(first.items).toHaveLength(2);
    const second = await leadsApi.list(w.as.VIEWER, {
      stageId: stage,
      limit: '2',
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});
