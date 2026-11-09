import { config as loadEnv } from 'dotenv';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { InstagramGraphClient } from '../channels/instagram/instagram-graph.js';
import {
  InstagramOAuthClient,
  STATE_TTL_MS,
} from '../channels/instagram/instagram-oauth.js';
import {
  OAuthStateLedger,
  OAuthStateLedgerUnavailableError,
  RedisOAuthStateLedger,
} from '../channels/instagram/instagram-oauth-state-ledger.js';
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
const redisConfig = {
  get: () => process.env.REDIS_URL ?? 'redis://localhost:6379',
} as never;
const ledgers: RedisOAuthStateLedger[] = [];
afterAll(async () => {
  await Promise.all(ledgers.map((l) => l.onModuleDestroy()));
  await db.$disconnect();
});

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
/** Unified login fakes: codes, the system-user token each buys, the configuration. */
const CODE = `code-${randomBytes(12).toString('hex')}`;
const NO_ACCOUNT_CODE = `code-${randomBytes(12).toString('hex')}`;
const TWO_ACCOUNTS_CODE = `code-${randomBytes(12).toString('hex')}`;
const SYSTEM_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const META_BAD_PARAMETER = 100;
const OAUTH = {
  INSTAGRAM_APP_ID: String(randomInt(10 ** 9, 10 ** 10 - 1)),
  INSTAGRAM_LOGIN_CONFIG_ID: String(randomInt(10 ** 9, 10 ** 10 - 1)),
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
  readonly calls: { url: URL; method: string; body: string }[];
  readonly store: PrismaChannelSecretStore;
  readonly controller: InstagramConnectController;
  readonly oauth: InstagramOAuthClient;
  readonly setMe: (reply: { status: number; body: unknown }) => void;
}

/** Single-use states in memory; `down` makes it unreachable. */
class MemoryLedger extends OAuthStateLedger {
  readonly spent = new Set<string>();
  down = false;
  async consume(state: string): Promise<boolean> {
    if (this.down) throw new OAuthStateLedgerUnavailableError();
    if (this.spent.has(state)) return false;
    this.spent.add(state);
    return true;
  }
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

/**
 * A strict fake Meta. graph.facebook.com answers only the Unified login
 * contract (exact method, path and parameters); graph.instagram.com answers
 * the pasted-token path. Anything else, including the retired
 * instagram.com / api.instagram.com endpoints, is a 404.
 */
function setup(
  overrides: Record<string, unknown> = {},
  ledger: OAuthStateLedger = new MemoryLedger(),
  igUserId = `${IG_ID_PREFIX}${randomInt(10 ** 9, 10 ** 10 - 1)}`,
): Setup {
  const calls: { url: URL; method: string; body: string }[] = [];
  let meReply: { status: number; body: unknown } = {
    status: HTTP_OK,
    body: { user_id: igUserId, username: USERNAME },
  };
  const codes = [CODE, NO_ACCOUNT_CODE, TWO_ACCOUNTS_CODE];
  const tokenOf = (code: string): string =>
    `${SYSTEM_TOKEN}-${codes.indexOf(code)}`;
  const accountsOf = new Map<string, unknown[]>([
    [tokenOf(CODE), [{ id: igUserId, username: USERNAME }]],
    [tokenOf(NO_ACCOUNT_CODE), []],
    [
      tokenOf(TWO_ACCOUNTS_CODE),
      [
        { id: igUserId, username: USERNAME },
        { id: `${IG_ID_PREFIX}1`, username: 'other_shop' },
      ],
    ],
  ]);
  const values = { ...SETTINGS, ...overrides };
  const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    calls.push({ url: parsed, method, body });
    const q = parsed.searchParams;
    if (parsed.hostname === 'graph.facebook.com') {
      if (method === 'GET' && parsed.pathname === '/v27.0/oauth/access_token') {
        const code = q.get('code');
        if (
          q.get('client_id') !== values.INSTAGRAM_APP_ID ||
          q.get('client_secret') !== values.INSTAGRAM_APP_SECRET ||
          q.get('redirect_uri') !== values.INSTAGRAM_OAUTH_REDIRECT_URI ||
          !code ||
          !codes.includes(code)
        )
          return reply(HTTP_BAD_REQUEST, {
            error: { code: META_BAD_PARAMETER, message: 'detail' },
          });
        return reply(HTTP_OK, {
          access_token: tokenOf(code),
          token_type: 'bearer',
        });
      }
      if (
        method === 'GET' &&
        parsed.pathname === '/v27.0/me/assigned_instagram_accounts' &&
        q.get('fields') === 'id,username'
      ) {
        const data = accountsOf.get(q.get('access_token') ?? '');
        return data
          ? reply(HTTP_OK, { data })
          : reply(HTTP_BAD_REQUEST, { error: { code: META_TOKEN_EXPIRED } });
      }
      if (
        method === 'POST' &&
        parsed.pathname === `/v27.0/${igUserId}/subscribed_apps`
      ) {
        const form = new URLSearchParams(body);
        return form.get('access_token') === tokenOf(CODE) &&
          form.get('subscribed_fields') === 'messages,messaging_postbacks'
          ? reply(HTTP_OK, { success: true })
          : reply(HTTP_BAD_REQUEST, { error: { code: META_TOKEN_EXPIRED } });
      }
      return reply(HTTP_NOT_FOUND, {});
    }
    if (parsed.hostname === 'graph.instagram.com') {
      if (q.get('access_token') !== TOKEN)
        return reply(HTTP_BAD_REQUEST, { error: { code: META_TOKEN_EXPIRED } });
      if (parsed.pathname === '/v26.0/me')
        return reply(meReply.status, meReply.body);
      if (parsed.pathname === `/v26.0/${igUserId}/subscribed_apps`)
        return reply(HTTP_OK, { success: true });
    }
    return reply(HTTP_NOT_FOUND, {});
  });
  const cipher = new SecretCipher(
    createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
  );
  const store = new PrismaChannelSecretStore(prisma, cipher);
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
    ledger,
  );
  return {
    igUserId,
    calls,
    store,
    controller,
    oauth,
    setMe: (next: typeof meReply): void => {
      meReply = next;
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
      'messages,messaging_postbacks',
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

describe('Instagram API with Unified login (oauth/start, oauth/complete)', () => {
  const principalOf = (
    request: never,
  ): { tenantId: string; operatorId: string; sessionId: string } =>
    (
      request as {
        principal: { tenantId: string; operatorId: string; sessionId: string };
      }
    ).principal;
  const stateFor = (s: Setup, request: never): string =>
    new URL(s.controller.start(request).url).searchParams.get('state')!;
  const refusal = (code: string): { response: { code: string } } => ({
    response: { code },
  });

  it('is configured only with the configuration id; start refuses without it', async () => {
    const t = await tenant();
    const noConfig = setup({ ...OAUTH, INSTAGRAM_LOGIN_CONFIG_ID: undefined });
    expect(noConfig.controller.setup(t.request)).toEqual({ oauth: false });
    expect(() => noConfig.controller.start(t.request)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'OAUTH_NOT_CONFIGURED' }),
      }),
    );
    await expect(
      noConfig.controller.complete(t.request, { code: CODE, state: 'x' }),
    ).rejects.toMatchObject(refusal('OAUTH_NOT_CONFIGURED'));
    expect(noConfig.calls).toHaveLength(0);
    expect(setup(OAUTH).controller.setup(t.request)).toEqual({ oauth: true });
  });

  it('start builds the Unified login URL with a sealed state, calling nobody', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const parsed = new URL(s.controller.start(t.request).url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'https://oauth.example.test/dialog/oauth',
    );
    expect(parsed.searchParams.get('client_id')).toBe(OAUTH.INSTAGRAM_APP_ID);
    expect(parsed.searchParams.get('config_id')).toBe(
      OAUTH.INSTAGRAM_LOGIN_CONFIG_ID,
    );
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      OAUTH.INSTAGRAM_OAUTH_REDIRECT_URI,
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.has('scope')).toBe(false);
    const state = parsed.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/u);
    const plain = Buffer.from(state, 'base64url').toString('utf8');
    expect(plain).not.toContain(principalOf(t.request).tenantId);
    expect(plain).not.toContain(principalOf(t.request).sessionId);
    expect(s.calls).toHaveLength(0);
  });

  it('complete stores the system-user token for this tenant; enable subscribes on graph.facebook.com', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const connected = await s.controller.complete(t.request, {
      code: CODE,
      state: stateFor(s, t.request),
    });
    expect(connected).toMatchObject({
      channelType: 'instagram',
      displayName: `@${USERNAME}`,
      status: 'DISABLED',
      agentMode: 'OFF',
    });
    const systemToken = `${SYSTEM_TOKEN}-0`;
    expect(JSON.stringify(connected)).not.toContain(systemToken);
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /v27.0/oauth/access_token',
      'GET /v27.0/me/assigned_instagram_accounts',
    ]);
    const owner = { tenantId: t.tenantId, channelAccountId: connected.id };
    expect(await s.store.get(owner, 'instagram_system_user_token')).toBe(
      systemToken,
    );
    expect(await s.store.get(owner, 'instagram_access_token')).toBeUndefined();
    const row = await db.channelAccount.findUniqueOrThrow({
      where: { id: connected.id },
    });
    expect(row).toMatchObject({
      tenantId: t.tenantId,
      externalAccountId: s.igUserId,
    });
    const stored = await db.channelSecret.findFirstOrThrow({
      where: { channelAccountId: connected.id },
    });
    expect(JSON.stringify(stored)).not.toContain(systemToken);

    const enabled = await s.controller.enable(t.request, connected.id);
    expect(enabled.status).toBe('ACTIVE');
    const subscribe = s.calls.at(-1)!;
    expect(
      `${subscribe.method} ${subscribe.url.host}${subscribe.url.pathname}`,
    ).toBe(`POST graph.facebook.com/v27.0/${s.igUserId}/subscribed_apps`);
    expect(subscribe.url.search).toBe('');

    const audit = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'channel.instagram_connected',
        'channel.instagram_enabled',
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(systemToken);
    expect(JSON.stringify(audit)).not.toContain(
      String(SETTINGS.INSTAGRAM_APP_SECRET),
    );
  });

  it('a reconnect from a pasted token replaces it with the Unified login token', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const pasted = await s.controller.connect(t.request, {
      accessToken: TOKEN,
    });
    const connected = await s.controller.complete(t.request, {
      code: CODE,
      state: stateFor(s, t.request),
    });
    expect(connected.id).toBe(pasted.id);
    const owner = { tenantId: t.tenantId, channelAccountId: connected.id };
    expect(await s.store.get(owner, 'instagram_access_token')).toBeUndefined();
    expect(await s.store.get(owner, 'instagram_system_user_token')).toBe(
      `${SYSTEM_TOKEN}-0`,
    );
  });

  it('refuses a state from another session, an expired, a tampered or a forged one, before calling Meta', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const me = principalOf(t.request);
    const otherSession = s.oauth.state({ ...me, sessionId: randomUUID() });
    const otherTenant = s.oauth.state({ ...me, tenantId: randomUUID() });
    const expired = s.oauth.state(me, Date.now() - STATE_TTL_MS - 1);
    const good = s.oauth.state(me);
    const tampered = `${good.slice(0, -2)}${good.endsWith('A') ? 'B' : 'A'}${good.slice(-1)}`;
    for (const state of [
      otherSession,
      otherTenant,
      expired,
      tampered,
      'not-a-state',
    ])
      await expect(
        s.controller.complete(t.request, { code: CODE, state }),
      ).rejects.toMatchObject(refusal('OAUTH_STATE_INVALID'));
    expect(s.calls).toHaveLength(0);
  });

  it('spends a state once: a replayed callback is refused without calling Meta', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const state = stateFor(s, t.request);
    await s.controller.complete(t.request, { code: CODE, state });
    const before = s.calls.length;
    await expect(
      s.controller.complete(t.request, { code: CODE, state }),
    ).rejects.toMatchObject(refusal('OAUTH_STATE_INVALID'));
    expect(s.calls).toHaveLength(before);
  });

  it('lets only one of two parallel callbacks with the same state through (real Redis ledger)', async () => {
    const ledger = new RedisOAuthStateLedger(redisConfig);
    ledgers.push(ledger);
    const s = setup(OAUTH, ledger);
    const t = await tenant();
    const state = stateFor(s, t.request);
    const results = await Promise.allSettled([
      s.controller.complete(t.request, { code: CODE, state }),
      s.controller.complete(t.request, { code: CODE, state }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost).toMatchObject({ reason: refusal('OAUTH_STATE_INVALID') });
    // Meta's code was exchanged once.
    expect(
      s.calls.filter((c) => c.url.pathname.endsWith('/oauth/access_token')),
    ).toHaveLength(1);
    expect(
      await db.channelAccount.count({ where: { tenantId: t.tenantId } }),
    ).toBe(1);
  });

  it('does not spend a state on a callback from the wrong session or tenant', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const me = principalOf(t.request);
    const state = stateFor(s, t.request);
    const other = await tenant();
    for (const principal of [
      { ...me, sessionId: randomUUID() },
      principalOf(other.request),
    ])
      await expect(
        s.controller.complete(
          { principal: { ...principal, role: 'ADMIN' } } as never,
          {
            code: CODE,
            state,
          },
        ),
      ).rejects.toMatchObject(refusal('OAUTH_STATE_INVALID'));
    expect(s.calls).toHaveLength(0);
    // The rightful session can still finish with the same state.
    const connected = await s.controller.complete(t.request, {
      code: CODE,
      state,
    });
    expect(connected.status).toBe('DISABLED');
  });

  it('refuses safely when the real Redis ledger cannot connect', async () => {
    const ledger = new RedisOAuthStateLedger({
      get: () => 'redis://127.0.0.1:1',
    } as never);
    ledgers.push(ledger);
    const s = setup(OAUTH, ledger);
    const t = await tenant();
    await expect(
      s.controller.complete(t.request, {
        code: CODE,
        state: stateFor(s, t.request),
      }),
    ).rejects.toMatchObject(refusal('OAUTH_UNAVAILABLE'));
    expect(s.calls).toHaveLength(0);
    expect(
      await db.channelAccount.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it('refuses while the state ledger is unreachable, calling nobody', async () => {
    const ledger = new MemoryLedger();
    ledger.down = true;
    const s = setup(OAUTH, ledger);
    const t = await tenant();
    await expect(
      s.controller.complete(t.request, {
        code: CODE,
        state: stateFor(s, t.request),
      }),
    ).rejects.toMatchObject(refusal('OAUTH_UNAVAILABLE'));
    expect(s.calls).toHaveLength(0);
  });

  it('refuses when no account or several were shared, storing nothing', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    await expect(
      s.controller.complete(t.request, {
        code: NO_ACCOUNT_CODE,
        state: stateFor(s, t.request),
      }),
    ).rejects.toMatchObject(refusal('NO_INSTAGRAM_ACCOUNT'));
    await expect(
      s.controller.complete(t.request, {
        code: TWO_ACCOUNTS_CODE,
        state: stateFor(s, t.request),
      }),
    ).rejects.toMatchObject(refusal('SEVERAL_INSTAGRAM_ACCOUNTS'));
    expect(
      await db.channelAccount.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it('maps a refused code to INSTAGRAM_REJECTED without echoing the code or the secret', async () => {
    const s = setup(OAUTH);
    const t = await tenant();
    const badCode = `code-${randomBytes(12).toString('hex')}`;
    const error = (await s.controller
      .complete(t.request, { code: badCode, state: stateFor(s, t.request) })
      .catch((e: unknown) => e)) as { getResponse(): unknown };
    expect(error).toMatchObject(refusal('INSTAGRAM_REJECTED'));
    const body = JSON.stringify(error.getResponse());
    expect(body).not.toContain(badCode);
    expect(body).not.toContain(String(SETTINGS.INSTAGRAM_APP_SECRET));
    expect(body).not.toContain('detail');
    expect(
      await db.channelAccount.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it("refuses an account another tenant connected and keeps that tenant's token", async () => {
    const igUserId = `${IG_ID_PREFIX}${randomInt(10 ** 9, 10 ** 10 - 1)}`;
    const a = setup(OAUTH, new MemoryLedger(), igUserId);
    const b = setup(OAUTH, new MemoryLedger(), igUserId);
    const ta = await tenant();
    const tb = await tenant();
    const first = await a.controller.complete(ta.request, {
      code: CODE,
      state: stateFor(a, ta.request),
    });
    await expect(
      b.controller.complete(tb.request, {
        code: CODE,
        state: stateFor(b, tb.request),
      }),
    ).rejects.toMatchObject(refusal('ALREADY_CONNECTED'));
    expect(
      await a.store.get(
        { tenantId: ta.tenantId, channelAccountId: first.id },
        'instagram_system_user_token',
      ),
    ).toBe(`${SYSTEM_TOKEN}-0`);
    expect(
      await db.channelAccount.count({ where: { tenantId: tb.tenantId } }),
    ).toBe(0);
  });

  it('is for owners and admins only', async () => {
    const s = setup(OAUTH);
    const t = await tenant('OPERATOR');
    expect(() => s.controller.start(t.request)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
