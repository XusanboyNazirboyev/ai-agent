import { randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { readInstagramCredential } from './instagram-credential.js';
import {
  FACEBOOK_GRAPH_BASE_URL,
  InstagramAmbiguousSendError,
  InstagramApiError,
  InstagramGraphClient,
} from './instagram-graph.js';
import { InstagramOAuthClient } from './instagram-oauth.js';

/** Generated per run: never real or credential-shaped literals. */
const fake = (): string => `test-${randomBytes(16).toString('hex')}`;
const PAGE_TOKEN = fake();
const SHORT_TOKEN = fake();
const LONG_TOKEN = fake();
const APP_SECRET = randomBytes(16).toString('hex');
const APP_ID = String(randomInt(10 ** 9, 10 ** 10 - 1));
const CONFIG_ID = String(randomInt(10 ** 9, 10 ** 10 - 1));
const REDIRECT = 'https://app.example.test/channels/instagram/callback';
const CODE = `code-${randomBytes(12).toString('hex')}`;
const IG = '17841400000000001';
const PAGE = '100000000000001';
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

function oauth(
  replies: Reply[],
  settings: Record<string, unknown> = { INSTAGRAM_LOGIN_CONFIG_ID: CONFIG_ID },
): { client: InstagramOAuthClient; calls: { url: URL; init: RequestInit }[] } {
  const { request, calls } = fakeFetch(replies);
  const values: Record<string, unknown> = {
    INSTAGRAM_APP_ID: APP_ID,
    INSTAGRAM_APP_SECRET: APP_SECRET,
    INSTAGRAM_OAUTH_REDIRECT_URI: REDIRECT,
    ...settings,
  };
  const config = { get: (key: string) => values[key] } as never;
  return {
    client: new InstagramOAuthClient(config, undefined, request),
    calls,
  };
}

describe('Facebook Login for Business: authorization URL', () => {
  it('opens the versioned Facebook dialog with the configuration id instead of scopes', () => {
    const { client } = oauth([]);
    expect(client.mode).toBe('facebook');
    const url = new URL(client.authorizeUrl('st4te'));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.facebook.com/v27.0/dialog/oauth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      config_id: CONFIG_ID,
      display: 'page',
      override_default_response_type: 'true',
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 'st4te',
    });
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('keeps Business Login for Instagram when no configuration id is set', () => {
    const { client } = oauth([], {});
    expect(client.mode).toBe('instagram');
    const url = new URL(client.authorizeUrl('st4te'));
    expect(url.origin).toBe('https://www.instagram.com');
    expect(url.searchParams.has('config_id')).toBe(false);
  });
});

describe('Facebook Login for Business: code exchange', () => {
  const accounts = (data: unknown[]): Reply => ({
    status: 200,
    body: { data },
  });

  it('exchanges the code, extends the token and returns the Pages with an Instagram account', async () => {
    const { client, calls } = oauth([
      {
        status: 200,
        body: { access_token: SHORT_TOKEN, token_type: 'bearer' },
      },
      {
        status: 200,
        body: { access_token: LONG_TOKEN, expires_in: 5_183_944 },
      },
      accounts([
        {
          id: PAGE,
          name: 'Demo shop',
          access_token: PAGE_TOKEN,
          instagram_business_account: { id: IG },
        },
        { id: '100000000000002', name: 'No Instagram', access_token: fake() },
      ]),
    ]);
    await expect(client.exchangeFacebook(CODE)).resolves.toEqual([
      { pageId: PAGE, pageToken: PAGE_TOKEN, igUserId: IG },
    ]);
    const [exchange, extend, list] = calls;
    expect(`${exchange!.url.origin}${exchange!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/oauth/access_token`,
    );
    expect(Object.fromEntries(exchange!.url.searchParams)).toEqual({
      client_id: APP_ID,
      redirect_uri: REDIRECT,
      client_secret: APP_SECRET,
      code: CODE,
    });
    expect(Object.fromEntries(extend!.url.searchParams)).toEqual({
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: SHORT_TOKEN,
    });
    expect(list!.url.pathname).toBe('/v27.0/me/accounts');
    expect(list!.url.searchParams.get('fields')).toBe(
      'id,name,access_token,instagram_business_account',
    );
    expect(list!.url.searchParams.get('access_token')).toBe(LONG_TOKEN);
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true);
  });

  it('drops rows with a malformed Page id, token or Instagram id', async () => {
    const { client } = oauth([
      { status: 200, body: { access_token: SHORT_TOKEN } },
      { status: 200, body: { access_token: LONG_TOKEN } },
      accounts([
        {
          id: 'x',
          access_token: PAGE_TOKEN,
          instagram_business_account: { id: IG },
        },
        {
          id: PAGE,
          access_token: 'short',
          instagram_business_account: { id: IG },
        },
        {
          id: PAGE,
          access_token: PAGE_TOKEN,
          instagram_business_account: { id: 'ig' },
        },
        null,
      ]),
    ]);
    await expect(client.exchangeFacebook(CODE)).resolves.toEqual([]);
  });

  it('maps a refused code to a Meta error and stops before the next step', async () => {
    const { client, calls } = oauth([
      { status: 400, body: { error: { code: 100, message: 'secret detail' } } },
    ]);
    const error = await client.exchangeFacebook(CODE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramApiError);
    expect((error as Error).message).not.toContain('secret detail');
    expect(calls).toHaveLength(1);
  });

  it('rejects an answer without a usable token', async () => {
    const { client } = oauth([{ status: 200, body: { access_token: 'x y' } }]);
    await expect(client.exchangeFacebook(CODE)).rejects.toMatchObject({
      kind: 'rejected',
    });
  });
});

describe('Instagram through a Facebook Page: Graph calls', () => {
  it('sends with the Page token to /me/messages on graph.facebook.com', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { recipient_id: IGSID, message_id: 'm_1' } },
    ]);
    const graph = new InstagramGraphClient(request);
    await expect(
      graph.sendTextAsPage(PAGE_TOKEN, IGSID, 'Salom'),
    ).resolves.toEqual({ messageId: 'm_1' });
    const [call] = calls;
    expect(`${call!.url.origin}${call!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/me/messages`,
    );
    expect(call!.url.searchParams.get('access_token')).toBe(PAGE_TOKEN);
    expect(call!.init.method).toBe('POST');
    expect(JSON.parse(String(call!.init.body))).toEqual({
      recipient: { id: IGSID },
      messaging_type: 'RESPONSE',
      message: { text: 'Salom' },
    });
  });

  it('treats a lost response as ambiguous and refuses text over 1,000 bytes', async () => {
    const { request, calls } = fakeFetch([new Error('socket hang up')]);
    const graph = new InstagramGraphClient(request);
    await expect(
      graph.sendTextAsPage(PAGE_TOKEN, IGSID, 'hi'),
    ).rejects.toBeInstanceOf(InstagramAmbiguousSendError);
    await expect(
      graph.sendTextAsPage(PAGE_TOKEN, IGSID, 'й'.repeat(501)),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(1);
  });

  it('subscribes the Page with its token and requires success: true', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { success: true } },
      { status: 200, body: { success: false } },
    ]);
    const graph = new InstagramGraphClient(request);
    await graph.subscribePage(PAGE_TOKEN, ['messages']);
    const [call] = calls;
    expect(call!.url.pathname).toBe('/v27.0/me/subscribed_apps');
    expect(call!.url.searchParams.get('subscribed_fields')).toBe('messages');
    expect(call!.url.searchParams.get('access_token')).toBe(PAGE_TOKEN);
    expect(call!.init.method).toBe('POST');
    await expect(
      graph.subscribePage(PAGE_TOKEN, ['messages']),
    ).rejects.toMatchObject({
      kind: 'rejected',
    });
  });

  it('reads the @username, and gives null for an error or an odd value', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { username: 'demo_shop', id: IG } },
      { status: 400, body: { error: { code: 10 } } },
      { status: 200, body: { username: '<b>x</b>' } },
    ]);
    const graph = new InstagramGraphClient(request);
    await expect(graph.username(IG, PAGE_TOKEN)).resolves.toBe('demo_shop');
    await expect(graph.username(IG, PAGE_TOKEN)).resolves.toBeNull();
    await expect(graph.username(IG, PAGE_TOKEN)).resolves.toBeNull();
    expect(calls[0]!.url.pathname).toBe(`/v27.0/${IG}`);
    expect(calls[0]!.url.searchParams.get('fields')).toBe('username');
  });
});

describe('readInstagramCredential', () => {
  const store = (values: Record<string, string>): ChannelSecretStore =>
    ({
      get: async (_owner: unknown, purpose: string) => values[purpose],
    }) as never;
  const owner = { tenantId: 't', channelAccountId: 'c' };

  it('prefers the Page token, falls back to the Instagram token, else undefined', async () => {
    await expect(
      readInstagramCredential(
        store({
          instagram_page_access_token: 'p',
          instagram_access_token: 'u',
        }),
        owner,
      ),
    ).resolves.toEqual({ kind: 'page', token: 'p' });
    await expect(
      readInstagramCredential(store({ instagram_access_token: 'u' }), owner),
    ).resolves.toEqual({ kind: 'instagram', token: 'u' });
    await expect(
      readInstagramCredential(store({}), owner),
    ).resolves.toBeUndefined();
  });
});
