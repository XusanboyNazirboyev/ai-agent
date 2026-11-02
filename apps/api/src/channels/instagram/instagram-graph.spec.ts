import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyInstagramError,
  InstagramAmbiguousSendError,
  InstagramApiError,
  InstagramGraphClient,
  INSTAGRAM_GRAPH_BASE_URL,
} from './instagram-graph.js';

/** Generated per run: never a real or credential-shaped literal. */
const TOKEN = `test-${randomBytes(16).toString('hex')}`;
const IG = '17841400000000001';
const IGSID = '9876543210';

type Reply = { status: number; body?: unknown } | Error;

function client(replies: Reply[]): {
  graph: InstagramGraphClient;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply scripted');
    if (reply instanceof Error) throw reply;
    return new Response(
      reply.body === undefined ? 'not json' : JSON.stringify(reply.body),
      { status: reply.status },
    );
  });
  return {
    graph: new InstagramGraphClient(request as unknown as typeof fetch),
    calls,
  };
}

const metaError = (code: number, status = 400): Reply => ({
  status,
  body: {
    error: { message: 'secret detail', type: 'OAuthException', code },
  },
});

describe('Instagram Graph client: send', () => {
  it('posts the documented body with a bearer token and returns message_id', async () => {
    const { graph, calls } = client([
      { status: 200, body: { recipient_id: IGSID, message_id: 'mid.1' } },
    ]);
    await expect(graph.sendText(IG, TOKEN, IGSID, 'Salom')).resolves.toEqual({
      messageId: 'mid.1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/${IG}/messages`);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.init.method).toBe('POST');
    expect(
      (calls[0]?.init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      recipient: { id: IGSID },
      message: { text: 'Salom' },
    });
  });

  it.each([
    [190, 'token', false],
    [102, 'token', false],
    [10, 'permission', false],
    [200, 'permission', false],
    [100, 'rejected', false],
    [4, 'rate_limited', true],
    [17, 'rate_limited', true],
    [613, 'rate_limited', true],
    [2, 'temporary', true],
  ] as const)(
    'maps Meta error %i to %s (retryable: %s), without the token or Meta text',
    async (code, kind, retryable) => {
      const { graph } = client([metaError(code)]);
      const error = await graph
        .sendText(IG, TOKEN, IGSID, 'Salom')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InstagramApiError);
      expect(error).toMatchObject({ kind, code, retryable });
      expect(String((error as Error).message)).not.toContain(TOKEN);
      expect(String((error as Error).message)).not.toContain('secret detail');
    },
  );

  it('treats HTTP 429 and 5xx without a Meta code as retryable', async () => {
    const { graph } = client([{ status: 429 }, { status: 503 }]);
    await expect(graph.sendText(IG, TOKEN, IGSID, 'a')).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    });
    await expect(graph.sendText(IG, TOKEN, IGSID, 'a')).rejects.toMatchObject({
      kind: 'temporary',
      retryable: true,
    });
  });

  it('reports a lost response or a success without message_id as ambiguous', async () => {
    const { graph } = client([
      new TypeError('socket hang up'),
      { status: 200, body: { recipient_id: IGSID } },
      { status: 200 },
    ]);
    for (let i = 0; i < 3; i++)
      await expect(
        graph.sendText(IG, TOKEN, IGSID, 'a'),
      ).rejects.toBeInstanceOf(InstagramAmbiguousSendError);
  });

  it('refuses text over 1,000 bytes and non-numeric ids before any request', async () => {
    const { graph, calls } = client([]);
    // 501 Cyrillic letters are 1,002 bytes.
    await expect(
      graph.sendText(IG, TOKEN, IGSID, 'я'.repeat(501)),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(graph.sendText(IG, TOKEN, IGSID, '')).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      graph.sendText('../me', TOKEN, IGSID, 'a'),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      graph.sendText(IG, TOKEN, 'x/../y', 'a'),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe('Instagram Graph client: account and webhook subscription', () => {
  it('reads user_id (the webhook entry id) and username', async () => {
    const { graph, calls } = client([
      { status: 200, body: { user_id: IG, username: 'demo_shop', id: '1' } },
      { status: 200, body: { user_id: 17841400000000002 } },
    ]);
    await expect(graph.me(TOKEN)).resolves.toEqual({
      userId: IG,
      username: 'demo_shop',
    });
    await expect(graph.me(TOKEN)).resolves.toEqual({
      userId: '17841400000000002',
      username: null,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v26.0/me');
    expect(url.searchParams.get('fields')).toBe('user_id,username');
  });

  it('rejects a /me answer without a numeric user_id, and maps errors', async () => {
    const { graph } = client([
      { status: 200, body: { username: 'x' } },
      metaError(190),
      new TypeError('offline'),
    ]);
    await expect(graph.me(TOKEN)).rejects.toMatchObject({ kind: 'rejected' });
    await expect(graph.me(TOKEN)).rejects.toMatchObject({ kind: 'token' });
    await expect(graph.me(TOKEN)).rejects.toMatchObject({ kind: 'temporary' });
  });

  it('subscribes the account to the messages field and requires success: true', async () => {
    const { graph, calls } = client([
      { status: 200, body: { success: true } },
      { status: 200, body: { success: false } },
    ]);
    await graph.subscribe(IG, TOKEN, ['messages']);
    const url = new URL(calls[0]!.url);
    expect(calls[0]?.init.method).toBe('POST');
    expect(url.pathname).toBe(`/v26.0/${IG}/subscribed_apps`);
    expect(url.searchParams.get('subscribed_fields')).toBe('messages');
    await expect(
      graph.subscribe(IG, TOKEN, ['messages']),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('uses the configured test base URL', async () => {
    const request = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ user_id: IG }), { status: 200 }),
    );
    const graph = new InstagramGraphClient(
      request as unknown as typeof fetch,
      { get: () => 'http://127.0.0.1:9999/v26.0/' } as never,
    );
    await graph.me(TOKEN);
    expect(String(request.mock.calls[0]?.[0])).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/v26\.0\/me\?/u,
    );
  });
});

describe('classifyInstagramError', () => {
  it('falls back to the HTTP status when Meta sends no code', () => {
    expect(classifyInstagramError(null, 400)).toBe('rejected');
    expect(classifyInstagramError(null, 500)).toBe('temporary');
    expect(classifyInstagramError(341, 400)).toBe('rate_limited');
    expect(classifyInstagramError(368, 400)).toBe('temporary');
  });
});
