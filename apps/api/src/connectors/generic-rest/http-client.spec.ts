import { getEventListeners } from 'node:events';
import type { Dispatcher } from 'undici';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ConnectorErrorCategory } from '../interfaces/errors.js';
import {
  eventually,
  generateTestCertificates,
  json,
  opensslAvailable,
  recordingDispatcherFactory,
  startHttpServer,
  startHttpsServer,
  type LocalServer,
  type RecordingFactory,
  type TestCertificates,
} from '../testing/local-http.js';
import type { HostResolver } from './dns-pinning.js';
import {
  parseRetryAfterMs,
  RestHttpClient,
  sendJson,
  type RestHttpClientOptions,
} from './http-client.js';
import { OutboundUrlPolicy } from './ssrf-protection.js';

/**
 * Connection-path tests: every request below goes through a real undici
 * Agent and a real socket to a loopback server. Hostnames use reserved TLDs
 * (`.test`, `.invalid`) that system DNS cannot resolve, so a successful
 * request proves the socket used the pinned address.
 */

const loopback: HostResolver = async () => [
  { address: '127.0.0.1', family: 4 },
];

const servers: LocalServer[] = [];
async function server(
  handler: Parameters<typeof startHttpServer>[0],
): Promise<LocalServer> {
  const started = await startHttpServer(handler);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
  vi.unstubAllEnvs();
});

function client(overrides: Partial<RestHttpClientOptions> = {}): {
  http: RestHttpClient;
  recording: RecordingFactory;
} {
  const recording = recordingDispatcherFactory();
  const http = new RestHttpClient({
    defaultTimeoutMs: 2_000,
    resolve: loopback,
    exemptLoopbackAddresses: ['127.0.0.1'],
    createDispatcher: recording.factory,
    ...overrides,
  });
  return { http, recording };
}

describe('RestHttpClient response lifecycle', () => {
  it('keeps the dispatcher open until a large body is consumed, then releases it', async () => {
    // Several MB: far beyond socket/stream buffers, so closing the dispatcher
    // before reading the body would stall until the deadline.
    const items = Array.from({ length: 40_000 }, (_, index) => ({
      id: `item-${index}`,
      title: 'x'.repeat(64),
    }));
    const local = await server((_request, response) =>
      json(response, 200, { data: items }),
    );
    const { http, recording } = client();

    const response = await http.send({
      method: 'GET',
      url: `http://pinned.invalid:${local.port}/items?page=1`,
    });

    expect(response.status).toBe(200);
    expect((response.body as { data: unknown[] }).data).toHaveLength(40_000);
    expect(recording.dispatchers).toHaveLength(1);
    expect(recording.allReleased()).toBe(true);
    expect(await eventually(() => local.openSockets() === 0)).toBe(true);
    // The original hostname is preserved for HTTP host routing.
    expect(local.requests[0].headers.host).toBe(`pinned.invalid:${local.port}`);
  });

  it('connects to the pinned address, resolving once per hop', async () => {
    const local = await server((_request, response) =>
      json(response, 200, { ok: true }),
    );
    const resolve = vi.fn(loopback);
    const { http } = client({ resolve });

    await http.send({ method: 'GET', url: `http://crm.test:${local.port}/` });

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('crm.test', { source: undefined });
    expect(local.totalConnections()).toBe(1);
  });

  it('removes its listener from the caller signal after completion', async () => {
    const local = await server((_request, response) => json(response, 200, {}));
    const { http } = client();
    const controller = new AbortController();

    await http.send({
      method: 'GET',
      url: `http://crm.test:${local.port}/`,
      signal: controller.signal,
    });

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('returns an empty body as undefined and non-JSON bodies as text', async () => {
    const local = await server((request, response) => {
      if (request.url === '/empty') {
        response.writeHead(204).end();
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('pong');
      }
    });
    const { http } = client();

    await expect(
      http.send({
        method: 'DELETE',
        url: `http://crm.test:${local.port}/empty`,
      }),
    ).resolves.toMatchObject({ status: 204, body: undefined });
    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/text` }),
    ).resolves.toMatchObject({ status: 200, body: 'pong' });
  });

  it('sends JSON bodies for writes and never for GET', async () => {
    const local = await server((_request, response) => json(response, 201, {}));
    const { http } = client();

    await http.send({
      method: 'POST',
      url: `http://crm.test:${local.port}/leads`,
      body: { summary: 'fictional lead' },
    });
    await http.send({
      method: 'GET',
      url: `http://crm.test:${local.port}/items`,
      body: { ignored: true },
    });

    expect(local.requests[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(local.requests[0].body)).toEqual({
      summary: 'fictional lead',
    });
    expect(local.requests[1].body).toBe('');
  });
});

describe('RestHttpClient failures and cleanup', () => {
  it('rejects invalid JSON and still releases the dispatcher', async () => {
    const local = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data": [1, 2');
    });
    const { http, recording } = client();

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_INVALID_JSON',
      category: ConnectorErrorCategory.INVALID_RESPONSE,
    });
    expect(recording.allReleased()).toBe(true);
  });

  it('maps a body cut off mid-stream to a retryable network failure', async () => {
    const local = await server((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.write('{"data": [');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const { http, recording } = client();

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_NETWORK_FAILURE',
      retryable: true,
    });
    expect(recording.allReleased()).toBe(true);
  });

  it('aborts responses over the size limit while streaming', async () => {
    const local = await server((_request, response) =>
      json(response, 200, { blob: 'x'.repeat(10_000) }),
    );
    const { http, recording } = client({ maxResponseBytes: 1_024 });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_RESPONSE_TOO_LARGE' });
    expect(recording.allReleased()).toBe(true);
  });

  it('times out a server that never answers and closes the socket', async () => {
    const local = await server(() => {
      // Never respond.
    });
    const { http, recording } = client();
    const started = Date.now();

    await expect(
      http.send({
        method: 'GET',
        url: `http://crm.test:${local.port}/`,
        timeoutMs: 150,
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_TIMEOUT',
      category: ConnectorErrorCategory.TIMEOUT,
      retryable: true,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(recording.allReleased()).toBe(true);
    expect(await eventually(() => local.openSockets() === 0)).toBe(true);
  });

  it('applies the deadline to body consumption, not only to headers', async () => {
    const local = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data": [');
      // Stall forever after the headers.
    });
    const { http, recording } = client();

    await expect(
      http.send({
        method: 'GET',
        url: `http://crm.test:${local.port}/`,
        timeoutMs: 150,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_TIMEOUT' });
    expect(recording.allReleased()).toBe(true);
  });

  it('times out a resolver that never answers', async () => {
    const { http, recording } = client({
      resolve: () => new Promise(() => undefined),
    });

    await expect(
      http.send({ method: 'GET', url: 'https://crm.test/', timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_TIMEOUT' });
    expect(recording.dispatchers).toHaveLength(0);
  });

  it('distinguishes caller cancellation from timeouts', async () => {
    const local = await server(() => undefined);
    const { http, recording } = client();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      http.send({
        method: 'GET',
        url: `http://crm.test:${local.port}/`,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_REQUEST_CANCELLED',
      category: ConnectorErrorCategory.CANCELLED,
      retryable: false,
    });
    expect(recording.allReleased()).toBe(true);
  });

  it('does not connect when the caller signal is already aborted', async () => {
    const { http, recording } = client();
    await expect(
      http.send({
        method: 'GET',
        url: 'https://crm.test/',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_REQUEST_CANCELLED' });
    expect(recording.dispatchers).toHaveLength(0);
  });

  it('does not let a cleanup failure replace a successful response', async () => {
    const cleanupErrors: unknown[] = [];
    const local = await server((_request, response) =>
      json(response, 200, { ok: true }),
    );
    const recording = recordingDispatcherFactory(
      (dispatcher) =>
        new Proxy(dispatcher, {
          get(target, property): unknown {
            if (property === 'close') {
              return async () => {
                await target.close();
                throw new Error('close failed');
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as Dispatcher,
    );
    const http = new RestHttpClient({
      resolve: loopback,
      exemptLoopbackAddresses: ['127.0.0.1'],
      createDispatcher: recording.factory,
      onCleanupError: (error): void => {
        cleanupErrors.push(error);
      },
    });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).resolves.toMatchObject({ status: 200 });
    expect(cleanupErrors).toEqual([new Error('close failed')]);
  });

  it('does not let a cleanup failure mask the original error', async () => {
    const local = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json');
    });
    const recording = recordingDispatcherFactory(
      (dispatcher) =>
        new Proxy(dispatcher, {
          get(target, property): unknown {
            if (property === 'close' || property === 'destroy') {
              return async () => {
                await target.destroy();
                throw new Error('cleanup failed');
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as Dispatcher,
    );
    const http = new RestHttpClient({
      resolve: loopback,
      exemptLoopbackAddresses: ['127.0.0.1'],
      createDispatcher: recording.factory,
      onCleanupError: (): void => undefined,
    });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_JSON' });
  });
});

describe('RestHttpClient destination policy', () => {
  it('never opens a socket when DNS fails (no unpinned fallback)', async () => {
    const { http, recording } = client({
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
          code: 'ENOTFOUND',
        });
      },
    });

    await expect(
      http.send({ method: 'GET', url: 'https://crm.test/' }),
    ).rejects.toMatchObject({ category: ConnectorErrorCategory.UNAVAILABLE });
    expect(recording.dispatchers).toHaveLength(0);
  });

  it.each([
    [[{ address: '10.0.0.5', family: 4 }]],
    [[{ address: '169.254.169.254', family: 4 }]],
    [[{ address: '::1', family: 6 }]],
    [
      [
        { address: '127.0.0.1', family: 4 },
        { address: '192.168.1.20', family: 4 },
      ],
    ],
  ])('blocks a hostname resolving to %o before connecting', async (answer) => {
    const local = await server((_request, response) => json(response, 200, {}));
    const { http, recording } = client({ resolve: async () => answer });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' });
    expect(recording.dispatchers).toHaveLength(0);
    expect(local.totalConnections()).toBe(0);
  });

  it('rejects malformed or family-mismatched resolver answers', async () => {
    for (const answer of [
      [{ address: '127.0.0.1', family: 6 }],
      [{ address: '127.0.0.1', family: 5 }],
      [],
    ]) {
      const { http, recording } = client({ resolve: async () => answer });
      await expect(
        http.send({ method: 'GET', url: 'https://crm.test/' }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /^CONNECTOR_DNS_(UNEXPECTED_ADDRESS|EMPTY)$/,
        ),
      });
      expect(recording.dispatchers).toHaveLength(0);
    }
  });

  it('pins to every validated address of a multi-address answer', async () => {
    const local = await server((_request, response) => json(response, 200, {}));
    const { http, recording } = client({
      // ::1 is exempt too, but nothing listens there; the pinned list is
      // handed to Node's connection logic, which reaches 127.0.0.1.
      resolve: async () => [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ],
      exemptLoopbackAddresses: ['127.0.0.1', '::1'],
    });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).resolves.toMatchObject({ status: 200 });
    expect(recording.allReleased()).toBe(true);
  });

  it('requires https under STRICT unless every address is an exempt loopback', async () => {
    const { http, recording } = client({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    await expect(
      http.send({ method: 'GET', url: 'http://crm.test/' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_INSECURE_PROTOCOL' });
    expect(recording.dispatchers).toHaveLength(0);
  });

  it('rejects URLs with embedded credentials before any resolution', async () => {
    const resolve = vi.fn(loopback);
    const { http } = client({ resolve });
    await expect(
      http.send({ method: 'GET', url: 'https://user:pw@crm.test/' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_URL_CREDENTIALS' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses test allowances in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      () => new RestHttpClient({ exemptLoopbackAddresses: ['127.0.0.1'] }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONNECTOR_TEST_ALLOWANCE_IN_PRODUCTION',
      }),
    );
    expect(
      () => new RestHttpClient({ trustedCertificates: ['-----BEGIN'] }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONNECTOR_TEST_ALLOWANCE_IN_PRODUCTION',
      }),
    );
    expect(() => new RestHttpClient()).not.toThrow();
  });

  it('defaults to STRICT with no exemptions', async () => {
    const http = new RestHttpClient({ resolve: loopback });
    await expect(
      http.send({ method: 'GET', url: 'https://crm.test/' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' });
  });

  it('still pins under the PERMISSIVE development policy', async () => {
    const local = await server((_request, response) => json(response, 200, {}));
    const resolve = vi.fn(loopback);
    const recording = recordingDispatcherFactory();
    const http = new RestHttpClient({
      policy: OutboundUrlPolicy.PERMISSIVE,
      resolve,
      createDispatcher: recording.factory,
    });

    await http.send({
      method: 'GET',
      url: `http://dev.invalid:${local.port}/`,
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(recording.dispatchers).toHaveLength(1);
  });
});

describe('RestHttpClient redirects', () => {
  it('follows a same-origin redirect, keeps credentials and releases both hops', async () => {
    const local = await server((request, response) => {
      if (request.url === '/start') {
        // A redirect body larger than the dump limit is cancelled, not read.
        response.writeHead(302, {
          location: '/final',
          'content-type': 'text/plain',
        });
        response.end('r'.repeat(200_000));
        return;
      }
      json(response, 200, { at: request.url });
    });
    const { http, recording } = client();

    const response = await http.send({
      method: 'GET',
      url: `http://crm.test:${local.port}/start`,
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(response.body).toEqual({ at: '/final' });
    expect(local.requests.map((request) => request.url)).toEqual([
      '/start',
      '/final',
    ]);
    expect(local.requests[1].headers.authorization).toBe('Bearer test-token');
    expect(recording.dispatchers).toHaveLength(2);
    expect(recording.allReleased()).toBe(true);
  });

  it('strips credentials and custom headers on a cross-origin redirect', async () => {
    const other = await server((_request, response) =>
      json(response, 200, { other: true }),
    );
    const origin = await server((_request, response) => {
      response.writeHead(302, {
        location: `http://other.test:${other.port}/landing`,
      });
      response.end();
    });
    const { http } = client();

    await expect(
      http.send({
        method: 'GET',
        url: `http://crm.test:${origin.port}/start`,
        headers: {
          authorization: 'Bearer test-token',
          'x-api-key': 'test-key',
          cookie: 'session=1',
        },
      }),
    ).resolves.toMatchObject({ body: { other: true } });

    const forwarded = other.requests[0].headers;
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded['x-api-key']).toBeUndefined();
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded.accept).toBe('application/json');
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://localhost/admin', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://[::ffff:127.0.0.1]/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['file:///etc/passwd', 'CONNECTOR_INVALID_PROTOCOL'],
    ['http://user:pw@crm.test/', 'CONNECTOR_URL_CREDENTIALS'],
  ])('re-validates redirect target %s', async (location, code) => {
    const local = await server((_request, response) => {
      response.writeHead(302, { location });
      response.end();
    });
    const { http, recording } = client();

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code });
    expect(recording.dispatchers).toHaveLength(1);
    expect(recording.allReleased()).toBe(true);
  });

  it('re-resolves and blocks a redirect to a host that resolves privately', async () => {
    const local = await server((_request, response) => {
      response.writeHead(307, { location: 'http://internal.test/secrets' });
      response.end();
    });
    const resolve: HostResolver = async (hostname) =>
      hostname === 'internal.test'
        ? [{ address: '10.0.0.5', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    const { http, recording } = client({ resolve });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' });
    expect(recording.dispatchers).toHaveLength(1);
  });

  it('rejects a redirect downgrade to plain http on a public address', async () => {
    const local = await server((_request, response) => {
      response.writeHead(301, { location: 'http://public.test/' });
      response.end();
    });
    const resolve: HostResolver = async (hostname) =>
      hostname === 'public.test'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    const { http, recording } = client({ resolve });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_INSECURE_PROTOCOL' });
    expect(recording.dispatchers).toHaveLength(1);
  });

  it('enforces the redirect limit', async () => {
    const local = await server((request, response) => {
      const step = Number(request.url?.slice(1) ?? '0');
      response.writeHead(302, { location: `/${step + 1}` });
      response.end();
    });
    const { http, recording } = client({ maxRedirects: 2 });

    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/0` }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_TOO_MANY_REDIRECTS',
      retryable: false,
    });
    expect(local.requests).toHaveLength(3);
    expect(recording.allReleased()).toBe(true);
  });

  it('does not follow redirects when maxRedirects is 0', async () => {
    const local = await server((_request, response) => {
      response.writeHead(302, { location: '/next' });
      response.end();
    });
    const { http } = client({ maxRedirects: 0 });
    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_TOO_MANY_REDIRECTS' });
    expect(local.requests).toHaveLength(1);
  });

  it('refuses to replay a request body to another origin', async () => {
    const other = await server((_request, response) => json(response, 200, {}));
    const origin = await server((_request, response) => {
      response.writeHead(307, {
        location: `http://other.test:${other.port}/leads`,
      });
      response.end();
    });
    const { http } = client();

    await expect(
      http.send({
        method: 'POST',
        url: `http://crm.test:${origin.port}/leads`,
        body: { contact: { phone: '+000 fictional' } },
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_REDIRECT_BLOCKED' });
    expect(other.totalConnections()).toBe(0);
  });

  it('replays method and body on a same-origin 307 and degrades POST on 303', async () => {
    const local = await server((request, response) => {
      if (request.url === '/temporary') {
        response.writeHead(307, { location: '/created' }).end();
      } else if (request.url === '/see-other') {
        response.writeHead(303, { location: '/result' }).end();
      } else {
        json(response, 200, { method: request.method, body: request.bodyText });
      }
    });
    const { http } = client();

    await expect(
      http.send({
        method: 'POST',
        url: `http://crm.test:${local.port}/temporary`,
        body: { a: 1 },
      }),
    ).resolves.toMatchObject({ body: { method: 'POST', body: '{"a":1}' } });
    await expect(
      http.send({
        method: 'POST',
        url: `http://crm.test:${local.port}/see-other`,
        body: { a: 1 },
      }),
    ).resolves.toMatchObject({ body: { method: 'GET', body: '' } });
  });

  it('treats a redirect status without Location as a final response', async () => {
    const local = await server((_request, response) => {
      response.writeHead(302).end();
    });
    const { http } = client();
    await expect(
      http.send({ method: 'GET', url: `http://crm.test:${local.port}/` }),
    ).resolves.toMatchObject({ status: 302, ok: false });
  });
});

describe.skipIf(!opensslAvailable())('RestHttpClient TLS verification', () => {
  let certificates: TestCertificates;
  let tlsServer: LocalServer;

  beforeAll(async () => {
    certificates = generateTestCertificates('pinned.test');
    tlsServer = await startHttpsServer(
      (_request, response) => json(response, 200, { secure: true }),
      certificates,
    );
  });

  afterAll(async () => {
    await tlsServer?.close();
  });

  it('verifies the certificate against the original hostname while connecting to the pinned IP', async () => {
    const { http } = client({ trustedCertificates: [certificates.ca] });
    await expect(
      http.send({
        method: 'GET',
        url: `https://pinned.test:${tlsServer.port}/`,
      }),
    ).resolves.toMatchObject({ status: 200, body: { secure: true } });
  });

  it('rejects a certificate that does not match the requested hostname', async () => {
    const { http, recording } = client({
      trustedCertificates: [certificates.ca],
    });
    await expect(
      http.send({
        method: 'GET',
        url: `https://wrong.test:${tlsServer.port}/`,
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_TLS_FAILURE',
      retryable: false,
    });
    expect(recording.allReleased()).toBe(true);
  });

  it('rejects a certificate from an untrusted CA', async () => {
    const { http } = client();
    await expect(
      http.send({
        method: 'GET',
        url: `https://pinned.test:${tlsServer.port}/`,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_TLS_FAILURE' });
  });

  it('keeps verifying even when NODE_TLS_REJECT_UNAUTHORIZED=0 is set', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    const warning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    try {
      const { http } = client();
      await expect(
        http.send({
          method: 'GET',
          url: `https://pinned.test:${tlsServer.port}/`,
        }),
      ).rejects.toMatchObject({ code: 'CONNECTOR_TLS_FAILURE' });
    } finally {
      warning.mockRestore();
    }
  });
});

describe('sendJson error model', () => {
  async function respondWith(
    status: number,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const local = await server((_request, response) =>
      json(
        response,
        status,
        { message: 'customer phone +000-fictional echoed by upstream' },
        headers,
      ),
    );
    const { http } = client();
    return sendJson(
      {
        method: 'GET',
        url: `http://crm.test:${local.port}/items?q=private-search-text`,
      },
      http,
    ).catch((error: unknown) => error);
  }

  it.each([
    [
      401,
      'CONNECTOR_UNAUTHORIZED',
      ConnectorErrorCategory.AUTHENTICATION,
      false,
    ],
    [403, 'CONNECTOR_FORBIDDEN', ConnectorErrorCategory.AUTHORIZATION, false],
    [404, 'CONNECTOR_NOT_FOUND', ConnectorErrorCategory.NOT_FOUND, false],
    [400, 'CONNECTOR_REQUEST_FAILED', ConnectorErrorCategory.VALIDATION, false],
    [418, 'CONNECTOR_REQUEST_FAILED', ConnectorErrorCategory.UNKNOWN, false],
    [429, 'CONNECTOR_RATE_LIMITED', ConnectorErrorCategory.RATE_LIMITED, true],
    [500, 'CONNECTOR_UPSTREAM_ERROR', ConnectorErrorCategory.UNAVAILABLE, true],
    [503, 'CONNECTOR_UPSTREAM_ERROR', ConnectorErrorCategory.UNAVAILABLE, true],
    [501, 'CONNECTOR_REQUEST_FAILED', ConnectorErrorCategory.UNKNOWN, false],
  ])('maps %i to %s', async (status, code, category, retryable) => {
    const error = (await respondWith(status)) as Error & {
      code: string;
      category: string;
      retryable: boolean;
    };
    expect(error).toMatchObject({ code, category, retryable });
    // Messages never include the query string or upstream response text.
    expect(error.message).not.toContain('private-search-text');
    expect(error.message).not.toContain('fictional');
  });

  it('carries Retry-After on rate limits', async () => {
    await expect(
      respondWith(429, { 'retry-after': '2' }),
    ).resolves.toMatchObject({ retryAfterMs: 2_000 });
  });

  it('rejects a 2xx response that is not JSON', async () => {
    const local = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
    });
    const { http } = client();
    await expect(
      sendJson({ method: 'GET', url: `http://crm.test:${local.port}/` }, http),
    ).rejects.toMatchObject({ code: 'CONNECTOR_UNEXPECTED_CONTENT_TYPE' });
  });

  it('accepts structured-syntax JSON media types', async () => {
    const local = await server((_request, response) => {
      response
        .writeHead(200, {
          'content-type': 'application/vnd.api+json; charset=utf-8',
        })
        .end('{"data":[]}');
    });
    const { http } = client();
    await expect(
      sendJson({ method: 'GET', url: `http://crm.test:${local.port}/` }, http),
    ).resolves.toMatchObject({ body: { data: [] } });
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and HTTP dates and rejects nonsense', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5_000);
    expect(parseRetryAfterMs('Fri, 23 Oct 2026 10:00:30 GMT', now)).toBe(
      30_000,
    );
    expect(parseRetryAfterMs('Fri, 23 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('-1', now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs('999999', now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});
