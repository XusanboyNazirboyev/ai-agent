import { Readable } from 'node:stream';
import type { Dispatcher } from 'undici';
import { describe, expect, it } from 'vitest';
import { downloadPublicMedia } from './media-download.js';

/** A dispatcher double answering one canned response; records the request. */
function fakeDispatcher(response: {
  statusCode: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
}): {
  factory: () => Dispatcher;
  requests: Array<{ origin: string; path: string; headers: unknown }>;
  released: { closed: number; destroyed: number };
} {
  const requests: Array<{ origin: string; path: string; headers: unknown }> =
    [];
  const released = { closed: 0, destroyed: 0 };
  const dispatcher = {
    request: (options: {
      origin: string;
      path: string;
      headers: unknown;
    }): Promise<unknown> => {
      requests.push(options);
      const body = Readable.from(response.chunks ?? []) as Readable & {
        dump: () => Promise<void>;
      };
      body.dump = (): Promise<void> => Promise.resolve();
      return Promise.resolve({
        statusCode: response.statusCode,
        headers: response.headers ?? {},
        body,
      });
    },
    close: (): Promise<void> => {
      released.closed += 1;
      return Promise.resolve();
    },
    destroy: (): Promise<void> => {
      released.destroyed += 1;
      return Promise.resolve();
    },
  };
  return {
    factory: () => dispatcher as unknown as Dispatcher,
    requests,
    released,
  };
}

const PUBLIC = (): Promise<Array<{ address: string; family: number }>> =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

const URL_OK = 'https://cdn.example.test/voice/abc?sig=1';

describe('downloadPublicMedia (untrusted webhook URLs)', () => {
  it('downloads over https from a public address, with no credentials', async () => {
    const d = fakeDispatcher({
      statusCode: 200,
      headers: { 'content-type': 'audio/mp4; codecs=mp4a.40.2' },
      chunks: [new Uint8Array([1, 2]), new Uint8Array([3])],
    });
    const result = await downloadPublicMedia(URL_OK, {
      maxBytes: 1_000,
      timeoutMs: 1_000,
      resolve: PUBLIC,
      createDispatcher: d.factory,
    });
    expect(result).toEqual({
      ok: true,
      data: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mp4',
    });
    expect(d.requests[0]!.origin).toBe('https://cdn.example.test');
    expect(d.requests[0]!.path).toBe('/voice/abc?sig=1');
    expect(JSON.stringify(d.requests[0]!.headers).toLowerCase()).not.toContain(
      'authorization',
    );
    expect(d.released.closed).toBe(1);
  });

  it('refuses everything that is not a plain public https URL, before any request', async () => {
    for (const url of [
      'http://cdn.example.test/a',
      'ftp://cdn.example.test/a',
      'https://user:pw@cdn.example.test/a',
      'https://cdn.example.test:8443/a',
      'https://localhost/a',
      'https://127.0.0.1/a',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      const d = fakeDispatcher({ statusCode: 200 });
      const result = await downloadPublicMedia(url, {
        maxBytes: 1_000,
        timeoutMs: 1_000,
        resolve: PUBLIC,
        createDispatcher: d.factory,
      });
      expect(result, url).toMatchObject({ ok: false });
      expect(d.requests, url).toHaveLength(0);
    }
  });

  it('refuses a host that resolves to a private address (DNS rebinding)', async () => {
    const d = fakeDispatcher({ statusCode: 200 });
    const result = await downloadPublicMedia(URL_OK, {
      maxBytes: 1_000,
      timeoutMs: 1_000,
      resolve: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
      createDispatcher: d.factory,
    });
    expect(result).toEqual({ ok: false, code: 'BLOCKED' });
    expect(d.requests).toHaveLength(0);
  });

  it('never follows a redirect and reports other HTTP failures', async () => {
    for (const statusCode of [301, 302, 403, 404, 500]) {
      const d = fakeDispatcher({
        statusCode,
        headers: { location: 'https://169.254.169.254/' },
      });
      const result = await downloadPublicMedia(URL_OK, {
        maxBytes: 1_000,
        timeoutMs: 1_000,
        resolve: PUBLIC,
        createDispatcher: d.factory,
      });
      expect(result).toEqual({ ok: false, code: 'HTTP_ERROR' });
      expect(d.requests).toHaveLength(1);
    }
  });

  it('rejects an oversize file by its declared length and by what actually arrives', async () => {
    const declared = fakeDispatcher({
      statusCode: 200,
      headers: { 'content-length': '5000' },
      chunks: [new Uint8Array(10)],
    });
    expect(
      await downloadPublicMedia(URL_OK, {
        maxBytes: 1_000,
        timeoutMs: 1_000,
        resolve: PUBLIC,
        createDispatcher: declared.factory,
      }),
    ).toEqual({ ok: false, code: 'TOO_LARGE' });
    expect(declared.released.destroyed).toBe(1);

    const streamed = fakeDispatcher({
      statusCode: 200,
      chunks: [new Uint8Array(600), new Uint8Array(600)],
    });
    expect(
      await downloadPublicMedia(URL_OK, {
        maxBytes: 1_000,
        timeoutMs: 1_000,
        resolve: PUBLIC,
        createDispatcher: streamed.factory,
      }),
    ).toEqual({ ok: false, code: 'TOO_LARGE' });
    expect(streamed.released.destroyed).toBe(1);
  });

  it('treats an empty body as a failure', async () => {
    const d = fakeDispatcher({ statusCode: 200, chunks: [] });
    expect(
      await downloadPublicMedia(URL_OK, {
        maxBytes: 1_000,
        timeoutMs: 1_000,
        resolve: PUBLIC,
        createDispatcher: d.factory,
      }),
    ).toEqual({ ok: false, code: 'HTTP_ERROR' });
  });
});
