import { randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createKeyring, SecretCipher } from '../../secrets/secret-cipher.js';
import {
  FACEBOOK_GRAPH_BASE_URL,
  InstagramAmbiguousSendError,
  InstagramApiError,
  InstagramGraphClient,
} from '../instagram/instagram-graph.js';
import { InstagramOAuthClient } from '../instagram/instagram-oauth.js';
import { OAuthStateError } from '../meta/meta-oauth-state.js';
import { FacebookOAuthClient } from './facebook-oauth.js';

/** Generated per run: never real or credential-shaped literals. */
const fake = (): string => `test-${randomBytes(16).toString('hex')}`;
const APP_ID = String(randomInt(10 ** 9, 10 ** 10 - 1));
const APP_SECRET = randomBytes(16).toString('hex');
const CONFIG_ID = String(randomInt(10 ** 9, 10 ** 10 - 1));
const REDIRECT = 'https://app.example.test/channels/facebook/callback';
const CODE = `code-${randomBytes(12).toString('hex')}`;
const SHORT = fake();
const LONG = fake();
const PAGE_TOKEN = fake();
const PAGE = '100000000000001';
const PSID = '2400000000000001';

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

const cipher = new SecretCipher(
  createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
);

function client(
  replies: Reply[] = [],
  overrides: Record<string, unknown> = {},
): { oauth: FacebookOAuthClient; calls: { url: URL; init: RequestInit }[] } {
  const { request, calls } = fakeFetch(replies);
  const values: Record<string, unknown> = {
    INSTAGRAM_APP_ID: APP_ID,
    INSTAGRAM_APP_SECRET: APP_SECRET,
    FACEBOOK_LOGIN_CONFIG_ID: CONFIG_ID,
    FACEBOOK_OAUTH_REDIRECT_URI: REDIRECT,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as never;
  return { oauth: new FacebookOAuthClient(config, cipher, request), calls };
}

const starter = {
  tenantId: '01a1ab8a-0000-7000-8000-000000000001',
  operatorId: '01a1ab8a-0000-7000-8000-000000000002',
  sessionId: '01a1ab8a-0000-7000-8000-000000000003',
};

describe('Facebook Page connect (ADR 040): setup and state', () => {
  it('is configured only with the Meta app, configuration id and redirect URI', () => {
    expect(client().oauth.configured).toBe(true);
    for (const key of [
      'FACEBOOK_LOGIN_CONFIG_ID',
      'FACEBOOK_OAUTH_REDIRECT_URI',
      'INSTAGRAM_APP_ID',
      'INSTAGRAM_APP_SECRET',
    ])
      expect(client([], { [key]: undefined }).oauth.configured).toBe(false);
  });

  it('opens the Facebook Login for Business dialog with config_id and code', () => {
    const url = new URL(client().oauth.authorizeUrl('st4te'));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.facebook.com/v27.0/dialog/oauth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      config_id: CONFIG_ID,
      override_default_response_type: 'true',
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 'st4te',
    });
  });

  it('refuses an Instagram state (another flow) and a foreign session', () => {
    const { oauth } = client();
    const values: Record<string, unknown> = {
      INSTAGRAM_APP_ID: APP_ID,
      INSTAGRAM_APP_SECRET: APP_SECRET,
      INSTAGRAM_LOGIN_CONFIG_ID: CONFIG_ID,
      INSTAGRAM_OAUTH_REDIRECT_URI: REDIRECT,
    };
    const instagram = new InstagramOAuthClient(
      { get: (key: string) => values[key] } as never,
      cipher,
    );
    expect(() => oauth.checkState(instagram.state(starter), starter)).toThrow(
      OAuthStateError,
    );
    expect(() =>
      oauth.checkState(oauth.state(starter), {
        ...starter,
        sessionId: '01a1ab8a-0000-7000-8000-000000000009',
      }),
    ).toThrow(OAuthStateError);
    expect(() => oauth.checkState(oauth.state(starter), starter)).not.toThrow();
  });
});

describe('Facebook Page connect: code exchange and Page discovery', () => {
  it('exchanges the code, extends the token and lists the granted Pages', async () => {
    const { oauth, calls } = client([
      { status: 200, body: { access_token: SHORT } },
      { status: 200, body: { access_token: LONG, expires_in: 5_183_944 } },
      {
        status: 200,
        body: {
          data: [
            { id: PAGE, name: ' Demo shop ', access_token: PAGE_TOKEN },
            { id: 'x', name: 'bad', access_token: PAGE_TOKEN },
            { id: '100000000000002', name: 'No token' },
          ],
        },
      },
    ]);
    await expect(oauth.exchange(CODE)).resolves.toEqual([
      { pageId: PAGE, name: 'Demo shop', pageToken: PAGE_TOKEN },
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
      fb_exchange_token: SHORT,
    });
    expect(list!.url.pathname).toBe('/v27.0/me/accounts');
    expect(list!.url.searchParams.get('fields')).toBe('id,name,access_token');
    expect(list!.url.searchParams.get('access_token')).toBe(LONG);
  });

  it('uses the first token when Meta refuses to extend it (system-user token)', async () => {
    const { oauth, calls } = client([
      { status: 200, body: { access_token: SHORT } },
      { status: 400, body: { error: { code: 100 } } },
      { status: 200, body: { data: [] } },
    ]);
    await expect(oauth.exchange(CODE)).resolves.toEqual([]);
    expect(calls[2]!.url.searchParams.get('access_token')).toBe(SHORT);
  });

  it('stops on a temporary failure while extending, and on a refused code', async () => {
    await expect(
      client([
        { status: 200, body: { access_token: SHORT } },
        { status: 500, body: { error: { code: 2 } } },
      ]).oauth.exchange(CODE),
    ).rejects.toMatchObject({ kind: 'temporary' });
    const refused = await client([
      { status: 400, body: { error: { code: 100, message: 'secret detail' } } },
    ])
      .oauth.exchange(CODE)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InstagramApiError);
    expect((refused as Error).message).not.toContain('secret detail');
  });
});

describe('Messenger Graph calls', () => {
  it('subscribes the Page with form data and requires success: true', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { success: true } },
      { status: 200, body: { success: false } },
    ]);
    const graph = new InstagramGraphClient(request);
    await graph.subscribeMessengerPage(PAGE, PAGE_TOKEN, ['messages']);
    const [call] = calls;
    expect(`${call!.url.origin}${call!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/${PAGE}/subscribed_apps`,
    );
    expect(call!.url.search).toBe('');
    expect(
      Object.fromEntries(new URLSearchParams(String(call!.init.body))),
    ).toEqual({ subscribed_fields: 'messages', access_token: PAGE_TOKEN });
    await expect(
      graph.subscribeMessengerPage(PAGE, PAGE_TOKEN, ['messages']),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('sends a RESPONSE text as the Page to /<PAGE_ID>/messages', async () => {
    const { request, calls } = fakeFetch([
      { status: 200, body: { recipient_id: PSID, message_id: 'm_1' } },
      new Error('socket hang up'),
    ]);
    const graph = new InstagramGraphClient(request);
    await expect(
      graph.sendMessengerText(PAGE, PAGE_TOKEN, PSID, 'Salom'),
    ).resolves.toEqual({ messageId: 'm_1' });
    expect(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/${PAGE}/messages`,
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      recipient: { id: PSID },
      messaging_type: 'RESPONSE',
      message: { text: 'Salom' },
    });
    await expect(
      graph.sendMessengerText(PAGE, PAGE_TOKEN, PSID, 'hi'),
    ).rejects.toBeInstanceOf(InstagramAmbiguousSendError);
    await expect(
      graph.sendMessengerText('../me', PAGE_TOKEN, PSID, 'hi'),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(2);
  });
});
