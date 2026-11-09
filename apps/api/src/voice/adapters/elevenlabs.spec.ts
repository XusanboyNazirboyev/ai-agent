import { describe, expect, it } from 'vitest';
import type { AudioFrame, TranscriptEvent, TtsAudioChunk } from '../ports.js';
import { VirtualClock } from '../virtual-clock.js';
import {
  ElevenLabsDialogueTts,
  ElevenLabsError,
  ElevenLabsRealtimeStt,
} from './elevenlabs.js';
import { type FakeSocket, fakeSocketFactory } from './fake-socket.js';

const KEY = 'test-key-not-real';

function frame(
  ms: number,
  opts: { speech?: boolean; end?: boolean; bytes?: number } = {},
): AudioFrame {
  return {
    data: new Uint8Array(opts.bytes ?? 640),
    timestampMs: ms,
    durationMs: 20,
    speech: opts.speech ?? true,
    ...(opts.end ? { endOfUtterance: true } : {}),
  };
}

describe('ElevenLabs Scribe v2 Realtime STT', () => {
  it('opens the documented endpoint with the Uzbek language code and header auth', async () => {
    const { factory, sockets } = fakeSocketFactory();
    const stt = new ElevenLabsRealtimeStt({
      apiKey: KEY,
      clock: new VirtualClock(),
      socketFactory: factory,
      keyterms: ['tezda'],
    });
    await stt.open({ locale: 'uz-Latn', callId: 'c1' });
    const url = new URL(sockets[0]!.request.url);
    expect(url.origin + url.pathname).toBe(
      'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
    );
    expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(url.searchParams.get('language_code')).toBe('uz');
    expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(url.searchParams.get('commit_strategy')).toBe('manual');
    expect(url.searchParams.getAll('keyterms')).toEqual(['tezda']);
    expect(sockets[0]!.request.headers['xi-api-key']).toBe(KEY);
    // The key never travels in the URL.
    expect(sockets[0]!.request.url).not.toContain(KEY);
  });

  it('streams base64 PCM chunks and commits on the end-of-utterance frame', async () => {
    const { factory, sockets } = fakeSocketFactory();
    const clock = new VirtualClock();
    const stt = new ElevenLabsRealtimeStt({
      apiKey: KEY,
      clock,
      socketFactory: factory,
    });
    const session = await stt.open({ locale: 'uz-Latn', callId: 'c1' });
    const events: TranscriptEvent[] = [];
    session.onTranscript((e) => events.push(e));

    session.pushAudio(frame(0));
    session.pushAudio(frame(20));
    session.pushAudio(frame(40, { speech: false, end: true }));
    const sent = sockets[0]!.sent;
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      message_type: 'input_audio_chunk',
      commit: false,
      sample_rate: 16000,
    });
    expect(
      Buffer.from(sent[0]!.audio_base_64 as string, 'base64'),
    ).toHaveLength(640);
    expect(sent[2]).toMatchObject({ commit: true });
    expect(session.audioMsSent).toBe(60);

    sockets[0]!.receive({
      message_type: 'partial_transcript',
      text: 'Assalomu',
    });
    sockets[0]!.receive({
      message_type: 'committed_transcript',
      text: 'Assalomu alaykum',
    });
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ['partial', 'Assalomu'],
      ['final', 'Assalomu alaykum'],
    ]);
    expect(events[1]).toMatchObject({ startMs: 0, endMs: 60 });
  });

  it('does not commit twice without new audio (avoids commit_throttled)', async () => {
    const { factory, sockets } = fakeSocketFactory();
    const stt = new ElevenLabsRealtimeStt({
      apiKey: KEY,
      clock: new VirtualClock(),
      socketFactory: factory,
    });
    const session = await stt.open({ locale: 'ru', callId: 'c1' });
    session.pushAudio(frame(0, { end: true }));
    session.pushAudio(frame(20, { end: true, bytes: 0 }));
    expect(sockets[0]!.sent.map((m) => m.commit)).toEqual([true]);
    expect(
      new URL(sockets[0]!.request.url).searchParams.get('language_code'),
    ).toBe('ru');
  });

  it('records a provider error, closes, and ignores later audio', async () => {
    const { factory, sockets } = fakeSocketFactory();
    const stt = new ElevenLabsRealtimeStt({
      apiKey: KEY,
      clock: new VirtualClock(),
      socketFactory: factory,
    });
    const session = await stt.open({ locale: 'uz-Latn', callId: 'c1' });
    sockets[0]!.receive({
      message_type: 'quota_exceeded',
      error: 'Quota\nexceeded',
    });
    expect(session.failure).toBeInstanceOf(ElevenLabsError);
    expect(session.failure?.code).toBe('quota_exceeded');
    expect(session.failure?.message).toBe('Quota exceeded');
    session.pushAudio(frame(0));
    expect(sockets[0]!.sent).toHaveLength(0);
  });

  it('rejects open when the upgrade is refused', async () => {
    const { factory, sockets } = fakeSocketFactory(false);
    const stt = new ElevenLabsRealtimeStt({
      apiKey: KEY,
      clock: new VirtualClock(),
      socketFactory: factory,
    });
    const opening = stt.open({ locale: 'uz-Latn', callId: 'c1' });
    sockets[0]!.fail(1006, new Error('HTTP 401 on upgrade'));
    await expect(opening).rejects.toThrow('HTTP 401');
  });
});

async function collect(
  it: AsyncIterable<TtsAudioChunk>,
): Promise<TtsAudioChunk[]> {
  const out: TtsAudioChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

describe('ElevenLabs eleven_v4_turbo TTS (Text to Dialogue WebSocket)', () => {
  function tts(): { provider: ElevenLabsDialogueTts; sockets: FakeSocket[] } {
    const sockets = fakeSocketFactory();
    const provider = new ElevenLabsDialogueTts({
      apiKey: KEY,
      clock: new VirtualClock(),
      socketFactory: sockets.factory,
      voices: { 'uz-Latn': 'voice-uz' },
    });
    return { provider, sockets: sockets.sockets };
  }

  it('opens the dialogue socket with eleven_v4_turbo, PCM 16 kHz and registers the voice', async () => {
    const { provider, sockets } = tts();
    await provider.open({ locale: 'uz-Latn', callId: 'c1' });
    const url = new URL(sockets[0]!.request.url);
    expect(url.origin + url.pathname).toBe(
      'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input',
    );
    expect(url.searchParams.get('model_id')).toBe('eleven_v4_turbo');
    expect(url.searchParams.get('output_format')).toBe('pcm_16000');
    expect(url.searchParams.get('language_code')).toBe('uz');
    expect(sockets[0]!.sent[0]).toEqual({ voices: ['voice-uz'] });
  });

  it('refuses a locale without a configured voice', async () => {
    const { provider } = tts();
    await expect(provider.open({ locale: 'ru', callId: 'c1' })).rejects.toThrow(
      'no ElevenLabs voice',
    );
  });

  it('speaks one flushed sentence and ends on is_final_audio_for_turn', async () => {
    const { provider, sockets } = tts();
    const session = await provider.open({ locale: 'uz-Latn', callId: 'c1' });
    const result = collect(session.speak('Xush kelibsiz! '));
    await tick();
    expect(sockets[0]!.sent[1]).toEqual({
      inputs: [
        { text: 'Xush kelibsiz!', voice_id: 'voice-uz', new_turn: true },
      ],
      flush: true,
    });
    sockets[0]!.receive({ audio: Buffer.alloc(3200).toString('base64') });
    sockets[0]!.receive({ audio: Buffer.alloc(1600).toString('base64') });
    sockets[0]!.receive({ is_final_audio_for_turn: true });
    const chunks = await result;
    expect(
      chunks.map((c) => [c.durationMs, c.firstOfSentence, c.lastOfSentence]),
    ).toEqual([
      [100, true, false],
      [50, false, false],
      [0, false, true],
    ]);
    expect(session.charactersSent).toBe('Xush kelibsiz!'.length);
  });

  it('barge-in: cancel ends the sentence without a closing chunk, drops the socket and pre-warms a new one', async () => {
    const { provider, sockets } = tts();
    const session = await provider.open({ locale: 'uz-Latn', callId: 'c1' });
    const result = collect(session.speak('Uzun javob jumlasi.'));
    await tick();
    sockets[0]!.receive({ audio: Buffer.alloc(320).toString('base64') });
    await tick();
    session.cancel();
    const chunks = await result;
    expect(chunks).toHaveLength(1);
    expect(sockets[0]!.closedWith?.reason).toBe('barge-in');
    expect(sockets).toHaveLength(2);
    await tick();
    expect(sockets[1]!.sent[0]).toEqual({ voices: ['voice-uz'] });
    // The next sentence uses the new socket.
    const next = collect(session.speak('Keyingi.'));
    await tick();
    sockets[1]!.receive({ is_final_audio_for_turn: true });
    expect(await next).toHaveLength(1);
  });

  it('surfaces a provider error to the caller of speak()', async () => {
    const { provider, sockets } = tts();
    const session = await provider.open({ locale: 'uz-Latn', callId: 'c1' });
    const result = collect(session.speak('Salom.'));
    await tick();
    sockets[0]!.receive({
      error: 'authentication_required',
      message: 'bad key',
      code: 'auth',
    });
    await expect(result).rejects.toThrow('authentication_required');
  });
});
