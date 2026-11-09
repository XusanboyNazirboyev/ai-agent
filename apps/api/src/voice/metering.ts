/**
 * Audio metering for voice calls (ADR 045 decision 6, REV-03 / ADR 042
 * amendment): the worst case is reserved on the tenant budget ledger BEFORE
 * audio or text leaves the server; a refused reservation means no provider
 * call. Spend is computed from what was sent (audio milliseconds, characters)
 * at a pinned pricing version and recorded with basis `estimated`.
 *
 * Prices: https://elevenlabs.io/pricing/api read 2026-11-09: Scribe v2
 * Realtime $0.39 per hour; v4 Turbo TTS $0.04 per 1K characters (same on
 * every plan tier listed). A new version is needed when the page changes.
 */
import type { BudgetLedger } from '../core/llm/budget-ledger.js';
import type { LlmPurpose } from '../core/llm/llm-provider.js';
import type { LlmUsageEntry } from '../core/llm/metered-llm.js';
import type {
  AudioFrame,
  Clock,
  StreamingSpeechToText,
  StreamingTextToSpeech,
  SttSession,
  SttSessionOptions,
  TranscriptEvent,
  TtsAudioChunk,
  TtsSession,
  TtsSessionOptions,
  Unsubscribe,
} from './ports.js';

export interface SpeechPricing {
  readonly version: string;
  /** nano-USD per hour of streamed STT audio. */
  readonly sttNanoPerHour: number;
  /** nano-USD per 1,000 characters synthesized. */
  readonly ttsNanoPer1kChars: number;
}

export const ELEVENLABS_PRICING: SpeechPricing = {
  version: 'elevenlabs-2026-11-09',
  sttNanoPerHour: 390_000_000,
  ttsNanoPer1kChars: 40_000_000,
};

export function sttCostNano(pricing: SpeechPricing, audioMs: number): number {
  return Math.ceil((audioMs * pricing.sttNanoPerHour) / 3_600_000);
}

export function ttsCostNano(
  pricing: SpeechPricing,
  characters: number,
): number {
  return Math.ceil((characters * pricing.ttsNanoPer1kChars) / 1_000);
}

export class VoiceBudgetExhaustedError extends Error {
  constructor(readonly reason: string) {
    super(`voice budget refused: ${reason}`);
    this.name = 'VoiceBudgetExhaustedError';
  }
}

export interface VoiceMeterOptions {
  readonly ledger: BudgetLedger;
  readonly clock: Clock;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly callId: string;
  readonly pricing: SpeechPricing;
  readonly monthlyCapNano?: number;
  readonly conversationCapNano?: number;
  /** STT audio reserved per block, ms (default 60 s). */
  readonly sttBlockMs?: number;
  /** Called once when a later STT block is refused mid-call. */
  readonly onExhausted?: (reason: string) => void;
}

interface Reservation {
  readonly id: string;
  readonly callIndex: number;
  readonly worstCaseNano: number;
}

/** One meter per call; wraps the call's STT and TTS providers. */
export class VoiceCallMeter {
  private callIndex = 0;
  private readonly turnKey: string;

  constructor(private readonly options: VoiceMeterOptions) {
    this.turnKey = `voice-call:${options.callId}`;
  }

  meterStt(
    inner: StreamingSpeechToText & { model?: string },
  ): StreamingSpeechToText {
    return {
      provider: inner.provider,
      open: async (opts: SttSessionOptions): Promise<SttSession> => {
        // Reserve the first block before the call is answered.
        const first = await this.reserve(this.sttBlockNano());
        const session = await inner.open(opts).catch(async (error: unknown) => {
          await this.options.ledger.release(this.options.tenantId, first.id);
          throw error;
        });
        return new MeteredSttSession(
          session,
          this,
          first,
          inner.provider,
          inner.model ?? 'unknown',
        );
      },
    };
  }

  meterTts(
    inner: StreamingTextToSpeech & { model?: string },
  ): StreamingTextToSpeech {
    return {
      provider: inner.provider,
      open: async (opts: TtsSessionOptions) =>
        new MeteredTtsSession(
          await inner.open(opts),
          this,
          inner.provider,
          inner.model ?? 'unknown',
        ),
    };
  }

  get sttBlockMs(): number {
    return this.options.sttBlockMs ?? 60_000;
  }

  sttBlockNano(): number {
    return sttCostNano(this.options.pricing, this.sttBlockMs);
  }

  get pricing(): SpeechPricing {
    return this.options.pricing;
  }

  exhausted(reason: string): void {
    this.options.onExhausted?.(reason);
  }

  /** Throws VoiceBudgetExhaustedError when the ledger refuses. */
  async reserve(worstCaseNano: number): Promise<Reservation> {
    const callIndex = this.callIndex++;
    const result = await this.options.ledger.reserve({
      tenantId: this.options.tenantId,
      conversationId: this.options.conversationId,
      baseInvocationId: `${this.turnKey}:${callIndex}`,
      worstCaseNano,
      worstCaseTokens: 0,
      ...(this.options.monthlyCapNano !== undefined
        ? { monthlyCapNano: this.options.monthlyCapNano }
        : {}),
      ...(this.options.conversationCapNano !== undefined
        ? { conversationCapNano: this.options.conversationCapNano }
        : {}),
    });
    if (!result.granted) throw new VoiceBudgetExhaustedError(result.reason);
    return { id: result.reservationId, callIndex, worstCaseNano };
  }

  async settle(
    reservation: Reservation,
    details: {
      readonly purpose: LlmPurpose;
      readonly provider: string;
      readonly model: string;
      readonly costNano: number;
      readonly startedAt: number;
      readonly unknown?: boolean;
      readonly outcome: string;
    },
  ): Promise<void> {
    const entry: LlmUsageEntry = {
      tenantId: this.options.tenantId,
      conversationId: this.options.conversationId,
      turnKey: this.turnKey,
      callIndex: reservation.callIndex,
      purpose: details.purpose,
      tier: 'FAST',
      providerId: details.provider,
      model: details.model,
      responseId: `${this.turnKey}:${reservation.callIndex}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      costNano: details.unknown ? 0 : details.costNano,
      reservedNano: reservation.worstCaseNano,
      usageBasis: details.unknown ? 'unknown' : 'estimated',
      pricingVersion: this.options.pricing.version,
      durationMs: Math.max(0, this.options.clock.now() - details.startedAt),
      attempts: 1,
      outcome: details.unknown
        ? `unknown_usage:${details.outcome}`
        : details.outcome,
    };
    if (details.unknown)
      await this.options.ledger.markUnknown(
        this.options.tenantId,
        reservation.id,
        entry,
      );
    else
      await this.options.ledger.settle(
        this.options.tenantId,
        reservation.id,
        entry,
      );
  }

  release(reservation: Reservation): Promise<void> {
    return this.options.ledger.release(this.options.tenantId, reservation.id);
  }

  now(): number {
    return this.options.clock.now();
  }
}

/**
 * Forwards audio only inside reserved blocks. Frames that arrive while the
 * next block is being reserved are held and flushed in order once it is
 * granted; a refusal stops forwarding for the rest of the call.
 */
class MeteredSttSession implements SttSession {
  private readonly blocks: { r: Reservation; startedAt: number }[] = [];
  private reservedMs: number;
  private sentMs = 0;
  private pending: AudioFrame[] = [];
  private reserving = false;
  private refused = false;

  constructor(
    private readonly inner: SttSession,
    private readonly meter: VoiceCallMeter,
    first: Reservation,
    private readonly provider: string,
    private readonly model: string,
  ) {
    this.blocks.push({ r: first, startedAt: meter.now() });
    this.reservedMs = meter.sttBlockMs;
  }

  pushAudio(frame: AudioFrame): void {
    if (this.refused) return;
    if (this.pending.length === 0 && this.fits(frame)) {
      this.forward(frame);
      return;
    }
    this.pending.push(frame);
    if (!this.reserving) void this.reserveNext();
  }

  onTranscript(handler: (event: TranscriptEvent) => void): Unsubscribe {
    return this.inner.onTranscript(handler);
  }

  async close(): Promise<void> {
    await this.inner.close();
    const blockMs = this.meter.sttBlockMs;
    for (const [i, block] of this.blocks.entries()) {
      const usedMs = Math.min(blockMs, Math.max(0, this.sentMs - i * blockMs));
      if (usedMs === 0) await this.meter.release(block.r);
      else
        await this.meter.settle(block.r, {
          purpose: 'transcribe',
          provider: this.provider,
          model: this.model,
          costNano: sttCostNano(this.meter.pricing, usedMs),
          startedAt: block.startedAt,
          outcome: 'ok',
        });
    }
    this.blocks.length = 0;
  }

  private fits(frame: AudioFrame): boolean {
    return this.sentMs + frame.durationMs <= this.reservedMs;
  }

  private forward(frame: AudioFrame): void {
    this.sentMs += frame.durationMs;
    this.inner.pushAudio(frame);
  }

  private async reserveNext(): Promise<void> {
    this.reserving = true;
    try {
      while (this.pending.length > 0 && !this.refused) {
        const head = this.pending[0];
        if (head && this.fits(head)) {
          this.pending.shift();
          this.forward(head);
          continue;
        }
        const r = await this.meter.reserve(this.meter.sttBlockNano());
        this.blocks.push({ r, startedAt: this.meter.now() });
        this.reservedMs += this.meter.sttBlockMs;
      }
    } catch (error) {
      this.refused = true;
      this.pending = [];
      this.meter.exhausted(
        error instanceof VoiceBudgetExhaustedError
          ? error.reason
          : 'LEDGER_ERROR',
      );
    } finally {
      this.reserving = false;
    }
  }
}

/** Reserves each sentence before it is sent; a refused sentence is not spoken. */
class MeteredTtsSession implements TtsSession {
  constructor(
    private readonly inner: TtsSession,
    private readonly meter: VoiceCallMeter,
    private readonly provider: string,
    private readonly model: string,
  ) {}

  async *speak(sentence: string): AsyncIterable<TtsAudioChunk> {
    const characters = sentence.trim().length;
    if (characters === 0) return;
    const costNano = ttsCostNano(this.meter.pricing, characters);
    const reservation = await this.meter.reserve(costNano);
    const startedAt = this.meter.now();
    let completed = false;
    let failed = false;
    try {
      for await (const chunk of this.inner.speak(sentence)) {
        if (chunk.lastOfSentence) completed = true;
        yield chunk;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Characters sent are billed even when cut off; an error leaves the
      // billing unknown, so the worst case stays counted.
      await this.meter.settle(reservation, {
        purpose: 'speak',
        provider: this.provider,
        model: this.model,
        costNano,
        startedAt,
        unknown: failed,
        outcome: failed ? 'ERROR' : completed ? 'ok' : 'cancelled',
      });
    }
  }

  cancel(): void {
    this.inner.cancel();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
