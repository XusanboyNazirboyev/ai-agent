/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LeadArchiveService } from '../leads/lead-archive.service.js';
import { ensureLeadStages } from '../leads/lead-stage.util.js';
import { ManualLeadService } from '../leads/manual-lead.service.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { CustomFieldsService } from '../tags/custom-fields.service.js';
import { TagsService } from '../tags/tags.service.js';
import { LeadPipelineController } from '../webinbox/lead-pipeline.controller.js';
import { PipelinesController } from '../webinbox/pipelines.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Lead search integration tests require agentcore_test');
}
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const pipelines = tenantScoped(new PipelinesController(prisma));
const leadsApi = tenantScoped(
  new LeadPipelineController(
    prisma,
    new TagsService(prisma),
    new CustomFieldsService(prisma),
    new ManualLeadService(prisma),
    new LeadArchiveService(prisma),
  ),
);

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];

interface World {
  tenantId: string;
  as: Record<Role, never>;
  operatorIds: Record<Role, string>;
  pipelineId: string;
  stages: Array<{ id: string; kind: string; code: string | null }>;
}

async function world(): Promise<World> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('ls'),
      name: 'Lead search fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
  const as = {} as Record<Role, never>;
  const operatorIds = {} as Record<Role, string>;
  for (const role of ROLES) {
    const op = await db.operator.create({
      data: { tenantId: tenant.id, displayName: `Op ${role}`, role },
    });
    operatorIds[role] = op.id;
    as[role] = {
      principal: {
        tenantId: tenant.id,
        operatorId: op.id,
        role,
        sessionId: randomUUID(),
      },
    } as never;
  }
  await db.$transaction((tx) => ensureLeadStages(tx, tenant.id));
  const pipeline = await db.pipeline.findFirstOrThrow({
    where: { tenantId: tenant.id, isDefault: true },
  });
  const stages = await db.leadStage.findMany({
    where: { tenantId: tenant.id, pipelineId: pipeline.id },
    orderBy: { position: 'asc' },
    select: { id: true, kind: true, code: true },
  });
  return {
    tenantId: tenant.id,
    as,
    operatorIds,
    pipelineId: pipeline.id,
    stages,
  };
}

const add = (w: World, body: Record<string, unknown>) =>
  leadsApi.createManually(w.as.OWNER, body) as Promise<{ id: string }>;

const list = (w: World, query: Record<string, string> = {}) =>
  leadsApi
    .list(w.as.OWNER, query)
    .then((page) => page.items.map((item) => item.contact.name).sort());

const boardCount = async (w: World, query: Record<string, string> = {}) =>
  (await pipelines.board(w.as.OWNER, w.pipelineId, query)).stages.reduce(
    (sum, stage) => sum + stage.count,
    0,
  );

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

/** A lead that came in on Telegram (not added by hand). */
async function telegramLead(w: World, name: string): Promise<string> {
  const account = await db.channelAccount.create({
    data: {
      tenantId: w.tenantId,
      channelType: 'telegram',
      externalAccountId: unique('tg'),
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: w.tenantId,
      channelAccountId: account.id,
      providerUserId: unique('u'),
      name,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: w.tenantId,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: unique('chat'),
      state: 'BOT_ACTIVE',
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: w.tenantId,
      contactId: contact.id,
      conversationId: conversation.id,
      pipelineId: w.pipelineId,
      pipelineStageId: w.stages[0].id,
      summary: '',
      idempotencyKey: unique('lead'),
      score: 'HOT',
    },
  });
  return lead.id;
}

describe('lead search and filters (ADR 076)', () => {
  it('finds a lead by part of the name or 3+ digits of the phone, list and board alike', async () => {
    const w = await world();
    await add(w, { name: 'Shuxratbek Aliyev', phone: '+998979887020' });
    await add(w, { name: 'Mohinur Safarova', phone: '+998331882929' });
    await add(w, { name: 'Dilshod', phone: '+998992380555' });

    expect(await list(w, { q: 'shuxrat' })).toEqual(['Shuxratbek Aliyev']);
    expect(await list(w, { q: '97 988' })).toEqual(['Shuxratbek Aliyev']);
    expect(await list(w, { q: '+998 33 188' })).toEqual(['Mohinur Safarova']);
    // Two digits are too few to search the phone; nobody is named "55".
    expect(await list(w, { q: '55' })).toEqual([]);
    expect(await boardCount(w, { q: 'shuxrat' })).toBe(1);
    expect(await boardCount(w)).toBe(3);
  });

  it('filters by channel, score, unassigned owner and tasks; board counts follow', async () => {
    const w = await world();
    const manual = await add(w, {
      name: 'By hand',
      ownerOperatorId: w.operatorIds.OPERATOR,
    });
    await telegramLead(w, 'From Telegram');
    await db.leadTask.create({
      data: {
        tenantId: w.tenantId,
        leadId: manual.id,
        title: 'Call back',
        dueAt: new Date(Date.now() - 3_600_000),
      },
    });

    expect(await list(w, { channel: 'telegram' })).toEqual(['From Telegram']);
    expect(await list(w, { score: 'HOT' })).toEqual(['From Telegram']);
    expect(await list(w, { ownerOperatorId: 'none' })).toEqual([
      'From Telegram',
    ]);
    expect(await list(w, { ownerOperatorId: w.operatorIds.OPERATOR })).toEqual([
      'By hand',
    ]);
    expect(await list(w, { task: 'overdue' })).toEqual(['By hand']);
    expect(await list(w, { task: 'none' })).toEqual(['From Telegram']);
    expect(await boardCount(w, { channel: 'telegram' })).toBe(1);
    expect(await boardCount(w, { task: 'overdue' })).toBe(1);
    expect(
      await fail(pipelines.board(w.as.OWNER, w.pipelineId, { bogus: '1' })),
    ).toMatchObject({ status: 400 });
  });

  it("never returns another tenant's lead for a matching search", async () => {
    const mine = await world();
    const other = await world();
    await add(other, { name: 'Shared Name', phone: '+998901112233' });
    expect(await list(mine, { q: 'Shared' })).toEqual([]);
    expect(await list(mine, { q: '1112233' })).toEqual([]);
  });
});

describe('bulk lead actions (ADR 076)', () => {
  it('assigns many leads to one owner (OWNER, ADMIN only) and audits each', async () => {
    const w = await world();
    const a = await add(w, { name: 'A' });
    const b = await add(w, { name: 'B' });
    const result = await leadsApi.bulk(w.as.ADMIN, {
      action: 'assign',
      leadIds: [a.id, b.id, a.id],
      ownerOperatorId: w.operatorIds.OPERATOR,
    });
    expect(result).toEqual({ updated: 2, failed: [] });
    const owners = await db.lead.findMany({
      where: { tenantId: w.tenantId, id: { in: [a.id, b.id] } },
      select: { ownerOperatorId: true },
    });
    expect(owners.map((o) => o.ownerOperatorId)).toEqual([
      w.operatorIds.OPERATOR,
      w.operatorIds.OPERATOR,
    ]);
    const audits = await db.auditEvent.count({
      where: {
        tenantId: w.tenantId,
        action: 'lead.opportunity.updated',
        entityId: { in: [a.id, b.id] },
      },
    });
    expect(audits).toBe(2);
    // Unassign works too.
    expect(
      await leadsApi.bulk(w.as.OWNER, {
        action: 'assign',
        leadIds: [a.id],
        ownerOperatorId: null,
      }),
    ).toEqual({ updated: 1, failed: [] });
    expect(
      await fail(
        leadsApi.bulk(w.as.OPERATOR, {
          action: 'assign',
          leadIds: [a.id],
          ownerOperatorId: w.operatorIds.OPERATOR,
        }),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await fail(
        leadsApi.bulk(w.as.VIEWER, {
          action: 'move',
          leadIds: [a.id],
          stageId: w.stages[1].id,
        }),
      ),
    ).toMatchObject({ status: 403 });
  });

  it('moves leads to a stage of another pipeline and reports leads it could not move', async () => {
    const w = await world();
    const a = await add(w, { name: 'A' });
    const b = await add(w, { name: 'B' });
    const archived = await add(w, { name: 'Archived' });
    await leadsApi.archive(w.as.OWNER, archived.id);
    const second = await pipelines.create(w.as.OWNER, { name: 'Second' });
    const target = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, pipelineId: second.id, kind: 'OPEN' },
      orderBy: { position: 'asc' },
    });

    const result = await leadsApi.bulk(w.as.OPERATOR, {
      action: 'move',
      leadIds: [a.id, b.id, archived.id, randomUUID()],
      stageId: target.id,
    });
    expect(result.updated).toBe(2);
    expect(result.failed.map((f) => f.code)).toEqual([
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
    const moved = await db.lead.findMany({
      where: { tenantId: w.tenantId, id: { in: [a.id, b.id] } },
      select: { pipelineId: true, pipelineStageId: true },
    });
    expect(moved).toEqual([
      { pipelineId: second.id, pipelineStageId: target.id },
      { pipelineId: second.id, pipelineStageId: target.id },
    ]);

    // A LOST stage needs a reason: without one every lead is reported.
    const lost = w.stages.find((s) => s.kind === 'LOST')!;
    const noReason = await leadsApi.bulk(w.as.OPERATOR, {
      action: 'move',
      leadIds: [a.id],
      stageId: lost.id,
    });
    expect(noReason.updated).toBe(0);
    expect(noReason.failed).toHaveLength(1);
    expect(
      await leadsApi.bulk(w.as.OPERATOR, {
        action: 'move',
        leadIds: [a.id],
        stageId: lost.id,
        lostReason: 'Too expensive',
      }),
    ).toEqual({ updated: 1, failed: [] });

    expect(
      await fail(
        leadsApi.bulk(w.as.OPERATOR, {
          action: 'move',
          leadIds: [a.id],
          stageId: randomUUID(),
        }),
      ),
    ).toMatchObject({ status: 404 });
    expect(
      await fail(
        leadsApi.bulk(w.as.OWNER, {
          action: 'move',
          leadIds: Array.from({ length: 101 }, () => randomUUID()),
          stageId: target.id,
        }),
      ),
    ).toMatchObject({ status: 400 });
  });

  it("cannot touch another tenant's leads or stages", async () => {
    const mine = await world();
    const other = await world();
    const theirs = await add(other, { name: 'Theirs' });
    expect(
      await leadsApi.bulk(mine.as.OWNER, {
        action: 'assign',
        leadIds: [theirs.id],
        ownerOperatorId: null,
      }),
    ).toEqual({ updated: 0, failed: [{ id: theirs.id, code: 'NOT_FOUND' }] });
    expect(
      await fail(
        leadsApi.bulk(mine.as.OWNER, {
          action: 'move',
          leadIds: [theirs.id],
          stageId: other.stages[1].id,
        }),
      ),
    ).toMatchObject({ status: 404 });
  });
});
