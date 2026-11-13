/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { ManualLeadService } from '../leads/manual-lead.service.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PrismaChannelSecretStore } from '../secrets/channel-secret-store.js';
import { CustomFieldsService } from '../tags/custom-fields.service.js';
import { TagsService } from '../tags/tags.service.js';
import { ChannelsController } from './channels.controller.js';
import { InboxReadService } from './inbox-read.service.js';
import { LeadPipelineController } from './lead-pipeline.controller.js';
import { PipelinesController } from './pipelines.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Manual lead integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const leadsApi = new LeadPipelineController(
  prisma,
  new TagsService(prisma),
  new CustomFieldsService(prisma),
  new ManualLeadService(prisma),
);
const pipelines = new PipelinesController(prisma);
const inbox = new InboxReadService(prisma);
const channels = new ChannelsController(
  prisma,
  {
    get: (key: string) =>
      (
        ({
          NODE_ENV: 'development',
          LLM_PROVIDER: 'mock',
          LLM_TRUSTED_PROVIDERS: ['mock'],
          LLM_ALLOW_REAL_CUSTOMER_DATA: false,
        }) as Record<string, unknown>
      )[key],
  } as never,
  new PrismaChannelSecretStore(prisma, undefined),
);

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];

interface Req {
  principal: {
    tenantId: string;
    operatorId: string;
    role: Role;
    sessionId: string;
  };
}
interface World {
  tenantId: string;
  as: Record<Role, Req>;
}

async function world(): Promise<World> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('ml'),
      name: 'Manual lead fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
  const as = {} as Record<Role, Req>;
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
    };
  }
  return { tenantId: tenant.id, as };
}

const call = async (promise: Promise<unknown>) =>
  promise.then(
    () => ({ status: 200, code: undefined as unknown }),
    (error: {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    }) => ({ status: error.getStatus(), code: error.getResponse().code }),
  );

const create = (w: World, role: Role, body: unknown) =>
  leadsApi.createManually(w.as[role] as never, body);

describe('manual leads (ADR 061)', () => {
  it('creates account, contact, closed conversation and lead together, with defaults', async () => {
    const w = await world();
    const item = await create(w, 'OPERATOR', {
      name: '  Dilnoza  ',
      phone: '+998 90 123 45 67',
      note: 'Called the office',
    });
    expect(item.contact).toEqual({
      name: 'Dilnoza',
      phone: '+998901234567',
    });
    expect(item.conversation.channelType).toBe('manual');
    expect(item.conversation.state).toBe('CLOSED');
    expect(item.status).toBe('NEW');
    expect(item.source).toBe('manual');
    expect(item.summary).toBe('Called the office');
    expect(item.owner?.id).toBe(w.as.OPERATOR.principal.operatorId);
    expect(item.amount).toBeNull();

    const lead = await db.lead.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: item.id },
    });
    expect(lead.stageSetBy).toBe('OPERATOR');
    expect(lead.idempotencyKey).toMatch(/^manual:/u);
    const stage = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: lead.pipelineStageId! },
    });
    expect(stage.kind).toBe('OPEN');
    // The first open stage of the default pipeline.
    const firstOpen = await db.leadStage.findFirstOrThrow({
      where: {
        tenantId: w.tenantId,
        pipelineId: lead.pipelineId,
        kind: 'OPEN',
        archivedAt: null,
      },
      orderBy: { position: 'asc' },
    });
    expect(stage.id).toBe(firstOpen.id);

    const conversation = await db.conversation.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: item.conversation.id },
      include: { channelAccount: true },
    });
    expect(conversation.state).toBe('CLOSED');
    expect(conversation.channelAccount.channelType).toBe('manual');
    expect(conversation.channelAccount.status).toBe('DISABLED');
    expect(conversation.channelAccount.agentMode).toBe('OFF');
    expect(await db.message.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it('keeps one internal channel account per tenant', async () => {
    const w = await world();
    await create(w, 'OWNER', { name: 'One' });
    await create(w, 'ADMIN', { name: 'Two' });
    const accounts = await db.channelAccount.findMany({
      where: { tenantId: w.tenantId },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.externalAccountId).toBe(`manual:${w.tenantId}`);
  });

  it('links two leads with the same phone to one person', async () => {
    const w = await world();
    const a = await create(w, 'OWNER', {
      name: 'Aziz',
      phone: '+998901112233',
    });
    const b = await create(w, 'OWNER', {
      name: 'Aziz again',
      phone: '90 111 22 33',
    });
    const people = await db.contact.findMany({
      where: { tenantId: w.tenantId },
      select: { personId: true },
    });
    expect(people).toHaveLength(2);
    expect(people[0]!.personId).toBeTruthy();
    expect(people[0]!.personId).toBe(people[1]!.personId);
    expect(a.id).not.toBe(b.id);
    expect(await db.person.count({ where: { tenantId: w.tenantId } })).toBe(1);
  });

  it('creates a person per lead when there is no phone', async () => {
    const w = await world();
    await create(w, 'OWNER', { name: 'No phone one' });
    await create(w, 'OWNER', { name: 'No phone two' });
    expect(await db.person.count({ where: { tenantId: w.tenantId } })).toBe(2);
  });

  it('validates the body and values', async () => {
    const w = await world();
    const bad = async (body: unknown) => call(create(w, 'OWNER', body));
    expect(await bad({})).toEqual({ status: 400, code: 'INVALID_BODY' });
    expect(await bad({ name: 'X', extra: 1 })).toEqual({
      status: 400,
      code: 'INVALID_BODY',
    });
    expect(await bad({ name: 'X', phone: 'abc' })).toEqual({
      status: 400,
      code: 'INVALID_VALUE',
    });
    expect(await bad({ name: 'X', amount: '10' })).toEqual({
      status: 400,
      code: 'INVALID_VALUE',
    });
    expect(await bad({ name: 'X', amount: '1.234', currency: 'UZS' })).toEqual({
      status: 400,
      code: 'INVALID_VALUE',
    });
    expect(await bad({ name: 'X', amount: '10', currency: 'ZZZ' })).toEqual({
      status: 400,
      code: 'INVALID_VALUE',
    });
    // Nothing was created by the rejected requests.
    expect(await db.lead.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await db.contact.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it('takes amount, currency, source, owner and tags', async () => {
    const w = await world();
    const tag = await db.tag.create({
      data: { tenantId: w.tenantId, name: unique('vip'), color: 'blue' },
    });
    const item = await create(w, 'ADMIN', {
      name: 'Big deal',
      amount: '1500.50',
      currency: 'UZS',
      source: ' Referral ',
      ownerOperatorId: w.as.OPERATOR.principal.operatorId,
      tagIds: [tag.id, tag.id],
    });
    expect(item.amount).toBe('1500.50');
    expect(item.currency).toBe('UZS');
    expect(item.source).toBe('Referral');
    expect(item.owner?.id).toBe(w.as.OPERATOR.principal.operatorId);
    expect(item.tags.map((t) => t.id)).toEqual([tag.id]);
  });

  it('rejects unknown owners, inactive owners, unknown tags', async () => {
    const w = await world();
    const other = await world();
    const inactive = await db.operator.create({
      data: {
        tenantId: w.tenantId,
        displayName: 'Gone',
        role: 'OPERATOR',
        isActive: false,
      },
    });
    for (const ownerOperatorId of [
      randomUUID(),
      other.as.OWNER.principal.operatorId,
      inactive.id,
    ]) {
      expect(
        await call(create(w, 'OWNER', { name: 'X', ownerOperatorId })),
      ).toEqual({ status: 400, code: 'UNKNOWN_OPERATOR' });
    }
    expect(
      await call(create(w, 'OWNER', { name: 'X', tagIds: [randomUUID()] })),
    ).toEqual({
      status: 400,
      code: 'UNKNOWN_TAG',
    });
    expect(await db.contact.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it('checks stage and pipeline: closed stages, mismatches, other tenants', async () => {
    const w = await world();
    const other = await world();
    const first = await create(w, 'OWNER', { name: 'Seed' });
    const stages = await db.leadStage.findMany({
      where: { tenantId: w.tenantId },
      orderBy: { position: 'asc' },
    });
    const won = stages.find((s) => s.kind === 'WON')!;
    const lost = stages.find((s) => s.kind === 'LOST')!;
    const open = stages.filter((s) => s.kind === 'OPEN');
    const last = open[open.length - 1]!;

    for (const closed of [won, lost]) {
      expect(
        await call(create(w, 'OWNER', { name: 'X', stageId: closed.id })),
      ).toEqual({
        status: 400,
        code: 'STAGE_NOT_OPEN',
      });
    }
    // A named open stage is used, and the pipeline may be named alongside it.
    const placed = await create(w, 'OWNER', {
      name: 'Placed',
      stageId: last.id,
      pipelineId: last.pipelineId,
    });
    expect(placed.pipelineStageId).toBe(last.id);

    const support = await pipelines.create(w.as.OWNER as never, {
      name: 'Support',
    });
    expect(
      await call(
        create(w, 'OWNER', {
          name: 'X',
          stageId: last.id,
          pipelineId: support.id,
        }),
      ),
    ).toEqual({ status: 400, code: 'INVALID_VALUE' });
    // Naming only another pipeline picks its first open stage.
    const inSupport = await create(w, 'OWNER', {
      name: 'In support',
      pipelineId: support.id,
    });
    expect(inSupport.pipelineId).toBe(support.id);

    expect(
      await call(create(w, 'OWNER', { name: 'X', stageId: randomUUID() })),
    ).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(
      await call(create(w, 'OWNER', { name: 'X', pipelineId: randomUUID() })),
    ).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    const foreign = await db.leadStage
      .findFirstOrThrow({
        where: { tenantId: other.tenantId },
      })
      .catch(async () => {
        await create(other, 'OWNER', { name: 'Seed' });
        return db.leadStage.findFirstOrThrow({
          where: { tenantId: other.tenantId },
        });
      });
    expect(
      await call(create(w, 'OWNER', { name: 'X', stageId: foreign.id })),
    ).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(first.id).toBeTruthy();
  });

  it('allows owner, admin and operator; a viewer gets 403', async () => {
    const w = await world();
    for (const role of ['OWNER', 'ADMIN', 'OPERATOR'] as Role[]) {
      expect((await call(create(w, role, { name: role }))).status).toBe(200);
    }
    expect(await call(create(w, 'VIEWER', { name: 'No' }))).toMatchObject({
      status: 403,
    });
    expect(await db.lead.count({ where: { tenantId: w.tenantId } })).toBe(3);
  });

  it('shows up in the lead list and the board counts, and audits ids only', async () => {
    const w = await world();
    const item = await create(w, 'OPERATOR', {
      name: 'Secret Name',
      phone: '+998907776655',
      note: 'private note',
    });
    const listed = await leadsApi.list(w.as.OWNER as never, {});
    expect(listed.items.map((i) => i.id)).toContain(item.id);
    const pipeline = await db.pipeline.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    const { stages } = await pipelines.board(w.as.OWNER as never, pipeline.id);
    expect(stages.find((s) => s.id === item.pipelineStageId)!.count).toBe(1);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'lead.created_manually' },
    });
    expect(audit.entityId).toBe(item.id);
    const dump = JSON.stringify(audit);
    expect(dump).not.toContain('Secret Name');
    expect(dump).not.toContain('998907776655');
    expect(dump).not.toContain('private note');
  });

  it('keeps the manual account and conversation out of the inbox and the channel list', async () => {
    const w = await world();
    await create(w, 'OWNER', { name: 'Hidden' });
    for (const scope of ['all', 'closed', 'waiting', 'mine'] as const) {
      const { items } = await inbox.list(w.as.OWNER.principal as never, {
        scope,
      });
      expect(items).toHaveLength(0);
    }
    const list = await channels.list(w.as.OWNER as never);
    expect(list.items).toHaveLength(0);
  });

  it('never lets the agent restage it (operator lock)', async () => {
    const w = await world();
    const item = await create(w, 'OWNER', { name: 'Locked' });
    const lead = await db.lead.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: item.id },
      select: { stageSetBy: true },
    });
    expect(lead.stageSetBy).toBe('OPERATOR');
  });
});
