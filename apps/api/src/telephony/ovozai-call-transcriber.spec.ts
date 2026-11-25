import { describe, expect, it } from 'vitest';
import {
  OVOZAI_TRANSCRIPTIONS_URL,
  OvozAiCallTranscriber,
  parseVerboseJson,
} from './ovozai-call-transcriber.js';
import { labelSpeakers, transcriptPrompt } from './call-analysis.scan.js';

const reply = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('OvozAI call transcript (ADR 085 step 3a)', () => {
  it('keeps timed segments, drops broken ones and falls back to the whole text', () => {
    expect(
      parseVerboseJson({
        text: 'ignored',
        segments: [
          { start: 0, end: 2.5, text: ' Assalomu  alaykum ' },
          { start: '2.5', end: 4, text: 'Здравствуйте' },
          { start: 'x', end: 1, text: 'bad' },
          { start: 5, end: 6, text: '   ' },
        ],
      }),
    ).toEqual([
      { start: 0, end: 2.5, text: 'Assalomu alaykum' },
      { start: 2.5, end: 4, text: 'Здравствуйте' },
    ]);
    expect(parseVerboseJson({ text: ' salom ', duration: 3 })).toEqual([
      { start: 0, end: 3, text: 'salom' },
    ]);
    expect(parseVerboseJson('nope')).toEqual([]);
  });

  it('sends verbose_json and maps busy, failing and empty replies to codes', async () => {
    let sent: { url: string; form: FormData; auth: string } | undefined;
    const ok = new OvozAiCallTranscriber({
      apiKey: 'k',
      fetch: (async (url: string, init: RequestInit) => {
        sent = {
          url,
          form: init.body as FormData,
          auth: (init.headers as Record<string, string>).authorization!,
        };
        return new Response(
          JSON.stringify({ segments: [{ start: 0, end: 1, text: 'ha' }] }),
        );
      }) as unknown as typeof fetch,
    });
    expect(await ok.transcribe(new Uint8Array([1]), 'audio/mpeg')).toEqual({
      ok: true,
      segments: [{ start: 0, end: 1, text: 'ha' }],
    });
    expect(sent?.url).toBe(OVOZAI_TRANSCRIPTIONS_URL);
    expect(sent?.auth).toBe('Bearer k');
    expect(sent?.form.get('response_format')).toBe('verbose_json');
    expect(sent?.form.get('model')).toBe('ovozai-transcribe');

    const code = async (
      status: number,
      body: unknown = {},
    ): Promise<string> => {
      const result = await new OvozAiCallTranscriber({
        apiKey: 'k',
        fetch: reply(status, body),
      }).transcribe(new Uint8Array([1]), 'audio/mpeg');
      return result.ok ? 'ok' : result.code;
    };
    expect(await code(429)).toBe('BUSY');
    expect(await code(503)).toBe('BUSY');
    expect(await code(400)).toBe('PROVIDER_ERROR');
    expect(await code(200, { text: '' })).toBe('EMPTY');
  });
});

describe('call summary prompt and speakers', () => {
  const segments = [
    { start: 0, end: 1, text: 'Salom' },
    { start: 1, end: 2, text: 'Narxi qancha?' },
    { start: 2, end: 3, text: 'Ertaga aytaman' },
  ];

  it('numbers the segments and cuts at the byte cap', () => {
    expect(transcriptPrompt(segments)).toEqual({
      text: 'Call transcript:\n#1 [0.0-1.0] Salom\n#2 [1.0-2.0] Narxi qancha?\n#3 [2.0-3.0] Ertaga aytaman',
      included: 3,
    });
    const long = Array.from({ length: 2_000 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: 'x'.repeat(40),
    }));
    const cut = transcriptPrompt(long);
    expect(cut.included).toBeLessThan(2_000);
    expect(cut.text.endsWith('(transcript cut here)')).toBe(true);
  });

  it('labels only when the letter count matches what was asked', () => {
    expect(labelSpeakers(segments, 's, c, S', 3).map((s) => s.speaker)).toEqual(
      ['staff', 'customer', 'staff'],
    );
    expect(labelSpeakers(segments, 'SC', 3).map((s) => s.speaker)).toEqual([
      null,
      null,
      null,
    ]);
    expect(labelSpeakers(segments, 'SC', 2).map((s) => s.speaker)).toEqual([
      'staff',
      'customer',
      null,
    ]);
  });
});
