import { randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../../secrets/secret-cipher.js';
import { readInstagramCredential } from './instagram-credential.js';
import {
  FACEBOOK_GRAPH_BASE_URL,
  InstagramAmbiguousSendError,
  InstagramApiError,
  InstagramGraphClient,
} from './instagram-graph.js';
import { InstagramOAuthClient } from './instagram-oauth.js';
import {
  ledgerKey,
  OAuthStateLedgerUnavailableError,
  RedisOAuthStateLedger,
  type LedgerRedis,
} from './instagram-oauth-state-ledger.js';

/** Generated per run: never real or credential-shaped literals. */
const fake = (): string => `test-${randomBytes(16).toString('hex')}`;
const TOKEN = fake();
const APP_SECRET = randomBytes(16).toString('hex');
const APP_ID = String(randomInt(10 ** 9, 10 ** 10 - 1));
const CONFIG_ID = String(randomInt(10 ** 9, 10 ** 10 - 1));
const REDIRECT = 'https://app.example.test/channels/instagram/callback';
const CODE = `code-${randomBytes(12).toString('hex')}`;
const IG = '17841400000000001';
const IGSID = '9876543210';

type Reply = { status: number; body?: unknown } | Error;

function fakeFetch(replies: Reply[]): {
  request: typeof fetch;
  calls: { url: URL; init: RequestInit }[];
} {
  const calls: { url: URL; init: RequestInit }[] = [];
  const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply scripted');
    if (reply instanceof Error) throw reply;
    return new Response(
      reply.body === undefined ? 'not json' : JSON.stringify(reply.body),
      { status: reply.status },
    );
  });
  return { request: request as unknown as typeof fetch, calls };
}

const cipher = (): SecretCipher =>
  new SecretCipher(
    createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
  );

function oauth(
  replies: Reply[] = [],
  overrides: Record<string, unknown> = {},
): { client: InstagramOAuthClient; calls: { url: URL; init: RequestInit }[] } {
  const { request, calls } = fakeFetch(replies);
  const values: Record<string, unknown> = {
    INSTAGRAM_APP_ID: APP_ID,
    INSTAGRAM_APP_SECRET: APP_SECRET,
    INSTAGRAM_OAUTH_REDIRECT_URI: REDIRECT,
    INSTAGRAM_LOGIN_CONFIG_ID: CONFIG_ID,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as never;
  return {
    client: new InstagramOAuthClient(config, cipher(), request),
    calls,
  };
}

describe('Unified login: setup and authorization URL', () => {
  it('opens Meta’s login dialog with the configuration id, the state and prompt=login', () => {
    const { client } = oauth();
    expect(client.configured).toBe(true);
    const url = new URL(client.authorizeUrl('st4te'));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.facebook.com/dialog/oauth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      config_id: CONFIG_ID,
      override_default_response_type: 'true',
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 'st4te',
      prompt: 'login',
    });
    // Never the retired Instagram Login dialog or its scopes.
    expect(url.hostname).not.toBe('www.instagram.com');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it.each([
    'INSTAGRAM_LOGIN_CONFIG_ID',
    'INSTAGRAM_APP_ID',
    'INSTAGRAM_APP_SECRET',
    'INSTAGRAM_OAUTH_REDIRECT_URI',
  ])('is not configured without %s', (key) => {
    expect(oauth([], { [key]: undefined }).client.configured).toBe(false);
  });
});

describe('Unified login: code exchange and account discovery', () => {
  const assigned = (data: unknown): Reply => ({ status: 200, body: { data } });

  it('buys the system-user token with the Meta app id and secret, then lists the shared accounts', async () => {
    const { client, calls } = oauth([
      { status: 200, body: { access_token: TOKEN, token_type: 'bearer' } },
      assigned([{ id: IG, username: 'demo_shop' }]),
    ]);
    await expect(client.exchange(CODE)).resolves.toEqual({
      token: TOKEN,
      accounts: [{ igUserId: IG, username: 'demo_shop' }],
    });
    const [exchange, list] = calls;
    expect(`${exchange!.url.origin}${exchange!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/oauth/access_token`,
    );
    expect(Object.fromEntries(exchange!.url.searchParams)).toEqual({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: REDIRECT,
      code: CODE,
    });
    expect(`${list!.url.origin}${list!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/me/assigned_instagram_accounts`,
    );
    expect(Object.fromEntries(list!.url.searchParams)).toEqual({
      fields: 'id,username',
      access_token: TOKEN,
    });
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true);
    expect(calls.map((c) => c.url.hostname)).not.toContain('api.instagram.com');
  });

  it('keeps numeric ids, drops malformed rows and odd usernames', async () => {
    const { client } = oauth([
      { status: 200, body: { access_token: TOKEN } },
      assigned([
        { id: 17841400000000002, username: '<b>x</b>' },
        { id: 'ig', username: 'bad_id' },
        null,
      ]),
    ]);
    await expect(client.exchange(CODE)).resolves.toEqual({
      token: TOKEN,
      accounts: [{ igUserId: '17841400000000002', username: null }],
    });
  });

  it('maps a refused code to a Meta error without its text and stops there', async () => {
    const { client, calls } = oauth([
      { status: 400, body: { error: { code: 100, message: 'secret detail' } } },
    ]);
    const error = await client.exchange(CODE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramApiError);
    expect((error as Error).message).not.toContain('secret detail');
    expect(calls).toHaveLength(1);
  });

  it('rejects an answer without a usable token or without a data list', async () => {
    await expect(
      oauth([{ status: 200, body: { access_token: 'x y' } }]).client.exchange(
        CODE,
      ),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      oauth([
        { status: 200, body: { access_token: TOKEN } },
        { status: 200, body: { accounts: [] } },
      ]).client.exchange(CODE),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('treats a network failure as temporary', async () => {
    await expect(
      oauth([new Error('socket hang up')]).client.exchange(CODE),
    ).rejects.toMatchObject({ kind: 'temporary' });
  });
});

describe('Unified login: Graph calls on graph.facebook.com', () => {
  it('subscribes the account with form data and requires success: true', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { success: true } },
      { status: 200, body: { success: false } },
    ]);
    const graph = new InstagramGraphClient(request);
    await graph.subscribeUnified(IG, TOKEN, ['messages']);
    const [call] = calls;
    expect(`${call!.url.origin}${call!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/${IG}/subscribed_apps`,
    );
    expect(call!.init.method).toBe('POST');
    // The token travels in the form body, not in the URL.
    expect(call!.url.search).toBe('');
    expect(
      Object.fromEntries(new URLSearchParams(String(call!.init.body))),
    ).toEqual({
      subscribed_fields: 'messages',
      access_token: TOKEN,
    });
    await expect(
      graph.subscribeUnified(IG, TOKEN, ['messages']),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('sends a text as the account to <IG_ID>/messages', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { recipient_id: IGSID, message_id: 'm_1' } },
    ]);
    const graph = new InstagramGraphClient(request);
    await expect(
      graph.sendTextUnified(IG, TOKEN, IGSID, 'Salom'),
    ).resolves.toEqual({ messageId: 'm_1' });
    const [call] = calls;
    expect(`${call!.url.origin}${call!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/${IG}/messages`,
    );
    expect(call!.url.searchParams.get('access_token')).toBe(TOKEN);
    expect(JSON.parse(String(call!.init.body))).toEqual({
      recipient: { id: IGSID },
      message: { text: 'Salom' },
    });
  });

  it('treats a lost send response as ambiguous and refuses bad input before calling', async () => {
    const { request, calls } = fakeFetch([new Error('socket hang up')]);
    const graph = new InstagramGraphClient(request);
    await expect(
      graph.sendTextUnified(IG, TOKEN, IGSID, 'hi'),
    ).rejects.toBeInstanceOf(InstagramAmbiguousSendError);
    await expect(
      graph.sendTextUnified(IG, TOKEN, IGSID, 'й'.repeat(501)),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      graph.sendTextUnified('../me', TOKEN, IGSID, 'hi'),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(1);
  });
});

describe('RedisOAuthStateLedger', () => {
  class FakeRedis implements LedgerRedis {
    readonly keys = new Map<string, number>();
    fail = false;
    async set(
      key: string,
      _value: string,
      _px: 'PX',
      ttlMs: number,
      _nx: 'NX',
    ): Promise<string | null> {
      if (this.fail) throw new Error('ECONNREFUSED');
      if (this.keys.has(key)) return null;
      this.keys.set(key, ttlMs);
      return 'OK';
    }
    async quit(): Promise<unknown> {
      return 'OK';
    }
  }
  const ledger = (redis: FakeRedis): RedisOAuthStateLedger => {
    class Testable extends RedisOAuthStateLedger {
      protected override connect(): LedgerRedis {
        return redis;
      }
    }
    const config = { get: () => 'redis://localhost:6379' } as never;
    return new Testable(config);
  };

  it('lets a state through once, with a TTL, storing only its hash', async () => {
    const redis = new FakeRedis();
    const l = ledger(redis);
    const state = fake();
    await expect(l.consume(state, 600_000)).resolves.toBe(true);
    await expect(l.consume(state, 600_000)).resolves.toBe(false);
    await expect(l.consume(fake(), 600_000)).resolves.toBe(true);
    const [key, ttl] = [...redis.keys][0]!;
    expect(key).toBe(ledgerKey(state));
    expect(key).not.toContain(state);
    expect(ttl).toBe(600_000);
  });

  it('fails closed when Redis cannot be reached', async () => {
    const redis = new FakeRedis();
    redis.fail = true;
    await expect(ledger(redis).consume(fake(), 1_000)).rejects.toBeInstanceOf(
      OAuthStateLedgerUnavailableError,
    );
  });
});

describe('readInstagramCredential', () => {
  const store = (values: Record<string, string>): ChannelSecretStore =>
    ({
      get: async (_owner: unknown, purpose: string) => values[purpose],
    }) as never;
  const owner = { tenantId: 't', channelAccountId: 'c' };

  it('prefers the Unified login token, falls back to the pasted token, else undefined', async () => {
    await expect(
      readInstagramCredential(
        store({
          instagram_system_user_token: 'u',
          instagram_access_token: 'p',
        }),
        owner,
      ),
    ).resolves.toEqual({ kind: 'unified', token: 'u' });
    await expect(
      readInstagramCredential(store({ instagram_access_token: 'p' }), owner),
    ).resolves.toEqual({ kind: 'instagram', token: 'p' });
    await expect(
      readInstagramCredential(store({}), owner),
    ).resolves.toBeUndefined();
  });
});
