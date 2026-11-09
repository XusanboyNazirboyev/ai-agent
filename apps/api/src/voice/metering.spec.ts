import { describe, expect, it } from 'vitest';
import type {
  BudgetLedger,
  LedgerReserveRequest,
  LedgerReserveResult,
} from '../core/llm/budget-ledger.js';
import type { LlmUsageEntry } from '../core/llm/metered-llm.js';
import type {
  AudioFrame,
  StreamingSpeechToText,
  StreamingTextToSpeech,
  SttSession,
  TtsAudioChunk,
} from './ports.js';
import {
  ELEVENLABS_PRICING,
  sttCostNano,
  ttsCostNano,
  VoiceBudgetExhaustedError,
  VoiceCallMeter,
} from './metering.js';
import { VirtualClock } from './virtual-clock.js';

class FakeLedger implements BudgetLedger {
  readonly reserves: LedgerReserveRequest[] = [];
  readonly settled: LlmUsageEntry[] = [];
  readonly unknown: LlmUsageEntry[] = [];
  readonly released: string[] = [];
  /** Grants this many more reservations, then refuses. */
  remaining = Number.POSITIVE_INFINITY;

  reserve(request: LedgerReserveRequest): Promise<LedgerReserveResult> {
    this.reserves.push(request);
    if (this.remaining <= 0)
      return Promise.resolve({
        granted: false,
        reason: 'TENANT_MONTHLY_LIMIT',
      });
    this.remaining -= 1;
    return Promise.resolve({
      granted: true,
      reservationId: `r${this.reserves.length}`,
    });
  }
  settle(_t: string, _r: string, entry: LlmUsageEntry): Promise<void> {
    this.settled.push(entry);
    return Promise.resolve();
  }
  markUnknown(_t: string, _r: string, entry: LlmUsageEntry): Promise<void> {
    this.unknown.push(entry);
    return Promise.resolve();
  }
  release(_t: string, reservationId: string): Promise<void> {
    this.released.push(reservationId);
    return Promise.resolve();
  }
}

class RecordingStt implements StreamingSpeechToText {
  readonly provider = 'elevenlabs';
  readonly model = 'scribe_v2_realtime';
  readonly pushed: AudioFrame[] = [];
  opened = 0;
  open(): Promise<SttSession> {
    this.opened += 1;
    return Promise.resolve({
      pushAudio: (f) => this.pushed.push(f),
      onTranscript: () => () => undefined,
      close: () => Promise.resolve(),
    });
  }
}

const frame = (i: number): AudioFrame => ({
  data: new Uint8Array(32_000), // 1 s
  timestampMs: i * 1000,
  durationMs: 1000,
  speech: true,
});

function meter(
  ledger: FakeLedger,
  extra: { onExhausted?: (r: string) => void } = {},
): VoiceCallMeter {
  return new VoiceCallMeter({
    ledger,
    clock: new VirtualClock(),
    tenantId: 't1',
    conversationId: 'conv1',
    callId: 'call1',
    pricing: ELEVENLABS_PRICING,
    monthlyCapNano: 5_000_000_000,
    sttBlockMs: 2_000,
    ...extra,
  });
}

const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

describe('voice audio metering on the tenant budget ledger (REV-03)', () => {
  it('prices match the 2026-11-09 ElevenLabs page', () => {
    // $0.39 per hour -> one minute is $0.0065.
    expect(sttCostNano(ELEVENLABS_PRICING, 60_000)).toBe(6_500_000);
    // $0.04 per 1K characters -> 50 characters is $0.002.
    expect(ttsCostNano(ELEVENLABS_PRICING, 50)).toBe(2_000_000);
  });

  it('reserves the first STT block before the session opens; a refusal opens nothing', async () => {
    const ledger = new FakeLedger();
    ledger.remaining = 0;
    const inner = new RecordingStt();
    await expect(
      meter(ledger)
        .meterStt(inner)
        .open({ locale: 'uz-Latn', callId: 'call1' }),
    ).rejects.toBeInstanceOf(VoiceBudgetExhaustedError);
    expect(inner.opened).toBe(0);
    expect(ledger.reserves[0]).toMatchObject({
      tenantId: 't1',
      conversationId: 'conv1',
      baseInvocationId: 'voice-call:call1:0',
      worstCaseNano: sttCostNano(ELEVENLABS_PRICING, 2_000),
      monthlyCapNano: 5_000_000_000,
    });
  });

  it('forwards audio only inside reserved blocks and settles the actual seconds', async () => {
    const ledger = new FakeLedger();
    const inner = new RecordingStt();
    const session = await meter(ledger)
      .meterStt(inner)
      .open({ locale: 'uz-Latn', callId: 'call1' });
    for (let i = 0; i < 3; i += 1) session.pushAudio(frame(i));
    // Frame 3 needs a second block: held until it is granted.
    expect(inner.pushed).toHaveLength(2);
    await flush();
    expect(inner.pushed.map((f) => f.timestampMs)).toEqual([0, 1000, 2000]);
    expect(ledger.reserves).toHaveLength(2);
    await session.close();
    expect(
      ledger.settled.map((e) => [e.purpose, e.costNano, e.usageBasis]),
    ).toEqual([
      ['transcribe', sttCostNano(ELEVENLABS_PRICING, 2_000), 'estimated'],
      ['transcribe', sttCostNano(ELEVENLABS_PRICING, 1_000), 'estimated'],
    ]);
    expect(ledger.settled[0]).toMatchObject({
      providerId: 'elevenlabs',
      model: 'scribe_v2_realtime',
      pricingVersion: 'elevenlabs-2026-11-09',
      turnKey: 'voice-call:call1',
    });
  });

  it('stops forwarding audio when a later block is refused and reports it once', async () => {
    const ledger = new FakeLedger();
    ledger.remaining = 1;
    const reasons: string[] = [];
    const inner = new RecordingStt();
    const session = await meter(ledger, { onExhausted: (r) => reasons.push(r) })
      .meterStt(inner)
      .open({ locale: 'uz-Latn', callId: 'call1' });
    for (let i = 0; i < 4; i += 1) session.pushAudio(frame(i));
    await flush();
    session.pushAudio(frame(4));
    expect(inner.pushed).toHaveLength(2);
    expect(reasons).toEqual(['TENANT_MONTHLY_LIMIT']);
  });

  it('releases an unused block instead of billing it', async () => {
    const ledger = new FakeLedger();
    const session = await meter(ledger)
      .meterStt(new RecordingStt())
      .open({ locale: 'uz-Latn', callId: 'call1' });
    await session.close();
    expect(ledger.released).toEqual(['r1']);
    expect(ledger.settled).toHaveLength(0);
  });

  function tts(
    behaviour: 'ok' | 'throw',
  ): StreamingTextToSpeech & { sent: string[] } {
    const sent: string[] = [];
    return {
      provider: 'elevenlabs',
      sent,
      open: () =>
        Promise.resolve({
          async *speak(sentence: string): AsyncIterable<TtsAudioChunk> {
            sent.push(sentence);
            await Promise.resolve();
            if (behaviour === 'throw') throw new Error('socket closed');
            yield {
              data: new Uint8Array(0),
              sentenceIndex: 0,
              firstOfSentence: true,
              lastOfSentence: true,
              durationMs: 0,
              emittedAtMs: 0,
            };
          },
          cancel: () => undefined,
          close: () => Promise.resolve(),
        }),
    };
  }

  it('reserves each sentence by characters before sending it and settles it', async () => {
    const ledger = new FakeLedger();
    const inner = tts('ok');
    const session = await meter(ledger)
      .meterTts(inner)
      .open({ locale: 'uz-Latn', callId: 'call1' });
    for await (const _ of session.speak('Ertaga soat 15:00 da.')) void _;
    expect(ledger.reserves[0]?.worstCaseNano).toBe(
      ttsCostNano(ELEVENLABS_PRICING, 'Ertaga soat 15:00 da.'.length),
    );
    expect(ledger.settled[0]).toMatchObject({
      purpose: 'speak',
      outcome: 'ok',
    });
  });

  it('a refused sentence is never sent to the provider', async () => {
    const ledger = new FakeLedger();
    ledger.remaining = 0;
    const inner = tts('ok');
    const session = await meter(ledger)
      .meterTts(inner)
      .open({ locale: 'uz-Latn', callId: 'call1' });
    const run = async (): Promise<void> => {
      for await (const _ of session.speak('Salom.')) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(VoiceBudgetExhaustedError);
    expect(inner.sent).toEqual([]);
  });

  it('a provider error keeps the worst case counted (unknown usage)', async () => {
    const ledger = new FakeLedger();
    const session = await meter(ledger)
      .meterTts(tts('throw'))
      .open({ locale: 'uz-Latn', callId: 'call1' });
    const run = async (): Promise<void> => {
      for await (const _ of session.speak('Salom.')) void _;
    };
    await expect(run()).rejects.toThrow('socket closed');
    expect(ledger.unknown[0]).toMatchObject({
      costNano: 0,
      usageBasis: 'unknown',
      outcome: 'unknown_usage:ERROR',
    });
  });
});
