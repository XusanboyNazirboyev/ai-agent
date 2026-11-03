import { config as loadEnv } from 'dotenv';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { InstagramGraphClient } from '../channels/instagram/instagram-graph.js';
import {
  InstagramOAuthClient,
  STATE_TTL_MS,
} from '../channels/instagram/instagram-oauth.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PrismaChannelSecretStore } from '../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { InstagramConnectController } from './instagram-connect.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Instagram connect tests require agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => db.$disconnect());

/** Fake values only; no real Meta credential is used. */
/** Generated per run: never real or credential-shaped literals. */
const TOKEN = `test-${randomBytes(16).toString('hex')}`;
const WRONG_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const USERNAME = 'demo_shop';
/** Fictional professional-account ids look like real ones: digits only. */
const IG_ID_PREFIX = '1784';
/** Meta error code for an expired or invalid token (graph-api error handling). */
const META_TOKEN_EXPIRED = 190;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
/** The controller accepts 20 to 2,048 non-space characters. */
const TOKEN_MIN = 20;
const TOKEN_MAX = 2_048;
/** Business Login fakes: a code, the short-lived token it buys, a code without messaging. */
const CODE = `code-${randomBytes(12).toString('hex')}`;
const NO_MESSAGES_CODE = `code-${randomBytes(12).toString('hex')}`;
const SHORT_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const SCOPES = 'instagram_business_basic,instagram_business_manage_messages';
const LONG_LIVED_SECONDS = 5_184_000;
const OAUTH = {
  INSTAGRAM_APP_ID: String(randomInt(10 ** 9, 10 ** 10 - 1)),
  INSTAGRAM_OAUTH_REDIRECT_URI:
    'https://app.example.test/channels/instagram/callback',
  INSTAGRAM_OAUTH_BASE_URL: 'https://oauth.example.test',
};
const SETTINGS: Record<string, unknown> = {
  NODE_ENV: 'development',
  LLM_PROVIDER: 'mock',
  LLM_TRUSTED_PROVIDERS: ['mock'],
  LLM_ALLOW_REAL_CUSTOMER_DATA: false,
  INSTAGRAM_APP_SECRET: randomBytes(16).toString('hex'),
  INSTAGRAM_VERIFY_TOKEN: randomBytes(16).toString('hex'),
};

async function tenant(
  role: 'ADMIN' | 'OPERATOR' = 'ADMIN',
): Promise<{ tenantId: string; request: never }> {
  const created = await db.tenant.create({
    data: {
      slug: `ig-connect-${randomUUID()}`,
      name: 'Instagram connect fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const operator = await db.operator.create({
    data: { tenantId: created.id, displayName: 'Admin', role },
  });
  return {
    tenantId: created.id,
    request: {
      principal: {
        tenantId: created.id,
        operatorId: operator.id,
        role,
        sessionId: randomUUID(),
      },
    } as never,
  };
}

interface Setup {
  readonly igUserId: string;
  readonly calls: { url: URL; method: string }[];
  readonly store: PrismaChannelSecretStore;
  readonly controller: InstagramConnectController;
  readonly oauth: InstagramOAuthClient;
  readonly bodies: string[];
  readonly setMe: (reply: { status: number; body: unknown }) => void;
}

/** A fake graph.instagram.com: one account behind TOKEN. */
function setup(overrides: Record<string, unknown> = {}): Setup {
  const igUserId = `${IG_ID_PREFIX}${randomInt(10 ** 9, 10 ** 10 - 1)}`;
  const calls: { url: URL; method: string }[] = [];
  const bodies: string[] = [];
  let meReply: { status: number; body: unknown } = {
    status: HTTP_OK,
    body: { user_id: igUserId, username: USERNAME },
  };
  const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, method: init?.method ?? 'GET' });
    if (parsed.pathname === '/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      bodies.push(String(init?.body ?? ''));
      const code = form.get('code');
      if (code !== CODE && code !== NO_MESSAGES_CODE)
        return new Response(
          JSON.stringify({ error_type: 'OAuthException', code: 400 }),
          { status: HTTP_BAD_REQUEST },
        );
      return new Response(
        JSON.stringify({
          data: [
            {
              access_token: SHORT_TOKEN,
              user_id: igUserId,
              permissions: code === CODE ? SCOPES : 'instagram_business_basic',
            },
          ],
        }),
        { status: HTTP_OK },
      );
    }
    if (
      parsed.pathname === '/access_token' &&
      parsed.searchParams.get('grant_type') === 'ig_exchange_token' &&
      parsed.searchParams.get('access_token') === SHORT_TOKEN
    )
      return new Response(
        JSON.stringify({
          access_token: TOKEN,
          token_type: 'bearer',
          expires_in: LONG_LIVED_SECONDS,
        }),
        { status: HTTP_OK },
      );
    if (parsed.searchParams.get('access_token') !== TOKEN)
      return new Response(
        JSON.stringify({ error: { code: META_TOKEN_EXPIRED } }),
        { status: HTTP_BAD_REQUEST },
      );
    if (parsed.pathname.endsWith('/me'))
      return new Response(JSON.stringify(meReply.body), {
        status: meReply.status,
      });
    if (parsed.pathname.endsWith('/subscribed_apps'))
      return new Response(JSON.stringify({ success: true }), {
        status: HTTP_OK,
      });
    return new Response('{}', { status: HTTP_NOT_FOUND });
  });
  const cipher = new SecretCipher(
    createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
  );
  const store = new PrismaChannelSecretStore(prisma, cipher);
  const values = { ...SETTINGS, ...overrides };
  const config = { get: (key: string) => values[key] } as never;
  const oauth = new InstagramOAuthClient(
    config,
    cipher,
    request as unknown as typeof fetch,
  );
  const controller = new InstagramConnectController(
    prisma,
    config,
    store,
    new InstagramGraphClient(request as unknown as typeof fetch),
    oauth,
  );
  return {
    igUserId,
    calls,
    store,
    controller,
    oauth,
    bodies,
    setMe: (reply: typeof meReply): void => {
      meReply = reply;
    },
  };
}

describe('connecting an Instagram professional account from the web API', () => {
  it.each([
    ['a missing token', {}],
    ['a null token', { accessToken: null }],
    ['an empty token', { accessToken: '' }],
    ['a token with a space', { accessToken: `${TOKEN} x` }],
    [
      'one character under the minimum',
      { accessToken: 'a'.repeat(TOKEN_MIN - 1) },
    ],
    [
      'one character over the maximum',
      { accessToken: 'a'.repeat(TOKEN_MAX + 1) },
    ],
    ['a body that is not an object', null],
  ])('refuses %s before calling Meta', async (_label, body) => {
    const s = setup();
    const t = await tenant();
    await expect(s.controller.connect(t.request, body)).rejects.toMatchObject({
      response: { code: 'INVALID_BODY' },
    });
    expect(s.calls).toHaveLength(0);
  });

  it.each([TOKEN_MIN, TOKEN_MAX])(
    'accepts a token of exactly %i characters (sent on to Meta)',
    async (length) => {
      const s = setup();
      const t = await tenant();
      // Meta refuses the made-up token; the point is that it got past validation.
      await expect(
        s.controller.connect(t.request, { accessToken: 'a'.repeat(length) }),
      ).rejects.toMatchObject({ response: { code: 'INSTAGRAM_REJECTED' } });
      expect(s.calls).toHaveLength(1);
    },
  );

  it('validates the token with /me, stores it encrypted and starts DISABLED; enable subscribes messages', async () => {
    const s = setup();
    const t = await tenant();
    const connected = await s.controller.connect(t.request, {
      accessToken: TOKEN,
    });
    expect(connected).toMatchObject({
      channelType: 'instagram',
      displayName: `@${USERNAME}`,
      status: 'DISABLED',
      agentMode: 'OFF',
      credentialSource: 'ui',
      credentialsConfigured: true,
    });
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    const row = await db.channelAccount.findUniqueOrThrow({
      where: { id: connected.id },
    });
    expect(row).toMatchObject({
      tenantId: t.tenantId,
      externalAccountId: s.igUserId,
    });
    const owner = { tenantId: t.tenantId, channelAccountId: row.id };
    expect(await s.store.get(owner, 'instagram_access_token')).toBe(TOKEN);
    const secret = await db.channelSecret.findFirstOrThrow({
      where: { channelAccountId: row.id },
    });
    expect(Buffer.from(secret.ciphertext).toString('utf8')).not.toContain(
      TOKEN,
    );

    const enabled = await s.controller.enable(t.request, row.id);
    expect(enabled.status).toBe('ACTIVE');
    const subscribe = s.calls.find((c) =>
      c.url.pathname.endsWith('/subscribed_apps'),
    )!;
    expect(subscribe.method).toBe('POST');
    expect(subscribe.url.pathname).toBe(`/v26.0/${s.igUserId}/subscribed_apps`);
    expect(subscribe.url.searchParams.get('subscribed_fields')).toBe(
      'messages',
    );

    const disabled = await s.controller.disable(t.request, row.id);
    expect(disabled).toMatchObject({ status: 'DISABLED', agentMode: 'OFF' });

    const audits = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'channel.instagram_connected',
      'channel.instagram_enabled',
      'channel.instagram_disabled',
    ]);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('refuses a token Meta rejects, an invalid body and the operator role, storing nothing', async () => {
    const s = setup();
    const t = await tenant();
    await expect(
      s.controller.connect(t.request, {
        accessToken: WRONG_TOKEN,
      }),
    ).rejects.toMatchObject({ response: { code: 'INSTAGRAM_REJECTED' } });
    await expect(
      s.controller.connect(t.request, { accessToken: 'short' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BODY' } });
    // /me without a numeric user_id, with a null body, or with no JSON at all.
    for (const body of [{ username: USERNAME }, null, 'not json']) {
      s.setMe({ status: HTTP_OK, body });
      await expect(
        s.controller.connect(t.request, { accessToken: TOKEN }),
      ).rejects.toMatchObject({ response: { code: 'INSTAGRAM_REJECTED' } });
    }
    const op = await tenant('OPERATOR');
    await expect(
      s.controller.connect(op.request, { accessToken: TOKEN }),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    expect(
      await db.channelAccount.count({
        where: { tenantId: { in: [t.tenantId, op.tenantId] } },
      }),
    ).toBe(0);
  });

  it("refuses an account another tenant already connected and keeps the other tenant's data", async () => {
    const s = setup();
    const a = await tenant();
    const b = await tenant();
    const first = await s.controller.connect(a.request, {
      accessToken: TOKEN,
    });
    await expect(
      s.controller.connect(b.request, { accessToken: TOKEN }),
    ).rejects.toMatchObject({ response: { code: 'ALREADY_CONNECTED' } });
    await expect(
      s.controller.enable(b.request, first.id),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    // The same tenant may reconnect (new token, same account).
    const again = await s.controller.connect(a.request, {
      accessToken: TOKEN,
    });
    expect(again.id).toBe(first.id);
  });

  it('refuses to enable without the app secret and verify token on the server', async () => {
    const s = setup({ INSTAGRAM_APP_SECRET: undefined });
    const t = await tenant();
    const { id } = await s.controller.connect(t.request, {
      accessToken: TOKEN,
    });
    await expect(s.controller.enable(t.request, id)).rejects.toMatchObject({
      response: { code: 'WEBHOOK_NOT_CONFIGURED' },
    });
    expect(
      s.calls.some((c) => c.url.pathname.endsWith('/subscribed_apps')),
    ).toBe(false);
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('DISABLED');
  });
});

describe('Business Login for Instagram (oauth/start, oauth/complete)', () => {
  const principalOf = (
    request: never,
  ): { tenantId: string; operatorId: string; sessionId: string } =>
    (
      request as {
        principal: { tenantId: string; operatorId: string; sessionId: string };
      }
    ).principal;

  it('reports whether OAuth is set up; start refuses without it', async () => {
    const off = setup();
    const t = await tenant();
    expect(off.controller.setup(t.request)).toEqual({ oauth: false });
    expect(() => off.controller.start(t.request)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'OAUTH_NOT_CONFIGURED' }),
      }),
    );
    expect(setup(OAUTH).controller.setup(t.request)).toEqual({ oauth: true });
  });

  it('start builds the authorization URL with both scopes and a state, calling nobody', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const { url } = s.controller.start(t.request);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'https://oauth.example.test/oauth/authorize',
    );
    expect(parsed.searchParams.get('client_id')).toBe(OAUTH.INSTAGRAM_APP_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      OAUTH.INSTAGRAM_OAUTH_REDIRECT_URI,
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe(SCOPES);
    expect(parsed.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+$/u);
    // The state is sealed: no tenant, operator or session id is readable in it.
    const state = parsed.searchParams.get('state')!;
    const plain = Buffer.from(state, 'base64url').toString('utf8');
    expect(plain).not.toContain(principalOf(t.request).tenantId);
    expect(plain).not.toContain(principalOf(t.request).sessionId);
    expect(s.calls).toHaveLength(0);
  });

  it('complete exchanges the code for a long-lived token, stores it and starts DISABLED', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const state = new URL(s.controller.start(t.request).url).searchParams.get(
      'state',
    )!;
    const connected = await s.controller.complete(t.request, {
      code: CODE,
      state,
    });
    expect(connected).toMatchObject({
      channelType: 'instagram',
      displayName: `@${USERNAME}`,
      status: 'DISABLED',
      agentMode: 'OFF',
    });
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    expect(
      await s.store.get(
        { tenantId: t.tenantId, channelAccountId: connected.id },
        'instagram_access_token',
      ),
    ).toBe(TOKEN);
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /oauth/access_token',
      'GET /access_token',
      'GET /v26.0/me',
    ]);
    const form = new URLSearchParams(s.bodies[0]);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(OAUTH.INSTAGRAM_OAUTH_REDIRECT_URI);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: t.tenantId, action: 'channel.instagram_connected' },
    });
    expect(audit.safeInputSummary).toMatchObject({ via: 'oauth' });
    expect(JSON.stringify(audit.safeInputSummary)).not.toContain(TOKEN);
  });

  it('refuses a state from another session, a tampered state and an expired one, before calling Meta', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const me = principalOf(t.request);
    const otherSession = s.oauth.state({ ...me, sessionId: randomUUID() });
    const expired = s.oauth.state(me, Date.now() - STATE_TTL_MS - 1);
    const good = s.oauth.state(me);
    const tampered = `${good.slice(0, -2)}${good.endsWith('A') ? 'B' : 'A'}${good.slice(-1)}`;
    for (const state of [otherSession, expired, tampered, 'not-a-state'])
      await expect(
        s.controller.complete(t.request, { code: CODE, state }),
      ).rejects.toMatchObject({ response: { code: 'OAUTH_STATE_INVALID' } });
    expect(s.calls).toHaveLength(0);
  });

  it('refuses an authorization without the messaging permission and stores nothing', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    await expect(
      s.controller.complete(t.request, {
        code: NO_MESSAGES_CODE,
        state: s.oauth.state(principalOf(t.request)),
      }),
    ).rejects.toMatchObject({ response: { code: 'MISSING_PERMISSIONS' } });
    expect(
      await db.channelAccount.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it('maps a code Instagram refuses to INSTAGRAM_REJECTED', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    await expect(
      s.controller.complete(t.request, {
        code: `code-${randomBytes(12).toString('hex')}`,
        state: s.oauth.state(principalOf(t.request)),
      }),
    ).rejects.toMatchObject({ response: { code: 'INSTAGRAM_REJECTED' } });
  });

  it('is for owners and admins only', async () => {
    const s = setup(OAUTH);
    const t = await tenant('OPERATOR');
    expect(() => s.controller.start(t.request)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
