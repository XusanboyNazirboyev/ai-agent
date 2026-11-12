import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TtsError } from './ports.js';
import { sanitizeSpeechText, VoxCpmTextToSpeech } from './voxcpm-tts.js';
import { buildWav } from './wav.js';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server | undefined;

async function start(
  handler: (seen: Seen) => {
    status?: number;
    type?: string;
    body?: Uint8Array | string;
    delayMs?: number;
  },
): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const record: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(record);
      const reply = handler(record);
      setTimeout(() => {
        response.writeHead(reply.status ?? 200, {
          'content-type': reply.type ?? 'audio/wav',
        });
        response.end(reply.body ?? '');
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/`, seen };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
});

describe('VoxCpmTextToSpeech', () => {
  it('posts the documented JSON and parses a WAV response', async () => {
    const wav = buildWav(48_000, 4800);
    const { baseUrl, seen } = await start(() => ({ body: wav }));
    const tts = new VoxCpmTextToSpeech({ baseUrl });
    const audio = await tts.synthesize({
      text: 'Hello there',
      language: 'en-US',
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/v1/audio/speech');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      model: 'openbmb/VoxCPM2',
      input: 'Hello there',
      voice: 'default',
    });
    expect(audio.mimeType).toBe('audio/wav');
    expect(audio.sampleRateHz).toBe(48_000);
    expect(audio.durationMs).toBe(100);
    expect(audio.bytes.length).toBe(wav.length);
  });

  it('uses configured model and voice, and the content type without parameters', async () => {
    const { baseUrl, seen } = await start(() => ({
      type: 'audio/mpeg; charset=binary',
      body: new Uint8Array([1, 2, 3]),
    }));
    const tts = new VoxCpmTextToSpeech({ baseUrl, model: 'm', voice: 'v' });
    const audio = await tts.synthesize({ text: 'privet', language: 'ru' });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({
      model: 'm',
      voice: 'v',
    });
    expect(audio).toMatchObject({
      mimeType: 'audio/mpeg',
      sampleRateHz: null,
      durationMs: null,
    });
  });

  it('sends the API key only when configured', async () => {
    const { baseUrl, seen } = await start(() => ({ body: buildWav(8000, 10) }));
    await new VoxCpmTextToSpeech({ baseUrl }).synthesize({
      text: 'a',
      language: 'en',
    });
    await new VoxCpmTextToSpeech({ baseUrl, apiKey: 'k-test' }).synthesize({
      text: 'a',
      language: 'en',
    });
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[1]?.headers.authorization).toBe('Bearer k-test');
  });

  it('maps a 500 to PROVIDER_UNAVAILABLE without leaking the body', async () => {
    const { baseUrl } = await start(() => ({
      status: 500,
      type: 'text/plain',
      body: 'secret-detail-in-body',
    }));
    const error = await new VoxCpmTextToSpeech({ baseUrl })
      .synthesize({ text: 'a', language: 'en' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TtsError);
    expect((error as TtsError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as TtsError).message).not.toContain('secret-detail');
  });

  it('maps an empty body to EMPTY_AUDIO', async () => {
    const { baseUrl } = await start(() => ({ body: '' }));
    await expect(
      new VoxCpmTextToSpeech({ baseUrl }).synthesize({
        text: 'a',
        language: 'en',
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_AUDIO' });
  });

  it('rejects a non-audio content type as INVALID_RESPONSE', async () => {
    const { baseUrl } = await start(() => ({
      type: 'application/json',
      body: '{"a":1}',
    }));
    await expect(
      new VoxCpmTextToSpeech({ baseUrl }).synthesize({
        text: 'a',
        language: 'en',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('times out slow servers', async () => {
    const { baseUrl } = await start(() => ({
      body: buildWav(8000, 10),
      delayMs: 1500,
    }));
    await expect(
      new VoxCpmTextToSpeech({ baseUrl, timeoutMs: 100 }).synthesize({
        text: 'a',
        language: 'en',
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('honours a caller abort', async () => {
    const { baseUrl } = await start(() => ({
      body: buildWav(8000, 10),
      delayMs: 1500,
    }));
    const controller = new AbortController();
    const pending = new VoxCpmTextToSpeech({ baseUrl }).synthesize({
      text: 'a',
      language: 'en',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports an unreachable server as PROVIDER_UNAVAILABLE', async () => {
    const { baseUrl } = await start(() => ({}));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(
      new VoxCpmTextToSpeech({ baseUrl }).synthesize({
        text: 'a',
        language: 'en',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('supports exactly ru and en and never calls the server for others', async () => {
    const { baseUrl, seen } = await start(() => ({ body: buildWav(8000, 10) }));
    const tts = new VoxCpmTextToSpeech({ baseUrl });
    expect(tts.supportsLanguage('ru-RU')).toBe(true);
    expect(tts.supportsLanguage('EN')).toBe(true);
    expect(tts.supportsLanguage('uz-Latn')).toBe(false);
    expect(tts.supportsLanguage('de')).toBe(false);
    expect(tts.supportsLanguage('')).toBe(false);
    await expect(
      tts.synthesize({ text: 'salom', language: 'uz-Latn' }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_LANGUAGE',
    });
    expect(seen).toHaveLength(0);
  });

  it('rejects text that is too long or empty after sanitising, without a request', async () => {
    const { baseUrl, seen } = await start(() => ({ body: buildWav(8000, 10) }));
    const tts = new VoxCpmTextToSpeech({ baseUrl, maxChars: 10 });
    await expect(
      tts.synthesize({ text: 'x'.repeat(11), language: 'en' }),
    ).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    await expect(
      tts.synthesize({ text: '(a young woman)', language: 'en' }),
    ).rejects.toMatchObject({ code: 'EMPTY_TEXT' });
    expect(seen).toHaveLength(0);
  });

  it('sends sanitised text only (no voice instruction)', async () => {
    const { baseUrl, seen } = await start(() => ({ body: buildWav(8000, 10) }));
    await new VoxCpmTextToSpeech({ baseUrl }).synthesize({
      text: '(A deep angry voice) Hello',
      language: 'en',
    });
    expect(JSON.parse(seen[0]?.body ?? '{}').input).toBe('Hello');
  });
});

describe('sanitizeSpeechText', () => {
  const code = (n: number): string => String.fromCharCode(n);

  it('strips leading parenthesised voice descriptions, nested and repeated', () => {
    expect(sanitizeSpeechText('(A young woman, gentle)Hello')).toBe('Hello');
    expect(sanitizeSpeechText('(a (b) c) (d) text')).toBe('text');
    expect(
      sanitizeSpeechText(`${code(0xff08)}voice${code(0xff09)}Privet`),
    ).toBe('Privet');
  });

  it('drops only the bracket of an unclosed leading group', () => {
    expect(sanitizeSpeechText('(unclosed words')).toBe('unclosed words');
  });

  it('keeps parentheses that are not leading', () => {
    expect(sanitizeSpeechText('Hello (world)')).toBe('Hello (world)');
  });

  it('removes control characters and collapses whitespace', () => {
    expect(sanitizeSpeechText(`a${code(0)}b${code(7)}c`)).toBe('abc');
    expect(sanitizeSpeechText('a\n\n  b\t c ')).toBe('a b c');
    expect(sanitizeSpeechText(`a${code(0x200b)}b${code(0xfeff)}c`)).toBe('abc');
  });

  it('hides a parenthesis behind a leading newline or control character', () => {
    expect(sanitizeSpeechText(`\n${code(0)}(voice) Hi`)).toBe('Hi');
  });
});
