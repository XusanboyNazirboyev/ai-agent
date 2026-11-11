/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
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

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('People integration tests require agentcore_test');
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
const controller = new PeopleController(new PeopleService(prisma));
const erasure = new ContactErasureService(prisma);

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;

interface Fixture {
  tenantId: string;
  accountId: string;
  igAccountId: string;
  request: InboxRequest;
  cookie: string;
}

async function fixture(role: 'OWNER' | 'VIEWER' = 'OWNER'): Promise<Fixture> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('ppl'),
      name: 'People fixture',
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
  const operator = await db.operator.create({
    data: { tenantId: tenant.id, displayName: 'Op', role },
  });
  const email = `${unique('op')}@example.test`;
  await sessions.setPassword(tenant.id, operator.id, email, 'correct horse');
  const login = await sessions.login(email, 'correct horse');
  if (!login.ok) throw new Error('login failed');
  const cookie = `${SESSION_COOKIE}=${login.sessionToken}`;
  const request = {
    method: 'GET',
    headers: { cookie },
  } as unknown as InboxRequest;
  await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext);
  return {
    tenantId: tenant.id,
    accountId: account.id,
    igAccountId: ig.id,
    request,
    cookie,
  };
}

async function person(
  f: Fixture,
  options: {
    displayName?: string | null;
    contacts: Array<{
      name?: string | null;
      phone?: string | null;
      ig?: boolean;
      optOut?: boolean;
      deleted?: boolean;
    }>;
    mergedInto?: string;
  },
) {
  const p = await db.person.create({
    data: {
      tenantId: f.tenantId,
      displayName: options.displayName ?? null,
      mergedIntoId: options.mergedInto ?? null,
    },
  });
  const contacts = [];
  for (const c of options.contacts)
    contacts.push(
      await db.contact.create({
        data: {
          tenantId: f.tenantId,
          channelAccountId: c.ig ? f.igAccountId : f.accountId,
          providerUserId: unique('u'),
          name: c.name ?? null,
          phone: c.phone ?? null,
          marketingOptOut: c.optOut ?? false,
          deletedAt: c.deleted ? new Date() : null,
          personId: p.id,
        },
      }),
    );
  return { person: p, contacts };
}

async function conversation(f: Fixture, contactId: string, updatedAt?: Date) {
  const igContact = await db.contact.findFirstOrThrow({
    where: { id: contactId },
    select: { channelAccountId: true },
  });
  const row = await db.conversation.create({
    data: {
      tenantId: f.tenantId,
      channelAccountId: igContact.channelAccountId,
      contactId,
      providerChatId: unique('chat'),
      state: 'BOT_ACTIVE',
    },
  });
  if (updatedAt)
    await db.$executeRaw`UPDATE conversations SET updated_at = ${updatedAt} WHERE id = ${row.id}::uuid`;
  return row;
}

async function lead(f: Fixture, contactId: string, conversationId: string) {
  return db.lead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      conversationId,
      summary: 's',
      idempotencyKey: unique('lead'),
    },
  });
}

describe('People API (ADR 052 slice B)', () => {
  it('returns the contract shape, newest person first, and keyset-pages', async () => {
    const f = await fixture();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1)
      created.push(
        (
          await person(f, {
            displayName: `Pat ${i}`,
            contacts: [{ name: `Pat ${i}`, phone: `+99890000000${i}` }],
          })
        ).person.id,
      );
    const first = await controller.list(f.request, { limit: '2' });
    expect(first.items.map((i) => i.id)).toEqual([created[4], created[3]]);
    expect(first.nextCursor).toBe(created[3]);
    const second = await controller.list(f.request, {
      limit: '2',
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.id)).toEqual([created[2], created[1]]);
    const third = await controller.list(f.request, {
      limit: '2',
      cursor: second.nextCursor!,
    });
    expect(third.items.map((i) => i.id)).toEqual([created[0]]);
    expect(third.nextCursor).toBeNull();
    expect(Object.keys(first.items[0]).sort()).toEqual(
      [
        'channels',
        'conversationCount',
        'createdAt',
        'displayName',
        'id',
        'lastActivityAt',
        'lastConversationId',
        'leadCount',
        'marketingOptOut',
        'phone',
      ].sort(),
    );
    expect(first.items[0]).toMatchObject({
      displayName: 'Pat 4',
      phone: '+998900000004',
      conversationCount: 0,
      leadCount: 0,
      lastConversationId: null,
      lastActivityAt: null,
      marketingOptOut: false,
    });
    expect(first.items[0].channels).toHaveLength(1);
    expect(first.items[0].channels[0].channelType).toBe('telegram');
    expect(typeof first.items[0].createdAt).toBe('string');
    expect(JSON.stringify(first)).not.toContain('providerUserId');
  });

  it('searches by name (case-insensitive) and by phone', async () => {
    const f = await fixture();
    await person(f, {
      displayName: 'Ada Lovelace',
      contacts: [{ name: 'Ada L', phone: '+998901112233' }],
    });
    await person(f, {
      displayName: null,
      contacts: [{ name: 'Grace Hopper', phone: '+998905556677' }],
    });
    const byPerson = await controller.list(f.request, { q: 'LOVELACE' });
    expect(byPerson.items.map((i) => i.displayName)).toEqual(['Ada Lovelace']);
    const byContact = await controller.list(f.request, { q: 'hopper' });
    expect(byContact.items).toHaveLength(1);
    const byPhone = await controller.list(f.request, { q: '5556677' });
    expect(byPhone.items).toHaveLength(1);
    expect(byPhone.items[0].phone).toBe('+998905556677');
    expect((await controller.list(f.request, { q: 'nobody' })).items).toEqual(
      [],
    );
  });

  it('aggregates a person with two channels', async () => {
    const f = await fixture();
    const { person: p, contacts } = await person(f, {
      displayName: 'Multi',
      contacts: [
        { name: 'Multi TG', phone: null },
        { name: 'Multi IG', phone: '+998907778899', ig: true, optOut: true },
      ],
    });
    const c1 = await conversation(f, contacts[0].id, new Date('2026-01-01Z'));
    const c2 = await conversation(f, contacts[1].id, new Date('2026-02-01Z'));
    await conversation(f, contacts[1].id, new Date('2026-01-15Z'));
    await lead(f, contacts[0].id, c1.id);
    await lead(f, contacts[1].id, c2.id);
    const { items } = await controller.list(f.request, {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: p.id,
      phone: '+998907778899',
      conversationCount: 3,
      leadCount: 2,
      lastConversationId: c2.id,
      lastActivityAt: '2026-02-01T00:00:00.000Z',
      marketingOptOut: true,
    });
    expect(items[0].channels).toEqual([
      { contactId: contacts[0].id, channelType: 'telegram' },
      { contactId: contacts[1].id, channelType: 'instagram' },
    ]);
    const detail = await controller.detail(f.request, p.id);
    expect(detail.contacts.map((c) => c.channelName)).toEqual(['@bot', null]);
    expect(detail.contacts[1]).toMatchObject({
      channelType: 'instagram',
      consentStatus: 'UNKNOWN',
      marketingOptOut: true,
      language: null,
    });
    expect(detail.conversations.map((c) => c.updatedAt)).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-01-15T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(detail.conversations[0]).toMatchObject({
      contactId: contacts[1].id,
      channelType: 'instagram',
      state: 'BOT_ACTIVE',
    });
    expect(detail.leads).toHaveLength(2);
    expect(detail.leads[0]).toMatchObject({
      status: 'NEW',
      score: 'COLD',
      stageName: null,
    });
    expect(detail.conversationCount).toBe(3);
  });

  it('excludes erased contacts; an all-erased person is unlisted and 404', async () => {
    const f = await fixture();
    const partial = await person(f, {
      displayName: 'Partial',
      contacts: [{ name: 'Keep' }, { name: 'Gone', phone: '+998900000001' }],
    });
    const gone = await person(f, {
      displayName: 'All gone',
      contacts: [{ name: 'Gone too' }],
    });
    const goneDirect = await person(f, {
      displayName: 'Erased direct',
      contacts: [{ name: 'x', deleted: true }],
    });
    await erasure.erase(f.tenantId, partial.contacts[1].id, 'op');
    await erasure.erase(f.tenantId, gone.contacts[0].id, 'op');
    const { items } = await controller.list(f.request, {});
    expect(items.map((i) => i.id)).toEqual([partial.person.id]);
    expect(items[0].channels).toEqual([
      { contactId: partial.contacts[0].id, channelType: 'telegram' },
    ]);
    expect(items[0].phone).toBeNull();
    const detail = await controller.detail(f.request, partial.person.id);
    expect(detail.contacts.map((c) => c.id)).toEqual([partial.contacts[0].id]);
    for (const id of [gone.person.id, goneDirect.person.id])
      await expect(controller.detail(f.request, id)).rejects.toMatchObject({
        response: { code: 'NOT_FOUND', i18nKey: 'errors.notFound' },
      });
  });

  it('does not list a merged person', async () => {
    const f = await fixture();
    const survivor = await person(f, {
      displayName: 'Survivor',
      contacts: [{ name: 'S' }],
    });
    const merged = await person(f, {
      displayName: 'Merged',
      contacts: [{ name: 'M' }],
      mergedInto: survivor.person.id,
    });
    const { items } = await controller.list(f.request, {});
    expect(items.map((i) => i.id)).toEqual([survivor.person.id]);
    await expect(
      controller.detail(f.request, merged.person.id),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('isolates tenants', async () => {
    const a = await fixture();
    const b = await fixture();
    const pa = await person(a, { displayName: 'A', contacts: [{ name: 'A' }] });
    await person(b, { displayName: 'B', contacts: [{ name: 'B' }] });
    await expect(
      controller.detail(b.request, pa.person.id),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    const listB = await controller.list(b.request, { q: 'A' });
    expect(listB.items).toEqual([]);
    expect((await controller.list(a.request, {})).items).toHaveLength(1);
  });

  it('lets a VIEWER read and rejects unauthenticated calls', async () => {
    const f = await fixture('VIEWER');
    const p = await person(f, { displayName: 'V', contacts: [{ name: 'V' }] });
    expect((await controller.list(f.request, {})).items).toHaveLength(1);
    expect((await controller.detail(f.request, p.person.id)).id).toBe(
      p.person.id,
    );
    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({ method: 'GET', headers: {} }),
        }),
      } as unknown as ExecutionContext),
    ).rejects.toMatchObject({ response: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects invalid queries and treats a malformed id as not found', async () => {
    const f = await fixture();
    for (const query of [
      { limit: '0' },
      { limit: '51' },
      { limit: 'abc' },
      { q: 'x'.repeat(81) },
      { cursor: 'nope' },
    ])
      await expect(controller.list(f.request, query)).rejects.toMatchObject({
        response: { code: 'INVALID_QUERY', i18nKey: 'errors.invalidQuery' },
      });
    await expect(
      controller.detail(f.request, 'not-a-uuid'),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    await expect(
      controller.detail(f.request, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('caps detail conversations and leads at 20, newest first', async () => {
    const f = await fixture();
    const { person: p, contacts } = await person(f, {
      displayName: 'Busy',
      contacts: [{ name: 'Busy' }],
    });
    let firstConversation = '';
    for (let i = 0; i < 22; i += 1) {
      const c = await conversation(
        f,
        contacts[0].id,
        new Date(Date.UTC(2026, 0, 1, 0, i)),
      );
      if (i === 0) firstConversation = c.id;
      await lead(f, contacts[0].id, c.id);
    }
    const detail = await controller.detail(f.request, p.id);
    expect(detail.conversations).toHaveLength(20);
    expect(detail.leads).toHaveLength(20);
    expect(detail.conversationCount).toBe(22);
    expect(detail.leadCount).toBe(22);
    expect(detail.conversations.map((c) => c.id)).not.toContain(
      firstConversation,
    );
    const times = detail.conversations.map((c) => c.updatedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
