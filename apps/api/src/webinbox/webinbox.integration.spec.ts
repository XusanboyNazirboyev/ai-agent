import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
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

async function world(role: 'OPERATOR' | 'VIEWER' = 'OPERATOR'): Promise<World> {
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
