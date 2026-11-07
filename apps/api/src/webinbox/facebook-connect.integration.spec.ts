import { config as loadEnv } from 'dotenv';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FacebookOAuthClient } from '../channels/facebook/facebook-oauth.js';
import { InstagramGraphClient } from '../channels/instagram/instagram-graph.js';
import { OAuthStateLedger } from '../channels/instagram/instagram-oauth-state-ledger.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PrismaChannelSecretStore } from '../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { FacebookConnectController } from './facebook-connect.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Facebook connect tests require agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => db.$disconnect());

/** Generated per run: never real or credential-shaped literals. */
const CODE = `code-${randomBytes(12).toString('hex')}`;
const NO_PAGE_CODE = `code-${randomBytes(12).toString('hex')}`;
const USER_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const PAGE_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const SETTINGS: Record<string, unknown> = {
  NODE_ENV: 'development',
  LLM_PROVIDER: 'mock',
  LLM_TRUSTED_PROVIDERS: ['mock'],
  LLM_ALLOW_REAL_CUSTOMER_DATA: false,
  INSTAGRAM_APP_ID: String(randomInt(10 ** 9, 10 ** 10 - 1)),
  INSTAGRAM_APP_SECRET: randomBytes(16).toString('hex'),
  INSTAGRAM_VERIFY_TOKEN: randomBytes(16).toString('hex'),
  FACEBOOK_LOGIN_CONFIG_ID: String(randomInt(10 ** 9, 10 ** 10 - 1)),
  FACEBOOK_OAUTH_REDIRECT_URI:
    'https://app.example.test/channels/facebook/callback',
  INSTAGRAM_OAUTH_BASE_URL: 'https://oauth.example.test',
};

class MemoryLedger extends OAuthStateLedger {
  private readonly spent = new Set<string>();
  async consume(state: string): Promise<boolean> {
    if (this.spent.has(state)) return false;
    this.spent.add(state);
    return true;
  }
}

async function tenant(
  role: 'ADMIN' | 'OPERATOR' = 'ADMIN',
): Promise<{ tenantId: string; request: never }> {
  const created = await db.tenant.create({
    data: {
      slug: `fb-connect-${randomUUID()}`,
      name: 'Facebook connect fixture',
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

/** A strict fake Graph API: only the documented Messenger connect calls. */
function setup(pageId = `1000${randomInt(10 ** 9, 10 ** 10 - 1)}`): {
  pageId: string;
  controller: FacebookConnectController;
  store: PrismaChannelSecretStore;
  calls: { url: URL; method: string; body: string }[];
} {
  const calls: { url: URL; method: string; body: string }[] = [];
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });
  const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    calls.push({ url: parsed, method, body });
    const q = parsed.searchParams;
    if (parsed.hostname !== 'graph.facebook.com') return reply(404, {});
    if (method === 'GET' && parsed.pathname === '/v27.0/oauth/access_token') {
      if (q.get('grant_type') === 'fb_exchange_token')
        return q.get('fb_exchange_token') === USER_TOKEN
          ? reply(200, { access_token: USER_TOKEN })
          : reply(400, { error: { code: 190 } });
      const known = [CODE, NO_PAGE_CODE].includes(q.get('code') ?? '');
      return known &&
        q.get('client_secret') === SETTINGS.INSTAGRAM_APP_SECRET &&
        q.get('redirect_uri') === SETTINGS.FACEBOOK_OAUTH_REDIRECT_URI
        ? reply(200, {
            access_token:
              q.get('code') === CODE ? USER_TOKEN : `${USER_TOKEN}x`,
          })
        : reply(400, { error: { code: 100, message: 'detail' } });
    }
    if (method === 'GET' && parsed.pathname === '/v27.0/me/accounts')
      return q.get('access_token') === USER_TOKEN
        ? reply(200, {
            data: [{ id: pageId, name: 'Demo shop', access_token: PAGE_TOKEN }],
          })
        : reply(200, { data: [] });
    if (
      method === 'POST' &&
      parsed.pathname === `/v27.0/${pageId}/subscribed_apps`
    ) {
      const form = new URLSearchParams(body);
      return form.get('access_token') === PAGE_TOKEN &&
        form.get('subscribed_fields') === 'messages'
        ? reply(200, { success: true })
        : reply(400, { error: { code: 190 } });
    }
    return reply(404, {});
  });
  const cipher = new SecretCipher(
    createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
  );
  const store = new PrismaChannelSecretStore(prisma, cipher);
  const config = { get: (key: string) => SETTINGS[key] } as never;
  const controller = new FacebookConnectController(
    prisma,
    config,
    store,
    new InstagramGraphClient(request as unknown as typeof fetch),
    new FacebookOAuthClient(config, cipher, request as unknown as typeof fetch),
    new MemoryLedger(),
  );
  return { pageId, controller, store, calls };
}

const stateOf = (s: ReturnType<typeof setup>, request: never): string =>
  new URL(s.controller.start(request).url).searchParams.get('state')!;

describe('connecting a Facebook Page for Messenger (ADR 040)', () => {
  it('connects the granted Page for this tenant, encrypted; enable subscribes it', async () => {
    const s = setup();
    const t = await tenant();
    expect(s.controller.setup(t.request)).toEqual({ oauth: true });
    const connected = await s.controller.complete(t.request, {
      code: CODE,
      state: stateOf(s, t.request),
    });
    expect(connected).toMatchObject({
      channelType: 'facebook',
      displayName: 'Demo shop',
      status: 'DISABLED',
      agentMode: 'OFF',
    });
    expect(JSON.stringify(connected)).not.toContain(PAGE_TOKEN);
    const owner = { tenantId: t.tenantId, channelAccountId: connected.id };
    expect(await s.store.get(owner, 'facebook_page_access_token')).toBe(
      PAGE_TOKEN,
    );
    const stored = await db.channelSecret.findFirstOrThrow({
      where: { channelAccountId: connected.id },
    });
    expect(JSON.stringify(stored)).not.toContain(PAGE_TOKEN);

    const enabled = await s.controller.enable(t.request, connected.id);
    expect(enabled.status).toBe('ACTIVE');
    const subscribe = s.calls.at(-1)!;
    expect(`${subscribe.method} ${subscribe.url.pathname}`).toBe(
      `POST /v27.0/${s.pageId}/subscribed_apps`,
    );
    const audit = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'channel.facebook_connected',
        'channel.facebook_enabled',
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(PAGE_TOKEN);
  });

  it('spends a state once and refuses a forged one, before calling Meta', async () => {
    const s = setup();
    const t = await tenant();
    const state = stateOf(s, t.request);
    await s.controller.complete(t.request, { code: CODE, state });
    const before = s.calls.length;
    for (const bad of [state, 'not-a-state'])
      await expect(
        s.controller.complete(t.request, { code: CODE, state: bad }),
      ).rejects.toMatchObject({ response: { code: 'OAUTH_STATE_INVALID' } });
    expect(s.calls).toHaveLength(before);
  });

  it('refuses no granted Page, a refused code, and another tenant’s Page', async () => {
    const pageId = `1000${randomInt(10 ** 9, 10 ** 10 - 1)}`;
    const s = setup(pageId);
    const t = await tenant();
    await expect(
      s.controller.complete(t.request, {
        code: NO_PAGE_CODE,
        state: stateOf(s, t.request),
      }),
    ).rejects.toMatchObject({ response: { code: 'NO_FACEBOOK_PAGE' } });
    await expect(
      s.controller.complete(t.request, {
        code: 'code-unknown',
        state: stateOf(s, t.request),
      }),
    ).rejects.toMatchObject({ response: { code: 'FACEBOOK_REJECTED' } });

    await s.controller.complete(t.request, {
      code: CODE,
      state: stateOf(s, t.request),
    });
    const other = await tenant();
    const s2 = setup(pageId);
    await expect(
      s2.controller.complete(other.request, {
        code: CODE,
        state: stateOf(s2, other.request),
      }),
    ).rejects.toMatchObject({ response: { code: 'ALREADY_CONNECTED' } });
    expect(
      await db.channelAccount.count({ where: { tenantId: other.tenantId } }),
    ).toBe(0);
  });

  it('is for owners and admins only', async () => {
    const s = setup();
    const t = await tenant('OPERATOR');
    expect(() => s.controller.start(t.request)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
