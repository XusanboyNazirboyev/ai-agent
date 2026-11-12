/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ContactErasureService } from '../retention/contact-erasure.service.js';
import { PeopleController } from '../webinbox/people.controller.js';
import {
  SESSION_COOKIE,
  SessionGuard,
  type InboxRequest,
} from '../webinbox/session.guard.js';
import {
  DEFAULT_SESSION_POLICY,
  SessionService,
} from '../webinbox/session.service.js';
import { PeopleService } from './people.service.js';
import { PersonErasureService } from './person-erasure.service.js';
import { PersonMergeService } from './person-merge.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Person merge integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const sessions = new SessionService(prisma, {
  ...DEFAULT_SESSION_POLICY,
  scrypt: { N: 1024, r: 8, p: 1 },
});
const guard = new SessionGuard(sessions, {
  get: () => ['http://localhost:3000'],
} as never);
const peopleService = new PeopleService(prisma);
const contactErasure = new ContactErasureService(prisma);
const controller = new PeopleController(
  peopleService,
  new PersonMergeService(prisma, peopleService),
  new PersonErasureService(prisma, contactErasure),
);

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

interface Fixture {
  tenantId: string;
  accountId: string;
  igAccountId: string;
  /** One signed-in request per role. */
  as: Record<Role, InboxRequest>;
  operatorId: string;
}

async function signIn(tenantId: string, role: Role) {
  const operator = await db.operator.create({
    data: { tenantId, displayName: `Op ${role}`, role },
  });
  const email = `${unique('op')}@example.test`;
  await sessions.setPassword(tenantId, operator.id, email, 'correct horse');
  const login = await sessions.login(email, 'correct horse');
  if (!login.ok) throw new Error('login failed');
  const request = {
    method: 'GET',
    headers: { cookie: `${SESSION_COOKIE}=${login.sessionToken}` },
  } as unknown as InboxRequest;
  await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext);
  return { request, operatorId: operator.id };
}

async function fixture(): Promise<Fixture> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('pm'),
      name: 'Merge fixture',
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
      displayName: '@bot',
      status: 'ACTIVE',
    },
  });
  const ig = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'instagram',
      externalAccountId: unique('ig'),
      status: 'ACTIVE',
    },
  });
  const owner = await signIn(tenant.id, 'OWNER');
  const admin = await signIn(tenant.id, 'ADMIN');
  const operator = await signIn(tenant.id, 'OPERATOR');
  const viewer = await signIn(tenant.id, 'VIEWER');
  return {
    tenantId: tenant.id,
    accountId: account.id,
    igAccountId: ig.id,
    operatorId: owner.operatorId,
    as: {
      OWNER: owner.request,
      ADMIN: admin.request,
      OPERATOR: operator.request,
      VIEWER: viewer.request,
    },
  };
}

interface ContactSpec {
  name?: string | null;
  phone?: string | null;
  ig?: boolean;
  deleted?: boolean;
}

async function person(
  f: Fixture,
  contacts: ContactSpec[],
  options: { displayName?: string | null; mergedInto?: string } = {},
) {
  const p = await db.person.create({
    data: {
      tenantId: f.tenantId,
      displayName: options.displayName ?? null,
      mergedIntoId: options.mergedInto ?? null,
    },
  });
  const rows = [];
  for (const c of contacts)
    rows.push(
      await db.contact.create({
        data: {
          tenantId: f.tenantId,
          channelAccountId: c.ig ? f.igAccountId : f.accountId,
          providerUserId: unique('u'),
          name: c.name ?? null,
          phone: c.phone ?? null,
          deletedAt: c.deleted ? new Date() : null,
          personId: p.id,
        },
      }),
    );
  return { person: p, contacts: rows };
}

async function conversationWithLead(f: Fixture, contactId: string) {
  const channelAccountId = (
    await db.contact.findFirstOrThrow({
      where: { id: contactId },
      select: { channelAccountId: true },
    })
  ).channelAccountId;
  const conversation = await db.conversation.create({
    data: {
      tenantId: f.tenantId,
      channelAccountId,
      contactId,
      providerChatId: unique('chat'),
      state: 'BOT_ACTIVE',
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      conversationId: conversation.id,
      summary: 'lead',
      idempotencyKey: unique('lead'),
    },
  });
  return { conversation, lead };
}

const merge = (
  f: Fixture,
  role: Role,
  sourceId: string,
  intoId: string,
  reason = 'same customer',
) => controller.merge(f.as[role], sourceId, { intoId, reason });

const httpError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the call to be rejected');
    },
    (error: { getStatus(): number; getResponse(): { code?: string } }) => ({
      status: error.getStatus(),
      code: error.getResponse().code,
    }),
  );

const contactMap = async (tenantId: string) =>
  Object.fromEntries(
    (
      await db.contact.findMany({
        where: { tenantId },
        select: { id: true, personId: true },
      })
    ).map((c) => [c.id, c.personId]),
  );

describe('Duplicate candidates (ADR 052 slice C)', () => {
  it('groups persons by the last 9 digits of a typed phone, tenant-scoped', async () => {
    const f = await fixture();
    const other = await fixture();
    const a = await person(f, [{ phone: '+998 90 123 45 67' }]);
    const b = await person(f, [{ phone: '90 123 45 67', ig: true }]);
    // Same digits but erased contact, merged person, other tenant, short number.
    const erased = await person(f, [{ phone: '+998901234567', deleted: true }]);
    const mergedAway = await person(f, [{ phone: '998901234567' }], {
      mergedInto: a.person.id,
    });
    await person(other, [{ phone: '+998901234567' }]);
    await person(f, [{ phone: '12345678' }]);
    await person(f, [{ phone: '12345678' }]);
    const distinct = await person(f, [{ phone: '+998 91 999 99 99' }]);

    const { groups } = await controller.duplicateGroups(f.as.VIEWER);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('PHONE');
    expect(groups[0].persons.map((p) => p.id)).toEqual([
      b.person.id,
      a.person.id,
    ]);
    const all = groups.flatMap((g) => g.persons.map((p) => p.id));
    for (const id of [
      erased.person.id,
      mergedAway.person.id,
      distinct.person.id,
    ])
      expect(all).not.toContain(id);

    const own = await controller.duplicatesOf(f.as.OPERATOR, a.person.id);
    expect(own.items.map((p) => p.id)).toEqual([b.person.id]);
    // The other tenant sees none of this tenant's persons.
    expect((await controller.duplicateGroups(other.as.OWNER)).groups).toEqual(
      [],
    );
  });

  it('answers 404 for unknown, other-tenant, merged, and all-erased persons', async () => {
    const f = await fixture();
    const other = await fixture();
    const a = await person(f, [{ phone: '+998901234567' }]);
    const gone = await person(f, [{ phone: '+998901234567', deleted: true }]);
    const mergedAway = await person(f, [{ phone: '+998901234567' }], {
      mergedInto: a.person.id,
    });
    for (const id of [
      randomUUID(),
      'not-a-uuid',
      gone.person.id,
      mergedAway.person.id,
    ])
      expect(await httpError(controller.duplicatesOf(f.as.OWNER, id))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    expect(
      await httpError(controller.duplicatesOf(other.as.OWNER, a.person.id)),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it('caps a person duplicate list at 10 and declares /duplicates before /:id', async () => {
    const f = await fixture();
    const a = await person(f, [{ phone: '+998901234567' }]);
    for (let i = 0; i < 12; i += 1) await person(f, [{ phone: '901234567' }]);
    const { items } = await controller.duplicatesOf(f.as.OWNER, a.person.id);
    expect(items).toHaveLength(10);
    const { groups } = await controller.duplicateGroups(f.as.OWNER);
    expect(groups[0].persons).toHaveLength(10);
    const order = Object.getOwnPropertyNames(PeopleController.prototype);
    expect(order.indexOf('duplicateGroups')).toBeLessThan(
      order.indexOf('detail'),
    );
  });
});

describe('Merge and unmerge (ADR 052 slice C)', () => {
  it('moves exactly the snapshot contacts; conversations and leads keep their contact', async () => {
    const f = await fixture();
    const source = await person(f, [
      { name: 'Ali', phone: '+998901234567' },
      { name: 'Ali IG', phone: '901234567', ig: true },
    ]);
    const survivor = await person(f, [{ name: 'Alisher' }]);
    const bystander = await person(f, [{ name: 'Other' }]);
    const sc1 = await conversationWithLead(f, source.contacts[0].id);
    const sc2 = await conversationWithLead(f, source.contacts[1].id);
    const before = await contactMap(f.tenantId);

    const result = await merge(
      f,
      'ADMIN',
      source.person.id,
      survivor.person.id,
    );

    const after = await contactMap(f.tenantId);
    const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
    expect(changed.sort()).toEqual(source.contacts.map((c) => c.id).sort());
    for (const id of changed) expect(after[id]).toBe(survivor.person.id);
    expect(after[bystander.contacts[0].id]).toBe(bystander.person.id);

    const row = await db.personMerge.findUniqueOrThrow({
      where: { id: result.mergeId },
    });
    expect(row.contactIds.sort()).toEqual(changed.sort());
    expect(row).toMatchObject({
      survivorId: survivor.person.id,
      mergedId: source.person.id,
      reason: 'same customer',
      undoneAt: null,
    });
    // Conversations and leads still belong to the original contacts.
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: sc1.conversation.id },
        })
      ).contactId,
    ).toBe(source.contacts[0].id);
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: sc2.lead.id } }))
        .contactId,
    ).toBe(source.contacts[1].id);
    expect(
      (await db.person.findUniqueOrThrow({ where: { id: source.person.id } }))
        .mergedIntoId,
    ).toBe(survivor.person.id);
    expect(
      await db.auditEvent.count({
        where: { tenantId: f.tenantId, action: 'person.merged' },
      }),
    ).toBe(1);

    expect(result.survivor.contacts).toHaveLength(3);
    expect(result.survivor.conversationCount).toBe(2);
    expect(result.survivor.leadCount).toBe(2);
    expect(result.survivor.lastMerge).toMatchObject({
      id: result.mergeId,
      contacts: 2,
    });
    expect(
      await httpError(controller.detail(f.as.OWNER, source.person.id)),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    const list = await controller.list(f.as.OWNER, {});
    expect(list.items.map((i) => i.id)).not.toContain(source.person.id);
  });

  it('merge then unmerge restores the exact contact set; later contacts stay', async () => {
    const f = await fixture();
    const source = await person(f, [{ name: 'A' }, { name: 'B', ig: true }]);
    const survivor = await person(f, [{ name: 'S' }]);
    const before = await contactMap(f.tenantId);
    const merged = await merge(
      f,
      'OWNER',
      source.person.id,
      survivor.person.id,
    );
    const late = await db.contact.create({
      data: {
        tenantId: f.tenantId,
        channelAccountId: f.accountId,
        providerUserId: unique('late'),
        personId: survivor.person.id,
      },
    });

    const undone = await controller.unmerge(f.as.ADMIN, survivor.person.id);

    expect(undone.mergeId).toBe(merged.mergeId);
    expect(undone.restored.id).toBe(source.person.id);
    expect(undone.restored.channels).toHaveLength(2);
    const after = await contactMap(f.tenantId);
    expect({ ...after, [late.id]: undefined }).toEqual({
      ...before,
      [late.id]: undefined,
    });
    expect(after[late.id]).toBe(survivor.person.id);
    expect(undone.survivor.lastMerge).toBeNull();
    const row = await db.personMerge.findUniqueOrThrow({
      where: { id: merged.mergeId },
    });
    expect(row.undoneAt).not.toBeNull();
    expect(row.undoneByOperatorId).not.toBeNull();
    expect(
      (await db.person.findUniqueOrThrow({ where: { id: source.person.id } }))
        .mergedIntoId,
    ).toBeNull();
    // Nothing left to undo.
    expect(
      await httpError(controller.unmerge(f.as.OWNER, survivor.person.id)),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it('undoes only the latest merge, in reverse order', async () => {
    const f = await fixture();
    const s = await person(f, [{ name: 'S' }]);
    const m1 = await person(f, [{ name: 'M1' }]);
    const m2 = await person(f, [{ name: 'M2' }]);
    await merge(f, 'OWNER', m1.person.id, s.person.id);
    const second = await merge(f, 'OWNER', m2.person.id, s.person.id);
    const undone = await controller.unmerge(f.as.OWNER, s.person.id);
    expect(undone.mergeId).toBe(second.mergeId);
    expect(undone.survivor.lastMerge?.contacts).toBe(1);
    expect(undone.survivor.contacts.map((c) => c.id)).toContain(
      m1.contacts[0].id,
    );
  });

  it('enforces the role matrix on preview, merge and unmerge; everyone reads duplicates', async () => {
    const f = await fixture();
    const a = await person(f, [{ phone: '+998901234567' }]);
    const b = await person(f, [{ phone: '901234567' }]);
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      const forbidden = { status: 403, code: 'FORBIDDEN' };
      expect(
        await httpError(
          controller.mergePreview(f.as[role], a.person.id, {
            intoId: b.person.id,
          }),
        ),
      ).toEqual(forbidden);
      expect(await httpError(merge(f, role, a.person.id, b.person.id))).toEqual(
        forbidden,
      );
      expect(
        await httpError(controller.unmerge(f.as[role], b.person.id)),
      ).toEqual(forbidden);
    }
    for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as const) {
      expect(
        (await controller.duplicateGroups(f.as[role])).groups,
      ).toHaveLength(1);
      expect(
        (await controller.duplicatesOf(f.as[role], a.person.id)).items,
      ).toHaveLength(1);
    }
    // Nothing moved by the refused calls.
    expect(
      await db.personMerge.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    const preview = await controller.mergePreview(f.as.ADMIN, a.person.id, {
      intoId: b.person.id,
    });
    expect(preview.source.id).toBe(a.person.id);
    await merge(f, 'ADMIN', a.person.id, b.person.id);
  });

  it('previews exactly what moves, ignoring erased contacts', async () => {
    const f = await fixture();
    const source = await person(f, [
      { name: 'A' },
      { name: 'B', ig: true },
      { name: 'gone', deleted: true },
    ]);
    const survivor = await person(f, [{ name: 'S' }]);
    await conversationWithLead(f, source.contacts[0].id);
    await conversationWithLead(f, source.contacts[1].id);
    await conversationWithLead(f, source.contacts[2].id);
    await conversationWithLead(f, survivor.contacts[0].id);
    const preview = await controller.mergePreview(
      f.as.OWNER,
      source.person.id,
      {
        intoId: survivor.person.id,
      },
    );
    expect(preview.moves).toEqual({ contacts: 2, conversations: 2, leads: 2 });
    expect(preview.survivor.id).toBe(survivor.person.id);
    // Preview changes nothing.
    expect(
      await db.personMerge.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    expect(
      await httpError(
        controller.mergePreview(f.as.OWNER, source.person.id, { intoId: 'x' }),
      ),
    ).toEqual({ status: 400, code: 'INVALID_QUERY' });
  });

  it('validates the body and refuses unknown, cross-tenant and unmergeable people', async () => {
    const f = await fixture();
    const other = await fixture();
    const a = await person(f, [{ name: 'A' }]);
    const b = await person(f, [{ name: 'B' }]);
    const foreign = await person(other, [{ name: 'F' }]);
    const gone = await person(f, [{ name: 'G', deleted: true }]);
    const mergedAway = await person(f, [{ name: 'M' }], {
      mergedInto: b.person.id,
    });
    const call = (id: string, body: unknown) =>
      httpError(controller.merge(f.as.OWNER, id, body));

    expect(await call(a.person.id, { intoId: 'x', reason: 'okay' })).toEqual({
      status: 400,
      code: 'INVALID_BODY',
    });
    expect(
      await call(a.person.id, { intoId: b.person.id, reason: 'ab' }),
    ).toEqual({ status: 400, code: 'INVALID_BODY' });
    expect(
      await call(a.person.id, { intoId: b.person.id, reason: 'x'.repeat(501) }),
    ).toEqual({ status: 400, code: 'INVALID_BODY' });
    expect(
      await call(a.person.id, { intoId: a.person.id, reason: 'same one' }),
    ).toEqual({ status: 400, code: 'SAME_PERSON' });
    for (const [id, into] of [
      [randomUUID(), b.person.id],
      [a.person.id, randomUUID()],
      [foreign.person.id, b.person.id],
      [a.person.id, foreign.person.id],
    ])
      expect(await call(id, { intoId: into, reason: 'same one' })).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    for (const [id, into] of [
      [gone.person.id, b.person.id],
      [a.person.id, gone.person.id],
      [mergedAway.person.id, a.person.id],
      [a.person.id, mergedAway.person.id],
    ])
      expect(await call(id, { intoId: into, reason: 'same one' })).toEqual({
        status: 409,
        code: 'MERGE_REFUSED',
      });
    expect(
      await db.personMerge.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    expect(await contactMap(f.tenantId)).toMatchObject({
      [a.contacts[0].id]: a.person.id,
      [b.contacts[0].id]: b.person.id,
    });
  });

  it('lets exactly one of two concurrent merges of the same source win', async () => {
    const f = await fixture();
    const source = await person(f, [{ name: 'A' }, { name: 'A2', ig: true }]);
    const s1 = await person(f, [{ name: 'S1' }]);
    const s2 = await person(f, [{ name: 'S2' }]);
    const results = await Promise.allSettled([
      merge(f, 'OWNER', source.person.id, s1.person.id),
      merge(f, 'ADMIN', source.person.id, s2.person.id),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const reason = (failed[0] as PromiseRejectedResult).reason as {
      getStatus(): number;
      getResponse(): { code: string };
    };
    expect(reason.getStatus()).toBe(409);
    expect(reason.getResponse().code).toBe('MERGE_REFUSED');
    expect(
      await db.personMerge.count({ where: { tenantId: f.tenantId } }),
    ).toBe(1);
    const owners = new Set(
      (
        await db.contact.findMany({
          where: { id: { in: source.contacts.map((c) => c.id) } },
        })
      ).map((c) => c.personId),
    );
    expect(owners.size).toBe(1);
  });

  describe('UNMERGE_BLOCKED', () => {
    const blocked = { status: 409, code: 'UNMERGE_BLOCKED' };

    async function mergedPair() {
      const f = await fixture();
      const source = await person(f, [{ name: 'A' }, { name: 'B', ig: true }]);
      const survivor = await person(f, [{ name: 'S' }]);
      await merge(f, 'OWNER', source.person.id, survivor.person.id);
      return { f, source, survivor };
    }

    it('when the survivor was merged into another person afterwards', async () => {
      const { f, survivor } = await mergedPair();
      const third = await person(f, [{ name: 'T' }]);
      await merge(f, 'OWNER', survivor.person.id, third.person.id);
      expect(
        await httpError(controller.unmerge(f.as.OWNER, survivor.person.id)),
      ).toEqual(blocked);
      // Undo in reverse order works: first the newer merge.
      const undone = await controller.unmerge(f.as.OWNER, third.person.id);
      expect(undone.restored.id).toBe(survivor.person.id);
      expect(
        (await controller.unmerge(f.as.OWNER, survivor.person.id)).mergeId,
      ).toBeTruthy();
    });

    it('when the survivor is deleted', async () => {
      const { f, survivor } = await mergedPair();
      await db.person.update({
        where: { id: survivor.person.id },
        data: { deletedAt: new Date() },
      });
      expect(
        await httpError(controller.unmerge(f.as.OWNER, survivor.person.id)),
      ).toEqual(blocked);
    });

    it('when the merged person no longer points at the survivor', async () => {
      const { f, source, survivor } = await mergedPair();
      await db.person.update({
        where: { id: source.person.id },
        data: { mergedIntoId: null },
      });
      expect(
        await httpError(controller.unmerge(f.as.OWNER, survivor.person.id)),
      ).toEqual(blocked);
    });

    it('when a snapshot contact was erased, and lastMerge reflects it', async () => {
      const { f, source, survivor } = await mergedPair();
      expect(
        (await controller.detail(f.as.OWNER, survivor.person.id)).lastMerge,
      ).not.toBeNull();
      await contactErasure.erase(
        f.tenantId,
        source.contacts[0].id,
        f.operatorId,
      );
      expect(
        (await controller.detail(f.as.OWNER, survivor.person.id)).lastMerge,
      ).toBeNull();
      expect(
        await httpError(controller.unmerge(f.as.OWNER, survivor.person.id)),
      ).toEqual(blocked);
      // Blocked means nothing changed.
      expect((await contactMap(f.tenantId))[source.contacts[1].id]).toBe(
        survivor.person.id,
      );
    });
  });
});

describe('Person erase (ADR 052 slice D)', () => {
  async function lineage() {
    const f = await fixture();
    const s = await person(f, [{ name: 'Survivor', phone: '+998901234567' }], {
      displayName: 'Survivor',
    });
    const m = await person(
      f,
      [{ name: 'Merged', phone: '+998901234567', ig: true }],
      {
        displayName: 'Merged copy',
      },
    );
    const m2 = await person(f, [{ name: 'Deep', phone: '+998901234567' }], {
      displayName: 'Deep copy',
    });
    await merge(f, 'OWNER', m2.person.id, m.person.id, 'private reason one');
    await merge(f, 'OWNER', m.person.id, s.person.id, 'private reason two');
    const bystander = await person(f, [{ name: 'Bystander' }]);
    const bystander2 = await person(f, [{ name: 'Bystander2' }]);
    await merge(
      f,
      'OWNER',
      bystander2.person.id,
      bystander.person.id,
      'unrelated reason',
    );
    return { f, s, m, m2, bystander, bystander2 };
  }

  it('erases every contact, clears the person and the merged lineage, repeat gives 404', async () => {
    const { f, s, m, m2, bystander } = await lineage();
    const convo = await conversationWithLead(f, m.contacts[0].id);

    const result = await controller.erase(f.as.OWNER, s.person.id);

    expect(result).toMatchObject({
      personId: s.person.id,
      contacts: 3,
      conversations: 1,
    });
    const contacts = await db.contact.findMany({
      where: { id: { in: [s, m, m2].map((x) => x.contacts[0].id) } },
    });
    expect(contacts).toHaveLength(3);
    for (const c of contacts) {
      expect(c.deletedAt).not.toBeNull();
      expect(c.name).toBeNull();
      expect(c.phone).toBeNull();
    }
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: convo.conversation.id },
        })
      ).state,
    ).toBe('CLOSED');
    for (const p of [s, m, m2]) {
      const row = await db.person.findUniqueOrThrow({
        where: { id: p.person.id },
      });
      expect(row.displayName).toBeNull();
      expect(row.primaryPhone).toBeNull();
      expect(row.deletedAt).not.toBeNull();
    }
    const merges = await db.personMerge.findMany({
      where: { tenantId: f.tenantId },
      select: { survivorId: true, reason: true },
    });
    const mine = merges.filter((x) =>
      [s, m].some((p) => p.person.id === x.survivorId),
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((x) => x.reason === '[erased]')).toBe(true);
    expect(
      merges.find((x) => x.survivorId === bystander.person.id)?.reason,
    ).toBe('unrelated reason');
    expect(
      (
        await db.person.findUniqueOrThrow({
          where: { id: bystander.person.id },
        })
      ).deletedAt,
    ).toBeNull();
    expect(
      await db.auditEvent.count({
        where: { tenantId: f.tenantId, action: 'person.erased' },
      }),
    ).toBe(1);

    expect(await httpError(controller.erase(f.as.OWNER, s.person.id))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    // A merged row is not erasable on its own either.
    expect(await httpError(controller.erase(f.as.OWNER, m.person.id))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('is OWNER only and tenant-scoped', async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await person(f, [{ name: 'X' }]);
    for (const role of ['ADMIN', 'OPERATOR', 'VIEWER'] as const)
      expect(
        await httpError(controller.erase(f.as[role], p.person.id)),
      ).toEqual({
        status: 403,
        code: 'FORBIDDEN',
      });
    expect(
      await httpError(controller.erase(other.as.OWNER, p.person.id)),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(
      (await db.contact.findUniqueOrThrow({ where: { id: p.contacts[0].id } }))
        .deletedAt,
    ).toBeNull();
  });

  it('is atomic: a failing contact erase leaves nothing half erased', async () => {
    const f = await fixture();
    const p = await person(f, [{ name: 'One' }, { name: 'Two', ig: true }], {
      displayName: 'Whole',
    });
    const c1 = await conversationWithLead(f, p.contacts[0].id);
    await conversationWithLead(f, p.contacts[1].id);
    const real = contactErasure.eraseInTransaction.bind(contactErasure);
    let calls = 0;
    const spy = vi
      .spyOn(contactErasure, 'eraseInTransaction')
      .mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return real(...args);
      });
    try {
      await expect(controller.erase(f.as.OWNER, p.person.id)).rejects.toThrow(
        'boom',
      );
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    const contacts = await db.contact.findMany({
      where: { id: { in: p.contacts.map((c) => c.id) } },
    });
    expect(contacts.every((c) => c.deletedAt === null && c.name !== null)).toBe(
      true,
    );
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: c1.conversation.id },
        })
      ).state,
    ).toBe('BOT_ACTIVE');
    const row = await db.person.findUniqueOrThrow({
      where: { id: p.person.id },
    });
    expect(row.displayName).toBe('Whole');
    expect(row.deletedAt).toBeNull();
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: f.tenantId,
          action: { in: ['person.erased', 'contact.erased'] },
        },
      }),
    ).toBe(0);
  });

  it('the per-contact erase clears the lineage when it erases the last contact', async () => {
    const f = await fixture();
    const s = await person(f, [{ name: 'S1' }], { displayName: 'S' });
    const m = await person(f, [{ name: 'M1', ig: true }], {
      displayName: 'M copy',
    });
    await merge(f, 'OWNER', m.person.id, s.person.id, 'secret reason');
    await contactErasure.erase(f.tenantId, s.contacts[0].id, f.operatorId);
    // One contact left: the merged row and the reason stay.
    const mid = await db.person.findUniqueOrThrow({
      where: { id: m.person.id },
    });
    expect(mid.displayName).toBe('M copy');
    expect(mid.deletedAt).toBeNull();
    expect(
      (
        await db.personMerge.findFirstOrThrow({
          where: { tenantId: f.tenantId },
        })
      ).reason,
    ).toBe('secret reason');

    await contactErasure.erase(f.tenantId, m.contacts[0].id, f.operatorId);
    const last = await db.person.findUniqueOrThrow({
      where: { id: m.person.id },
    });
    expect(last.displayName).toBeNull();
    expect(last.deletedAt).not.toBeNull();
    expect(
      (
        await db.personMerge.findFirstOrThrow({
          where: { tenantId: f.tenantId },
        })
      ).reason,
    ).toBe('[erased]');
  });
});
