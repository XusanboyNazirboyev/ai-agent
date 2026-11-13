/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { LeadArchiveService } from '../leads/lead-archive.service.js';
import { ManualLeadService } from '../leads/manual-lead.service.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { CustomFieldsService } from '../tags/custom-fields.service.js';
import { TagsService } from '../tags/tags.service.js';
import { LeadPipelineController } from './lead-pipeline.controller.js';
import { ExportService } from '../exports/export.service.js';
import { PeopleService } from '../persons/people.service.js';
import { InboxReadService } from './inbox-read.service.js';
import { PipelinesController } from './pipelines.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Lead archive integration tests require agentcore_test');
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
  new LeadArchiveService(prisma),
);
const pipelines = new PipelinesController(prisma);

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
      slug: unique('la'),
      name: 'Archive fixture',
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

const asReq = (w: World, role: Role) => w.as[role] as never;
const addManual = (w: World, name: string, extra: object = {}) =>
  leadsApi.createManually(asReq(w, 'OWNER'), { name, ...extra });
const archive = (w: World, role: Role, id: string) =>
  leadsApi.archive(asReq(w, role), id);
const restore = (w: World, role: Role, id: string) =>
  leadsApi.restore(asReq(w, role), id);
const remove = (w: World, role: Role, id: string) =>
  leadsApi.deleteForGood(asReq(w, role), id);
const listIds = async (w: World, query: object = {}) =>
  (await leadsApi.list(asReq(w, 'OWNER'), query)).items.map((i) => i.id);

/** A lead made like the agent makes it: a real (telegram) conversation. */
async function agentLead(w: World) {
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
      name: 'Agent customer',
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
      summary: 'wants a course',
      idempotencyKey: unique('agent'),
    },
  });
  return { lead, contact, conversation };
}

describe('archiving a lead (ADR 062)', () => {
  it('hides an archived lead from the list and the board counts, and shows it in the archive', async () => {
    const w = await world();
    const a = await addManual(w, 'Keep');
    const b = await addManual(w, 'Archive me');
    const pipeline = await db.pipeline.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    const count = async () =>
      (await pipelines.board(asReq(w, 'OWNER'), pipeline.id)).stages.reduce(
        (sum, s) => sum + s.count,
        0,
      );
    expect(await count()).toBe(2);

    await archive(w, 'ADMIN', b.id);
    expect(await listIds(w)).toEqual([a.id]);
    expect(await count()).toBe(1);
    const listed = await pipelines.list(asReq(w, 'OWNER'));
    expect(listed.items.find((p) => p.id === pipeline.id)!.leadCount).toBe(1);

    const archived = await leadsApi.list(asReq(w, 'OWNER'), {
      archived: 'true',
    });
    expect(archived.items.map((i) => i.id)).toEqual([b.id]);
    expect(archived.items[0]!.archivedAt).not.toBeNull();
    expect(await listIds(w, { archived: 'false' })).toEqual([a.id]);
  });

  it('archives and restores idempotently, and writes ids-only audit rows', async () => {
    const w = await world();
    const lead = await addManual(w, 'Secret Person', {
      phone: '+998901112233',
      note: 'private',
    });
    await archive(w, 'OWNER', lead.id);
    await archive(w, 'OWNER', lead.id);
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, action: 'lead.archived' },
      }),
    ).toBe(1);
    await restore(w, 'ADMIN', lead.id);
    await restore(w, 'ADMIN', lead.id);
    expect(await listIds(w)).toEqual([lead.id]);
    const rows = await db.auditEvent.findMany({
      where: {
        tenantId: w.tenantId,
        action: { in: ['lead.archived', 'lead.restored'] },
      },
    });
    expect(rows.map((r) => r.action).sort()).toEqual([
      'lead.archived',
      'lead.restored',
    ]);
    const dump = JSON.stringify(rows);
    for (const secret of ['Secret Person', '998901112233', 'private'])
      expect(dump).not.toContain(secret);
  });

  it('allows only OWNER and ADMIN to archive, restore and list the archive; only OWNER deletes', async () => {
    const w = await world();
    const lead = await addManual(w, 'Roles');
    for (const role of ['OPERATOR', 'VIEWER'] as Role[]) {
      expect(await call(archive(w, role, lead.id))).toMatchObject({
        status: 403,
      });
      expect(await call(restore(w, role, lead.id))).toMatchObject({
        status: 403,
      });
      expect(
        await call(leadsApi.list(asReq(w, role), { archived: 'true' })),
      ).toMatchObject({ status: 403 });
    }
    await archive(w, 'ADMIN', lead.id);
    for (const role of ['ADMIN', 'OPERATOR', 'VIEWER'] as Role[])
      expect(await call(remove(w, role, lead.id))).toMatchObject({
        status: 403,
      });
    expect((await call(remove(w, 'OWNER', lead.id))).status).toBe(200);
  });

  it('answers 404 for unknown and other-tenant leads', async () => {
    const w = await world();
    const other = await world();
    const foreign = await addManual(other, 'Foreign');
    for (const id of [randomUUID(), foreign.id]) {
      expect((await call(archive(w, 'OWNER', id))).status).toBe(404);
      expect((await call(restore(w, 'OWNER', id))).status).toBe(404);
      expect((await call(remove(w, 'OWNER', id))).status).toBe(404);
    }
    expect(await listIds(other)).toEqual([foreign.id]);
  });

  it('freezes an archived lead for operators (409 LEAD_ARCHIVED) until it is restored', async () => {
    const w = await world();
    const lead = await addManual(w, 'Frozen');
    const stage = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, kind: 'OPEN' },
      orderBy: { position: 'desc' },
    });
    await archive(w, 'OWNER', lead.id);
    const frozen = { status: 409, code: 'LEAD_ARCHIVED' };
    expect(
      await call(
        leadsApi.move(asReq(w, 'OWNER'), lead.id, { stageId: stage.id }),
      ),
    ).toEqual(frozen);
    expect(
      await call(
        leadsApi.opportunity(asReq(w, 'OWNER'), lead.id, { source: 'x' }),
      ),
    ).toEqual(frozen);
    expect(
      await call(leadsApi.setTags(asReq(w, 'OWNER'), lead.id, { tagIds: [] })),
    ).toEqual(frozen);
    expect(
      await call(leadsApi.handBackToAi(asReq(w, 'OWNER'), lead.id)),
    ).toEqual(frozen);
    await restore(w, 'OWNER', lead.id);
    expect(
      (
        await call(
          leadsApi.move(asReq(w, 'OWNER'), lead.id, { stageId: stage.id }),
        )
      ).status,
    ).toBe(200);
  });

  it('deletes only an archived lead, with its tags, and keeps the conversation of an agent lead', async () => {
    const w = await world();
    const { lead, contact, conversation } = await agentLead(w);
    const tag = await db.tag.create({
      data: { tenantId: w.tenantId, name: unique('t'), color: 'blue' },
    });
    await db.leadTag.create({
      data: { tenantId: w.tenantId, leadId: lead.id, tagId: tag.id },
    });

    expect(await call(remove(w, 'OWNER', lead.id))).toEqual({
      status: 409,
      code: 'LEAD_NOT_ARCHIVED',
    });
    await archive(w, 'OWNER', lead.id);
    await remove(w, 'OWNER', lead.id);

    expect(await db.lead.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await db.leadTag.count({ where: { tenantId: w.tenantId } })).toBe(0);
    // The customer's history and the tag itself stay.
    expect(
      await db.conversation.count({ where: { id: conversation.id } }),
    ).toBe(1);
    const kept = await db.contact.findFirstOrThrow({
      where: { id: contact.id },
    });
    expect(kept.name).toBe('Agent customer');
    expect(kept.deletedAt).toBeNull();
    expect(await db.tag.count({ where: { id: tag.id } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'lead.deleted' },
    });
    expect(audit.entityId).toBe(lead.id);
  });

  it('erases the contact of a manual lead when it is deleted for good', async () => {
    const w = await world();
    const lead = await addManual(w, 'Erase Me', { phone: '+998905556677' });
    const row = await db.lead.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: lead.id },
    });
    await archive(w, 'OWNER', lead.id);
    await remove(w, 'OWNER', lead.id);
    const contact = await db.contact.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: row.contactId },
    });
    expect(contact.deletedAt).not.toBeNull();
    expect(contact.name).not.toBe('Erase Me');
    expect(contact.phone).toBeNull();
    expect(await db.lead.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it('still counts archived leads in the stage delete guard', async () => {
    const w = await world();
    const lead = await addManual(w, 'Blocks the stage');
    const row = await db.lead.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: lead.id },
    });
    const support = await pipelines.create(asReq(w, 'OWNER'), {
      name: 'Support',
    });
    const stages = await db.leadStage.findMany({
      where: { tenantId: w.tenantId, pipelineId: support.id, kind: 'OPEN' },
      orderBy: { position: 'asc' },
    });
    await leadsApi.move(asReq(w, 'OWNER'), lead.id, { stageId: stages[1]!.id });
    await archive(w, 'OWNER', lead.id);
    expect(
      await call(leadsApi.deleteStage(asReq(w, 'OWNER'), stages[1]!.id)),
    ).toEqual({ status: 409, code: 'STAGE_HAS_LEADS' });
    expect(row.id).toBe(lead.id);
  });
  it('leaves archived leads out of the export, the person card counts and the inbox lead filter', async () => {
    const w = await world();
    const people = new PeopleService(prisma);
    const exportService = new ExportService(prisma, people);
    const inbox = new InboxReadService(prisma);

    const manual = await addManual(w, 'Counted', { phone: '+998907770011' });
    const row = await db.lead.findFirstOrThrow({
      where: { tenantId: w.tenantId, id: manual.id },
      select: { contact: { select: { personId: true } } },
    });
    const personId = row.contact.personId!;
    const { lead, conversation } = await agentLead(w);
    const inboxIds = async () =>
      (
        await inbox.list(w.as.OWNER.principal as never, {
          scope: 'all',
          leadScore: 'COLD',
        })
      ).items.map((i) => i.id);

    expect(await exportService.countLeads(w.tenantId, {})).toBe(2);
    expect(
      (await people.itemsByIds(w.tenantId, [personId]))[0]!.leadCount,
    ).toBe(1);
    expect(await inboxIds()).toContain(conversation.id);

    await archive(w, 'OWNER', manual.id);
    await archive(w, 'OWNER', lead.id);

    expect(await exportService.countLeads(w.tenantId, {})).toBe(0);
    expect(
      (await people.itemsByIds(w.tenantId, [personId]))[0]!.leadCount,
    ).toBe(0);
    expect(await inboxIds()).not.toContain(conversation.id);

    await restore(w, 'OWNER', lead.id);
    expect(await exportService.countLeads(w.tenantId, {})).toBe(1);
    expect(await inboxIds()).toContain(conversation.id);
  });
});
