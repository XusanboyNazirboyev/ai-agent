import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { HandoverService } from '../handover/handover.service.js';
import { OperatorCommandsController } from '../handover/operator-commands.controller.js';
import { OperatorTokenGuard } from '../handover/operator-auth.js';
import { OperatorRequestGuard } from '../handover/operator-request-guard.js';
import { EventEmitter } from 'node:events';
import { AuthController } from './auth.controller.js';
import { ChannelsController } from './channels.controller.js';
import { PrismaChannelSecretStore } from '../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { ContactsController } from './contacts.controller.js';
import { KnowledgeFaqController } from './knowledge-faq.controller.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { HashingEmbeddingProvider } from '../llm/embeddings/hashing-embedding-provider.js';
import { EventsController, openStreams } from './events.controller.js';
import { InboxEventBus, type BusEvent } from './inbox-event-bus.js';
import { InboxEventsService, parseEventId } from './inbox-events.service.js';
import { InboxReadService } from './inbox-read.service.js';
import { hashPassword, verifyPassword } from './password.js';
import { CSRF_HEADER, SESSION_COOKIE, SessionGuard } from './session.guard.js';
import {
  DEFAULT_SESSION_POLICY,
  SessionService,
  type InboxPrincipal,
} from './session.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Web inbox integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

/** Distinct, deterministic peer addresses so limiter buckets never collide. */
let peerCounter = 0;
const nextPeer = (): string => {
  peerCounter += 1;
  return `10.200.${Math.floor(peerCounter / 250)}.${peerCounter % 250}`;
};

const FAST = { N: 1024, r: 8, p: 1 };
const policy = { ...DEFAULT_SESSION_POLICY, scrypt: FAST };
const sessions = new SessionService(prisma, policy);
const events = new InboxEventsService(prisma);
const read = new InboxReadService(prisma);
const guard = new SessionGuard(sessions, {
  get: () => ['http://localhost:3000'],
} as never);

interface World {
  tenantId: string;
  operatorId: string;
  email: string;
  conversationId: string;
  accountId: string;
  contactId: string;
}

async function world(
  role: 'OPERATOR' | 'VIEWER' | 'ADMIN' = 'OPERATOR',
): Promise<World> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `web-${suffix}`,
      name: 'Web fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `web-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: `Customer ${suffix.slice(0, 6)}`,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: 'WAITING_OPERATOR',
    },
  });
  const operator = await db.operator.create({
    data: { tenantId: tenant.id, displayName: 'Op', role },
  });
  const email = `op-${suffix}@example.test`;
  await sessions.setPassword(tenant.id, operator.id, email, 'correct horse');
  return {
    tenantId: tenant.id,
    operatorId: operator.id,
    email,
    conversationId: conversation.id,
    accountId: account.id,
    contactId: contact.id,
  };
}

async function signIn(
  w: World,
): Promise<{ cookie: string; csrf: string; principal: InboxPrincipal }> {
  const result = await sessions.login(w.email, 'correct horse');
  if (!result.ok) throw new Error('login failed');
  const resolved = await sessions.resolve(result.sessionToken);
  const principal: InboxPrincipal = {
    tenantId: resolved!.tenantId,
    operatorId: resolved!.operatorId,
    role: resolved!.role,
    sessionId: resolved!.sessionId,
  };
  return {
    cookie: `${SESSION_COOKIE}=${result.sessionToken}`,
    csrf: result.csrfToken,
    principal,
  };
}

function context(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('password hashing', () => {
  it('verifies the right password only and carries its parameters', async () => {
    const hash = await hashPassword('s3cret ü', FAST);
    expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await verifyPassword('s3cret ü', hash)).toBe(true);
    expect(await verifyPassword('s3cret u', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AAAA$AAAA')).toBe(
      false,
    );
  });
});

describe('login and sessions', () => {
  it('stores only hashes and answers unknown email and wrong password alike', async () => {
    const w = await world();
    const ok = await sessions.login(w.email.toUpperCase(), 'correct horse');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const rows = await db.operatorSession.findMany({
      where: { tenantId: w.tenantId },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(ok.sessionToken);
    expect(JSON.stringify(rows)).not.toContain(ok.csrfToken);
    const wrong = await sessions.login(w.email, 'nope');
    const unknown = await sessions.login(
      `nobody-${randomUUID()}@example.test`,
      'nope',
    );
    expect(wrong).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect(unknown).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const w = await world();
    for (let i = 0; i < policy.maxFailedAttempts; i += 1)
      await sessions.login(w.email, 'bad');
    expect(await sessions.login(w.email, 'correct horse')).toEqual({
      ok: false,
      code: 'LOCKED',
    });
    const later = new Date(Date.now() + policy.lockMs + 1000);
    expect((await sessions.login(w.email, 'correct horse', later)).ok).toBe(
      true,
    );
  });

  it('refuses expired, idle, revoked sessions and deactivated operators', async () => {
    const w = await world();
    const a = await sessions.login(w.email, 'correct horse');
    if (!a.ok) throw new Error('login');
    expect(await sessions.resolve(a.sessionToken)).toBeDefined();
    expect(
      await sessions.resolve(
        a.sessionToken,
        new Date(Date.now() + policy.idleTtlMs + 60_000),
      ),
    ).toBeUndefined();
    expect(
      await sessions.resolve(
        a.sessionToken,
        new Date(Date.now() + policy.absoluteTtlMs + 1),
      ),
    ).toBeUndefined();
    expect(await sessions.resolve('x'.repeat(50))).toBeUndefined();
    const resolved = (await sessions.resolve(a.sessionToken))!;
    await sessions.logout(resolved.sessionId, w.tenantId);
    expect(await sessions.resolve(a.sessionToken)).toBeUndefined();
    const b = await sessions.login(w.email, 'correct horse');
    if (!b.ok) throw new Error('login');
    await db.operator.update({
      where: { id: w.operatorId },
      data: { isActive: false },
    });
    expect(await sessions.resolve(b.sessionToken)).toBeUndefined();
    expect(await sessions.login(w.email, 'correct horse')).toMatchObject({
      ok: false,
    });
  });

  it('a logout under another tenant id does nothing', async () => {
    const w = await world();
    const other = await world();
    const s = await signIn(w);
    await sessions.logout(s.principal.sessionId, other.tenantId);
    expect(await sessions.resolve(s.cookie.split('=')[1])).toBeDefined();
  });
});

describe('session guard', () => {
  it('refuses a request without a valid cookie with one 401', async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE}=nope`, 'other=1']) {
      await expect(
        guard.canActivate(context({ method: 'GET', headers: { cookie } })),
      ).rejects.toMatchObject({ status: 401 });
    }
  });

  it('lets a GET through with the cookie and sets the principal from the session', async () => {
    const w = await world();
    const s = await signIn(w);
    const request: {
      method: string;
      headers: Record<string, string>;
      principal?: InboxPrincipal;
    } = {
      method: 'GET',
      headers: { cookie: s.cookie },
    };
    expect(await guard.canActivate(context(request))).toBe(true);
    expect(request.principal).toMatchObject({
      tenantId: w.tenantId,
      operatorId: w.operatorId,
      role: 'OPERATOR',
    });
  });

  it('requires the CSRF header and an allowed Origin for unsafe methods', async () => {
    const w = await world();
    const s = await signIn(w);
    const post = (headers: Record<string, string>): Promise<boolean> =>
      guard.canActivate(
        context({ method: 'POST', headers: { cookie: s.cookie, ...headers } }),
      );
    await expect(post({})).rejects.toMatchObject({ status: 403 });
    await expect(post({ [CSRF_HEADER]: 'wrong' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      post({ [CSRF_HEADER]: s.csrf, origin: 'https://evil.example' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await post({ [CSRF_HEADER]: s.csrf, origin: 'http://localhost:3000' }),
    ).toBe(true);
    expect(await post({ [CSRF_HEADER]: s.csrf })).toBe(true);
  });

  it('a CSRF token of another session is refused', async () => {
    const a = await signIn(await world());
    const b = await signIn(await world());
    await expect(
      guard.canActivate(
        context({
          method: 'POST',
          headers: { cookie: a.cookie, [CSRF_HEADER]: b.csrf },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('inbox reads are tenant-scoped', () => {
  it('lists and views only the session tenant’s conversations', async () => {
    const a = await world();
    const b = await world();
    const sa = await signIn(a);
    const listA = await read.list(sa.principal, { scope: 'all' });
    expect(listA.items.map((i) => i.id)).toEqual([a.conversationId]);
    expect(await read.view(sa.principal, b.conversationId)).toBeUndefined();
    const own = await read.view(sa.principal, a.conversationId);
    expect(own?.conversation.id).toBe(a.conversationId);
  });

  it('shows the waiting queue by longest wait and paginates with a cursor', async () => {
    const w = await world();
    const s = await signIn(w);
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      const contact = await db.contact.create({
        data: {
          tenantId: w.tenantId,
          channelAccountId: w.accountId,
          providerUserId: `p-${i}-${randomUUID()}`,
        },
      });
      const conversation = await db.conversation.create({
        data: {
          tenantId: w.tenantId,
          channelAccountId: w.accountId,
          contactId: contact.id,
          providerChatId: `p-${i}-${randomUUID()}`,
          state: 'WAITING_OPERATOR',
        },
      });
      await db.handover.create({
        data: {
          tenantId: w.tenantId,
          conversationId: conversation.id,
          reasonCode: 'CUSTOMER_REQUEST',
          summary: {},
          openedAt: new Date(now - (i + 1) * 60_000),
        },
      });
    }
    const first = await read.list(s.principal, { scope: 'waiting', limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const waits = first.items.map((i) => i.waitingSince ?? '');
    expect([...waits].sort()).toEqual(waits);
    const second = await read.list(s.principal, {
      scope: 'waiting',
      limit: 3,
      cursor: first.nextCursor!,
    });
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(ids.size).toBe(first.items.length + second.items.length);
    expect(await read.list(s.principal, { scope: 'mine' })).toMatchObject({
      items: [],
    });
    expect(
      (await read.list(s.principal, { scope: 'all', cursor: '!!!' })).items
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('inbox change feed', () => {
  it('records conversation, message, handover and SLA events from triggers, tenant by tenant', async () => {
    const a = await world();
    const b = await world();
    const before = await events.latestId(a.tenantId);
    await db.message.create({
      data: {
        tenantId: a.tenantId,
        conversationId: a.conversationId,
        channelAccountId: a.accountId,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text: 'hello secret text',
        sequence: 1,
        providerChatId: 'c',
      },
    });
    const handover = await db.handover.create({
      data: {
        tenantId: a.tenantId,
        conversationId: a.conversationId,
        reasonCode: 'X',
        summary: {},
      },
    });
    await db.conversation.update({
      where: { id: a.conversationId },
      data: { state: 'OPERATOR_ACTIVE', assignedOperatorId: a.operatorId },
    });
    await db.handover.update({
      where: { id: handover.id },
      data: { slaAlertedAt: new Date() },
    });
    const { events: got, gap } = await events.after(a.tenantId, before);
    expect(gap).toBe(false);
    expect(got.map((e) => e.type)).toEqual([
      'message.created',
      'handover.created',
      'conversation.updated',
      'handover.sla_breached',
    ]);
    expect(JSON.stringify(got)).not.toContain('secret');
    const ids = got.map((e) => BigInt(e.id));
    expect([...ids].sort((x, y) => (x < y ? -1 : 1))).toEqual(ids);
    const resumed = await events.after(a.tenantId, ids[1]);
    expect(resumed.events.map((e) => e.type)).toEqual([
      'conversation.updated',
      'handover.sla_breached',
    ]);
    const other = await events.after(b.tenantId, 0n);
    expect(
      other.events.every(
        (e) =>
          e.conversationId === b.conversationId || e.conversationId === null,
      ),
    ).toBe(true);
    expect(
      other.events.some((e) => e.conversationId === a.conversationId),
    ).toBe(false);
  });

  it('does not emit an event for unrelated conversation updates', async () => {
    const w = await world();
    const before = await events.latestId(w.tenantId);
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { language: 'uz' },
    });
    expect((await events.after(w.tenantId, before)).events).toEqual([]);
  });

  it('signals a gap when needed events were pruned, and prunes only old rows', async () => {
    const w = await world();
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { state: 'CLOSED' },
    });
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { state: 'BOT_ACTIVE' },
    });
    const all = (await events.after(w.tenantId, 0n)).events.map((e) =>
      BigInt(e.id),
    );
    expect(all.length).toBeGreaterThanOrEqual(3);
    await db.inboxEvent.deleteMany({
      where: { tenantId: w.tenantId, id: all[1] },
    });
    const lossy = await events.after(w.tenantId, all[0]);
    expect(lossy.events.length).toBeGreaterThan(0);
    await db.inboxEvent.deleteMany({
      where: { tenantId: w.tenantId, id: { lt: all[2] } },
    });
    expect((await events.after(w.tenantId, all[0])).gap).toBe(true);
    expect((await events.after(w.tenantId, all[2])).gap).toBe(false);
    expect(
      await events.prune(new Date(Date.now() - 365 * 24 * 3600 * 1000)),
    ).toBe(0);
  });

  it('parses event ids strictly', () => {
    expect(parseEventId('42')).toBe(42n);
    for (const bad of [undefined, '', '-1', '1.5', 'abc', '9'.repeat(30)])
      expect(parseEventId(bad)).toBeUndefined();
  });
});

describe('operator commands through the browser session', () => {
  const requestGuard = new OperatorRequestGuard(
    new OperatorTokenGuard(prisma),
    guard,
  );
  const controller = new OperatorCommandsController(
    new HandoverService(prisma),
  );

  async function handoverOf(w: World): Promise<string> {
    const h = await db.handover.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        reasonCode: 'CUSTOMER_REQUEST',
        summary: {},
      },
    });
    return h.id;
  }

  async function call(
    s: { cookie: string; csrf: string },
    headers: Record<string, string> = {},
  ): Promise<{ operator: { tenantId: string; operatorId: string } }> {
    const request: {
      method: string;
      headers: Record<string, string>;
      operator?: never;
    } = {
      method: 'POST',
      headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf, ...headers },
    };
    await requestGuard.canActivate(context(request));
    return request as never;
  }

  it('takes over, replies and returns to the bot with the cookie, and the feed shows it', async () => {
    const w = await world();
    const handoverId = await handoverOf(w);
    const s = await signIn(w);
    const before = await events.latestId(w.tenantId);
    const taken = await controller.takeOver(
      handoverId,
      `key-${randomUUID()}`,
      await call(s),
    );
    expect(taken).toMatchObject({ status: 'ok', state: 'OPERATOR_ACTIVE' });
    const view = await read.view(s.principal, w.conversationId);
    expect(view?.conversation).toMatchObject({
      state: 'OPERATOR_ACTIVE',
      assignedOperatorId: w.operatorId,
    });
    const types = (await events.after(w.tenantId, before)).events.map(
      (e) => e.type,
    );
    expect(types).toContain('conversation.updated');
    const back = await controller.returnToBot(
      handoverId,
      `key-${randomUUID()}`,
      await call(s),
    );
    expect(back).toMatchObject({ status: 'ok' });
  });

  it('refuses a state-changing request without the CSRF token and changes nothing', async () => {
    const w = await world();
    const handoverId = await handoverOf(w);
    const s = await signIn(w);
    await expect(
      call({ cookie: s.cookie, csrf: 'wrong' }),
    ).rejects.toMatchObject({ status: 403 });
    const row = await db.conversation.findUnique({
      where: { id: w.conversationId },
    });
    expect(row?.state).toBe('WAITING_OPERATOR');
    expect(handoverId).toBeDefined();
  });

  it('refuses a viewer and another tenant’s handover', async () => {
    const viewer = await world('VIEWER');
    const handoverId = await handoverOf(viewer);
    const sv = await signIn(viewer);
    await expect(
      controller.takeOver(handoverId, `key-${randomUUID()}`, await call(sv)),
    ).rejects.toMatchObject({ status: 403 });

    const a = await world();
    const b = await world();
    const foreign = await handoverOf(b);
    const sa = await signIn(a);
    await expect(
      controller.takeOver(foreign, `key-${randomUUID()}`, await call(sa)),
    ).rejects.toMatchObject({ status: 404 });
    const untouched = await db.conversation.findUnique({
      where: { id: b.conversationId },
    });
    expect(untouched?.state).toBe('WAITING_OPERATOR');
  });
});

describe('search and filters', () => {
  it('finds by contact name, phone and message text, only inside the tenant', async () => {
    const a = await world();
    const b = await world();
    const sa = await signIn(a);
    const needle = `needle-${randomUUID().slice(0, 8)}`;
    for (const w of [a, b]) {
      await db.message.create({
        data: {
          tenantId: w.tenantId,
          conversationId: w.conversationId,
          channelAccountId: w.accountId,
          authorType: 'CUSTOMER',
          direction: 'INBOUND',
          text: `please call about ${needle}`,
          sequence: 1,
          providerChatId: 'c',
        },
      });
    }
    await db.contact.update({
      where: { id: a.contactId },
      data: { phone: '+998901112233' },
    });
    const byText = await read.list(sa.principal, {
      scope: 'all',
      q: needle.toUpperCase(),
    });
    expect(byText.items.map((i) => i.id)).toEqual([a.conversationId]);
    expect(
      (await read.list(sa.principal, { scope: 'all', q: '90111' })).items,
    ).toHaveLength(1);
    const name = (await db.contact.findUnique({ where: { id: a.contactId } }))!
      .name!;
    expect(
      (await read.list(sa.principal, { scope: 'all', q: name.toLowerCase() }))
        .items,
    ).toHaveLength(1);
    expect(
      (await read.list(sa.principal, { scope: 'all', q: 'zzz-no-match' }))
        .items,
    ).toEqual([]);
  });

  it('filters by language and lead score', async () => {
    const w = await world();
    const s = await signIn(w);
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { language: 'ru' },
    });
    await db.lead.create({
      data: {
        tenantId: w.tenantId,
        contactId: w.contactId,
        conversationId: w.conversationId,
        score: 'HOT',
        summary: 's',
        requirements: {},
        idempotencyKey: `lead-${randomUUID()}`,
      },
    });
    expect(
      (await read.list(s.principal, { scope: 'all', language: 'ru' })).items,
    ).toHaveLength(1);
    expect(
      (await read.list(s.principal, { scope: 'all', language: 'uz' })).items,
    ).toHaveLength(0);
    const hot = await read.list(s.principal, {
      scope: 'all',
      leadScore: 'HOT',
    });
    expect(hot.items[0]?.leadScore).toBe('HOT');
    expect(
      (await read.list(s.principal, { scope: 'all', leadScore: 'COLD' })).items,
    ).toHaveLength(0);
  });
});

describe('lead status command', () => {
  const controller = new OperatorCommandsController(
    new HandoverService(prisma),
  );
  const requestGuard = new OperatorRequestGuard(
    new OperatorTokenGuard(prisma),
    guard,
  );
  const as = async (s: { cookie: string; csrf: string }): Promise<never> => {
    const request = {
      method: 'POST',
      headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf },
    };
    await requestGuard.canActivate(context(request));
    return request as never;
  };

  it('changes the latest lead, audits once, is idempotent, and refuses viewers', async () => {
    const w = await world();
    const handover = await db.handover.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        reasonCode: 'X',
        summary: {},
      },
    });
    const s = await signIn(w);
    await expect(
      controller.leadStatus(
        handover.id,
        `k-${randomUUID()}`,
        { status: 'WON' },
        await as(s),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await db.lead.create({
      data: {
        tenantId: w.tenantId,
        contactId: w.contactId,
        conversationId: w.conversationId,
        score: 'WARM',
        summary: 's',
        requirements: {},
        idempotencyKey: `lead-${randomUUID()}`,
      },
    });
    const key = `k-${randomUUID()}`;
    expect(
      await controller.leadStatus(
        handover.id,
        key,
        { status: 'IN_PROGRESS' },
        await as(s),
      ),
    ).toMatchObject({ status: 'ok' });
    expect(
      await controller.leadStatus(
        handover.id,
        key,
        { status: 'IN_PROGRESS' },
        await as(s),
      ),
    ).toMatchObject({ status: 'duplicate' });
    expect(
      (await db.lead.findFirst({ where: { tenantId: w.tenantId } }))?.status,
    ).toBe('IN_PROGRESS');
    const audits = await db.auditEvent.count({
      where: { tenantId: w.tenantId, action: 'operator.set_lead_status' },
    });
    expect(audits).toBe(1);
    await expect(
      controller.leadStatus(
        handover.id,
        `k-${randomUUID()}`,
        { status: 'bogus' },
        await as(s),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const viewer = await world('VIEWER');
    const vh = await db.handover.create({
      data: {
        tenantId: viewer.tenantId,
        conversationId: viewer.conversationId,
        reasonCode: 'X',
        summary: {},
      },
    });
    const sv = await signIn(viewer);
    await expect(
      controller.leadStatus(
        vh.id,
        `k-${randomUUID()}`,
        { status: 'WON' },
        await as(sv),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('never touches another tenant’s lead', async () => {
    const a = await world();
    const b = await world();
    const bh = await db.handover.create({
      data: {
        tenantId: b.tenantId,
        conversationId: b.conversationId,
        reasonCode: 'X',
        summary: {},
      },
    });
    const sa = await signIn(a);
    await expect(
      controller.leadStatus(
        bh.id,
        `k-${randomUUID()}`,
        { status: 'LOST' },
        await as(sa),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('login cookies', () => {
  it('sets an httpOnly session cookie and a readable CSRF cookie, and clears both on logout', async () => {
    const w = await world();
    const controller = new AuthController(sessions, prisma, {
      get: (key: string) =>
        key === 'SESSION_COOKIE_SECURE' ? true : undefined,
    } as never);
    const headers: Record<string, string | string[]> = {};
    const reply = {
      setHeader: (n: string, v: string | string[]): void =>
        void (headers[n] = v),
    };
    const body = (await controller.login(
      { email: w.email, password: 'correct horse' },
      {
        headers: {},
        socket: {
          remoteAddress: nextPeer(),
        },
      },
      reply,
    )) as { csrfToken: string };
    const cookies = headers['Set-Cookie'] as string[];
    expect(cookies[0]).toMatch(
      /^ac_session=.+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/u,
    );
    expect(cookies[1]).toBe(
      `ac_csrf=${body.csrfToken}; ${cookies[1].split('; ').slice(1).join('; ')}`,
    );
    expect(cookies[1]).not.toContain('HttpOnly');
    expect(cookies[1]).toContain('SameSite=Strict');
  });

  it('rate-limits login attempts per address and answers bad bodies as invalid credentials', async () => {
    const controller = new AuthController(sessions, prisma, {
      get: () => false,
    } as never);
    const reply = { setHeader: (): void => undefined };
    const ip = {
      headers: {},
      socket: {
        remoteAddress: nextPeer(),
      },
    };
    await expect(
      controller.login({ nope: 1 }, ip, reply),
    ).rejects.toMatchObject({ status: 401 });
    let last: unknown;
    for (let i = 0; i < 25; i += 1)
      last = await controller
        .login({ email: 'x@y.test', password: 'p' }, ip, reply)
        .catch((e: unknown) => e);
    expect(last).toMatchObject({ status: 429 });
  });
});

describe('inbox event bus', () => {
  it('issues one query per tick for any number of listeners and delivers per tenant', async () => {
    const a = await world();
    const b = await world();
    const bus = new InboxEventBus(prisma);
    const gotA1: BusEvent[] = [];
    const gotA2: BusEvent[] = [];
    const gotB: BusEvent[] = [];
    const offA1 = await bus.subscribe(a.tenantId, (e) => gotA1.push(e));
    const offA2 = await bus.subscribe(a.tenantId, (e) => gotA2.push(e));
    const offB = await bus.subscribe(b.tenantId, (e) => gotB.push(e));
    await db.conversation.update({
      where: { id: a.conversationId },
      data: { state: 'CLOSED' },
    });
    const calls: string[] = [];
    const original = prisma.inboxEvent.findMany.bind(prisma.inboxEvent);
    (prisma.inboxEvent as { findMany: unknown }).findMany = (
      ...args: Parameters<typeof original>
    ): ReturnType<typeof original> => {
      calls.push('findMany');
      return original(...args);
    };
    try {
      await bus.tick();
    } finally {
      (prisma.inboxEvent as { findMany: unknown }).findMany = original;
    }
    expect(calls).toHaveLength(1);
    expect(gotA1.map((e) => e.type)).toEqual(['conversation.updated']);
    expect(gotA2).toHaveLength(1);
    expect(gotB).toEqual([]);
    await bus.tick();
    expect(gotA1).toHaveLength(1);
    offA1();
    offA2();
    offB();
    bus.onModuleDestroy();
  });

  it('a throwing listener does not stop the others, and events before subscribe are not replayed', async () => {
    const w = await world();
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { state: 'CLOSED' },
    });
    const bus = new InboxEventBus(prisma);
    const got: BusEvent[] = [];
    const off1 = await bus.subscribe(w.tenantId, () => {
      throw new Error('boom');
    });
    const off2 = await bus.subscribe(w.tenantId, (e) => got.push(e));
    await bus.tick();
    expect(got).toEqual([]);
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { state: 'BOT_ACTIVE' },
    });
    await bus.tick();
    expect(got).toHaveLength(1);
    off1();
    off2();
    bus.onModuleDestroy();
  });
});

describe('event stream resource accounting', () => {
  class FakeResponse extends EventEmitter {
    status = 0;
    frames: string[] = [];
    constructor(private readonly closeOnHead = false) {
      super();
    }
    writeHead(status: number): void {
      this.status = status;
      // Simulates a client that disconnects while the stream is being set up.
      if (this.closeOnHead) this.emit('close');
    }
    write(chunk: string): boolean {
      this.frames.push(chunk);
      return true;
    }
    end(): void {
      this.emit('close');
    }
  }

  function controllerWith(bus: InboxEventBus): EventsController {
    return new EventsController(events, bus, { get: () => 60_000 } as never);
  }

  it('releases the slot, subscription and timers of a client that leaves during setup', async () => {
    const w = await world();
    const s = await signIn(w);
    const bus = new InboxEventBus(prisma);
    const controller = controllerWith(bus);
    for (let i = 0; i < 7; i += 1) {
      const response = new FakeResponse(true);
      await controller.stream(
        { principal: s.principal } as never,
        response as never,
        undefined,
        undefined,
      );
    }
    expect(openStreams(w.tenantId, w.operatorId)).toBe(0);
    expect(bus.listenerCount(w.tenantId)).toBe(0);
    // The operator can still open a stream: no slot was leaked.
    const live = new FakeResponse();
    await controller.stream(
      { principal: s.principal } as never,
      live as never,
      undefined,
      undefined,
    );
    expect(live.status).toBe(200);
    expect(openStreams(w.tenantId, w.operatorId)).toBe(1);
    expect(bus.listenerCount(w.tenantId)).toBe(1);
    live.emit('close');
    live.emit('close');
    expect(openStreams(w.tenantId, w.operatorId)).toBe(0);
    expect(bus.listenerCount(w.tenantId)).toBe(0);
    bus.onModuleDestroy();
  });

  it('limits concurrent streams per operator and frees them on close', async () => {
    const w = await world();
    const s = await signIn(w);
    const bus = new InboxEventBus(prisma);
    const controller = controllerWith(bus);
    const streams: FakeResponse[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = new FakeResponse();
      await controller.stream(
        { principal: s.principal } as never,
        response as never,
        undefined,
        undefined,
      );
      streams.push(response);
    }
    const sixth = new FakeResponse();
    await controller.stream(
      { principal: s.principal } as never,
      sixth as never,
      undefined,
      undefined,
    );
    expect(sixth.status).toBe(429);
    streams[0].emit('close');
    const again = new FakeResponse();
    await controller.stream(
      { principal: s.principal } as never,
      again as never,
      undefined,
      undefined,
    );
    expect(again.status).toBe(200);
    for (const response of [...streams, again]) response.emit('close');
    expect(openStreams(w.tenantId, w.operatorId)).toBe(0);
    bus.onModuleDestroy();
  });
});

describe('channels list', () => {
  it('shows only the own tenant accounts and never a key, credential or chat id', async () => {
    const a = await world();
    const b = await world();
    await db.channelAccount.update({
      where: { id: a.accountId },
      data: {
        credentialRef: 'env:SECRET_TOKEN_NAME',
        webhookSecretRef: 'env:SECRET_HOOK_NAME',
        operatorChatId: '-100123',
      },
    });
    const store = new PrismaChannelSecretStore(
      prisma,
      new SecretCipher(
        createKeyring({
          SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
        }),
      ),
    );
    const owner = { tenantId: a.tenantId, channelAccountId: a.accountId };
    await store.put(owner, 'bot_token', 'PLAINTEXT_BOT_TOKEN');
    await store.put(owner, 'webhook_secret', 'PLAINTEXT_HOOK_SECRET');
    const s = await signIn(a);
    const result = await channelsController().list({
      principal: s.principal,
    } as never);
    expect(result.items.map((item) => item.id)).toEqual([a.accountId]);
    expect(result.items[0]).toMatchObject({
      channelType: 'telegram',
      status: 'ACTIVE',
      credentialSource: 'ui',
      credentialsConfigured: true,
      operatorGroupConfigured: true,
    });
    const text = JSON.stringify(result);
    for (const secret of [
      'SECRET_TOKEN_NAME',
      'SECRET_HOOK_NAME',
      '-100123',
      'PLAINTEXT_BOT_TOKEN',
      'PLAINTEXT_HOOK_SECRET',
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toContain(b.accountId);
  });
});

function channelsController(
  overrides: Record<string, unknown> = {},
): ChannelsController {
  const settings: Record<string, unknown> = {
    NODE_ENV: 'development',
    LLM_PROVIDER: 'mock',
    LLM_TRUSTED_PROVIDERS: ['mock'],
    LLM_ALLOW_REAL_CUSTOMER_DATA: false,
    ...overrides,
  };
  return new ChannelsController(prisma, {
    get: (key: string) => settings[key],
  } as never);
}

describe('assistant mode', () => {
  it('only an owner or admin may change it; the change is checked, scoped and audited', async () => {
    const op = await world('OPERATOR');
    const admin = await world('ADMIN');
    const other = await world('ADMIN');
    const asOp = await signIn(op);
    const asAdmin = await signIn(admin);
    const controller = channelsController();
    await expect(
      controller.setMode({ principal: asOp.principal } as never, op.accountId, {
        mode: 'SHADOW',
      }),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    await expect(
      controller.setMode(
        { principal: asAdmin.principal } as never,
        other.accountId,
        { mode: 'SHADOW' },
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    await expect(
      controller.setMode(
        { principal: asAdmin.principal } as never,
        admin.accountId,
        { mode: 'ON' },
      ),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BODY' } });
    const changed = await controller.setMode(
      { principal: asAdmin.principal } as never,
      admin.accountId,
      { mode: 'LIVE' },
    );
    expect(changed.agentMode).toBe('LIVE');
    const row = await db.channelAccount.findUniqueOrThrow({
      where: { id: admin.accountId },
    });
    expect(row.agentMode).toBe('LIVE');
    const audit = await db.auditEvent.findMany({
      where: { tenantId: admin.tenantId, action: 'channel.agent_mode_changed' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].safeInputSummary).toEqual({ from: 'OFF', to: 'LIVE' });
    expect(
      (
        await db.channelAccount.findUniqueOrThrow({
          where: { id: other.accountId },
        })
      ).agentMode,
    ).toBe('OFF');
  });

  it('refuses a mode the policy forbids and says why, in the list too', async () => {
    const w = await world('ADMIN');
    const s = await signIn(w);
    const production = channelsController({ NODE_ENV: 'production' });
    await expect(
      production.setMode({ principal: s.principal } as never, w.accountId, {
        mode: 'LIVE',
      }),
    ).rejects.toMatchObject({
      response: { code: 'MODE_REFUSED', reason: 'NO_OPERATOR_NOTIFIER' },
    });
    const untrusted = channelsController({
      LLM_PROVIDER: 'gemini',
      LLM_TRUSTED_PROVIDERS: ['mock'],
    });
    const listed = await untrusted.list({ principal: s.principal } as never);
    expect(listed.items[0].modeRefusals).toEqual({
      LIVE: 'UNTRUSTED_PROVIDER',
      SHADOW: 'UNTRUSTED_REAL_DATA',
    });
    expect(
      (
        await db.channelAccount.findUniqueOrThrow({
          where: { id: w.accountId },
        })
      ).agentMode,
    ).toBe('OFF');
    // Turning the assistant off is always allowed.
    const off = await untrusted.setMode(
      { principal: s.principal } as never,
      w.accountId,
      { mode: 'OFF' },
    );
    expect(off.agentMode).toBe('OFF');
  });
});

describe('FAQ knowledge', () => {
  const faqController = (enabled = true): KnowledgeFaqController =>
    new KnowledgeFaqController(
      prisma,
      new KnowledgeService(prisma),
      enabled ? new HashingEmbeddingProvider() : undefined,
    );
  const entry = {
    question: '  How   long is the   course? ',
    answer: 'Three months,\n  two evenings a week.',
    language: 'en' as const,
    regulated: false,
    confirmProviderMayReadText: true as const,
  };

  it('creates, reads back exactly, updates and withdraws an entry, per tenant, with audit', async () => {
    const a = await world('ADMIN');
    const b = await world('ADMIN');
    const sa = await signIn(a);
    const sb = await signIn(b);
    const controller = faqController();
    const { id } = await controller.create(
      { principal: sa.principal } as never,
      entry,
    );
    let listed = await controller.list({ principal: sa.principal } as never);
    expect(listed.embeddingsConfigured).toBe(true);
    expect(listed.items).toMatchObject([
      {
        id,
        question: 'How long is the course?',
        answer: 'Three months, two evenings a week.',
        language: 'en',
        regulated: false,
      },
    ]);
    expect(
      (await controller.list({ principal: sb.principal } as never)).items,
    ).toEqual([]);
    await expect(
      controller.update({ principal: sb.principal } as never, id, entry),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    await controller.update({ principal: sa.principal } as never, id, {
      ...entry,
      answer: 'Four months.',
    });
    listed = await controller.list({ principal: sa.principal } as never);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].answer).toBe('Four months.');
    await controller.remove({ principal: sa.principal } as never, id);
    expect(
      (await controller.list({ principal: sa.principal } as never)).items,
    ).toEqual([]);
    const actions = (
      await db.auditEvent.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.action);
    expect(actions).toEqual([
      'knowledge.faq_created',
      'knowledge.faq_updated',
      'knowledge.faq_deleted',
    ]);
  });

  it('refuses writers without the role, missing consent, oversize text and a missing embedder', async () => {
    const op = await world('OPERATOR');
    const admin = await world('ADMIN');
    const asOp = await signIn(op);
    const asAdmin = await signIn(admin);
    const controller = faqController();
    await expect(
      controller.create({ principal: asOp.principal } as never, entry),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    // Operators may read.
    await expect(
      controller.list({ principal: asOp.principal } as never),
    ).resolves.toMatchObject({ items: [] });
    for (const bad of [
      { ...entry, confirmProviderMayReadText: false },
      { ...entry, answer: 'x'.repeat(601) },
      { ...entry, question: 'ab' },
    ])
      await expect(
        controller.create({ principal: asAdmin.principal } as never, bad),
      ).rejects.toMatchObject({ response: { code: 'INVALID_BODY' } });
    await expect(
      faqController(false).create(
        { principal: asAdmin.principal } as never,
        entry,
      ),
    ).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_DISABLED' } });
    expect(
      (await controller.list({ principal: asAdmin.principal } as never)).items,
    ).toEqual([]);
  });
});

describe('contacts list', () => {
  it('lists only the own tenant, hides erased contacts and internals, searches and pages', async () => {
    const a = await world();
    const b = await world();
    for (let i = 0; i < 3; i += 1)
      await db.contact.create({
        data: {
          tenantId: a.tenantId,
          channelAccountId: a.accountId,
          providerUserId: `extra-${i}-${randomUUID()}`,
          name: `Zed ${i}`,
          phone: `+99890000000${i}`,
        },
      });
    await db.contact.create({
      data: {
        tenantId: a.tenantId,
        channelAccountId: a.accountId,
        providerUserId: `gone-${randomUUID()}`,
        name: 'Zed erased',
        deletedAt: new Date(),
      },
    });
    const s = await signIn(a);
    const controller = new ContactsController(prisma);
    const request = { principal: s.principal } as never;
    const first = await controller.list(request, { limit: '2' });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await controller.list(request, {
      limit: '2',
      cursor: first.nextCursor!,
    });
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = await controller.list(request, { limit: '50' });
    expect(all.items).toHaveLength(4);
    expect(all.items.map((item) => item.name)).not.toContain('Zed erased');
    expect(JSON.stringify(all)).not.toContain('providerUserId');
    expect(all.items.find((item) => item.id === w(a))?.conversationCount).toBe(
      1,
    );
    const found = await controller.list(request, { q: 'zed 1' });
    expect(found.items.map((item) => item.name)).toEqual(['Zed 1']);
    const byPhone = await controller.list(request, { q: '900000002' });
    expect(byPhone.items.map((item) => item.name)).toEqual(['Zed 2']);
    const other = await controller.list(
      { principal: (await signIn(b)).principal } as never,
      { q: 'Zed' },
    );
    expect(other.items).toEqual([]);
    await expect(
      controller.list(request, { cursor: 'not-a-uuid' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_QUERY' } });
  });
});

/** The fixture contact of a world. */
const w = (world_: World): string => world_.contactId;
