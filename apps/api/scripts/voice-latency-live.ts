/**
 * Live voice latency check (ADR 045) against the real ElevenLabs adapters,
 * and optionally a LiveKit Cloud connect check. Costs a little provider
 * credit; uses synthetic Uzbek sentences only (no customer data).
 *
 *   pnpm exec tsx --env-file=<path to .env> scripts/voice-latency-live.ts \
 *     [--turns 10] [--llm-ms 400] [--playout-ms 60] [--livekit]
 *
 * Env: ELEVENLABS_API_KEY (required), ELEVENLABS_VOICE_ID_UZ (optional; else
 * the first voice of the account), LIVEKIT_URL / LIVEKIT_API_KEY /
 * LIVEKIT_API_SECRET for --livekit. Values are never printed.
 *
 * What is real and what is not:
 * - real: STT (Scribe v2 Realtime, caller audio streamed at real-time pace,
 *   committed at end of speech) and TTS (eleven_v4_turbo, warm socket,
 *   first audio of the reply's first sentence), over the internet from here;
 * - simulated: the LLM first token (`--llm-ms`, default 400 = its allowance;
 *   the streaming turn engine is not built yet) and the playout hop to the
 *   phone (`--playout-ms`, default 60).
 * Exit code 1 when end-to-end p95 >= 1500 ms or a turn has no audio.
 */
import { performance } from 'node:perf_hooks';
import type { LocaleId } from '../src/core/locales/locale-pack.js';
import {
  ElevenLabsDialogueTts,
  ElevenLabsRealtimeStt,
  PCM_BYTES_PER_MS,
} from '../src/voice/adapters/elevenlabs.js';
import { agentToken, RtcRoomConnector } from '../src/voice/adapters/livekit.js';
import {
  buildLatencyReport,
  formatLatencyReport,
  percentile,
  VoiceTurnTimeline,
} from '../src/voice/latency-timeline.js';
import type { Clock, TranscriptEvent } from '../src/voice/ports.js';

const CALLER_LINES = [
  'Assalomu alaykum, ertaga soat uchga qabulga yozilmoqchiman.',
  'Kurs narxi qancha turadi?',
  'Shanba kuni ishlaysizlarmi?',
  'Manzilingizni aytib yubora olasizmi?',
  'Menga operator bilan gaplashish kerak.',
];
const REPLY =
  'Albatta, hozir tekshirib beraman. Ertaga soat uchda bo‘sh joy bor.';
const FRAME_MS = 20;
const LOCALE: LocaleId = 'uz-Latn';

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(name: string, fallback: number): number {
  const v = arg(name);
  return v === undefined ? fallback : Number(v);
}
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function firstVoiceId(apiKey: string): Promise<string> {
  const res = await fetch('https://api.elevenlabs.io/v2/voices?page_size=1', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`voices list HTTP ${res.status}`);
  const body = (await res.json()) as { voices?: { voice_id: string }[] };
  const id = body.voices?.[0]?.voice_id;
  if (!id) throw new Error('no voice on the ElevenLabs account');
  return id;
}

async function synthesize(
  tts: ElevenLabsDialogueTts,
  text: string,
): Promise<Uint8Array> {
  const session = await tts.open({ locale: LOCALE, callId: 'caller-audio' });
  const parts: Uint8Array[] = [];
  for await (const chunk of session.speak(text)) parts.push(chunk.data);
  await session.close();
  return new Uint8Array(Buffer.concat(parts));
}

async function liveKitCheck(): Promise<void> {
  const config = {
    url: env('LIVEKIT_URL'),
    apiKey: env('LIVEKIT_API_KEY'),
    apiSecret: env('LIVEKIT_API_SECRET'),
  };
  const room = `latency-check-${Date.now()}`;
  await agentToken(config, room, 'agentcore-latency');
  const started = performance.now();
  const media = await new RtcRoomConnector(config).connect(
    room,
    'agentcore-latency',
  );
  const connectMs = performance.now() - started;
  // One 20 ms frame of silence proves the published track accepts audio.
  await media.publish(new Int16Array(320));
  await media.disconnect();
  console.log(
    `livekit: joined room, published the agent track and left; connect ${connectMs.toFixed(0)} ms`,
  );
}

async function main(): Promise<void> {
  const turns = num('turns', 10);
  const llmMs = num('llm-ms', 400);
  const playoutMs = num('playout-ms', 60);
  const apiKey = env('ELEVENLABS_API_KEY');
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID_UZ ?? (await firstVoiceId(apiKey));

  const tts = new ElevenLabsDialogueTts({
    apiKey,
    clock,
    voices: { [LOCALE]: voiceId },
  });
  const stt = new ElevenLabsRealtimeStt({ apiKey, clock });

  console.log('preparing synthetic caller audio (Uzbek)...');
  const clips = await Promise.all(CALLER_LINES.map((l) => synthesize(tts, l)));

  // One "call": one STT and one warm TTS session for all turns.
  const sttSession = await stt.open({ locale: LOCALE, callId: 'latency' });
  const ttsSession = await tts.open({ locale: LOCALE, callId: 'latency' });
  let onFinal: ((e: TranscriptEvent) => void) | undefined;
  sttSession.onTranscript((e) => {
    if (e.kind === 'final' && e.text.trim()) onFinal?.(e);
  });

  const timelines: VoiceTurnTimeline[] = [];
  const transcripts: string[] = [];
  const sentence = REPLY.split(/(?<=[.!?])\s+/u)[0] ?? REPLY;
  for (let i = 0; i < turns; i += 1) {
    const clip = clips[i % clips.length]!;
    const timeline = new VoiceTurnTimeline(i);
    timelines.push(timeline);
    const final = new Promise<TranscriptEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no final transcript in 10 s')),
        10_000,
      );
      onFinal = (e): void => {
        clearTimeout(timer);
        resolve(e);
      };
    });
    // Stream the caller at real-time pace, 20 ms frames.
    const frameBytes = FRAME_MS * PCM_BYTES_PER_MS;
    const t0 = clock.now();
    for (let off = 0, n = 0; off < clip.length; off += frameBytes, n += 1) {
      const last = off + frameBytes >= clip.length;
      sttSession.pushAudio({
        data: clip.subarray(off, off + frameBytes),
        timestampMs: n * FRAME_MS,
        durationMs: FRAME_MS,
        speech: true,
        ...(last ? { endOfUtterance: true } : {}),
      });
      if (last) timeline.mark('callerEndOfSpeech', clock.now());
      const due = t0 + (n + 1) * FRAME_MS;
      const wait = due - clock.now();
      if (wait > 0) await clock.sleep(wait);
    }
    try {
      const event = await final;
      timeline.mark('sttFinal', clock.now());
      transcripts.push(event.text);
    } catch (error) {
      console.log(`turn ${i}: ${(error as Error).message}`);
      continue;
    }
    await clock.sleep(llmMs); // simulated LLM first token
    timeline.mark('llmFirstToken', clock.now());
    timeline.mark('firstSentenceReady', clock.now());
    for await (const chunk of ttsSession.speak(sentence)) {
      if (chunk.data.length > 0 && timeline.at('ttsFirstAudio') === undefined) {
        const at = clock.now();
        timeline.mark('ttsFirstAudio', at);
        timeline.mark('playbackStart', at + playoutMs);
      }
    }
    await clock.sleep(300); // caller listens briefly before the next turn
  }
  await sttSession.close();
  await ttsSession.close();

  const report = buildLatencyReport(timelines);
  console.log(formatLatencyReport(report));
  console.log(
    `sample transcripts: ${JSON.stringify(transcripts.slice(0, CALLER_LINES.length))}`,
  );
  const e2e = timelines
    .map((t) => t.endToEndMs())
    .filter((v): v is number => v !== undefined);
  const p95 = e2e.length ? percentile(e2e, 95) : Number.POSITIVE_INFINITY;
  const ok = e2e.length === turns && p95 < 1500;
  console.log(
    `end-to-end p95 ${p95.toFixed(0)} ms over ${e2e.length}/${turns} turns ` +
      `(LLM ${llmMs} ms and playout ${playoutMs} ms simulated): ` +
      (ok ? 'PASS (< 1500 ms)' : 'FAIL'),
  );

  if (process.argv.includes('--livekit')) await liveKitCheck();
  process.exitCode = ok ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`voice-latency-live failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
