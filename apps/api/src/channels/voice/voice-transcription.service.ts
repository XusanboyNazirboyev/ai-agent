import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import type { LlmUsageEntry } from '../../core/llm/metered-llm.js';
import { usdToNano } from '../../core/llm/pricing.js';
import {
  checkClip,
  DEFAULT_VOICE_POLICY,
  NotConfiguredSpeechToText,
  transcriptionCostNano,
  worstCaseTranscriptionNano,
  type AudioClip,
  type SpeechToText,
  type TranscriptionResult,
} from '../../core/speech/speech-to-text.js';
import { LlmBudgetLedger } from '../../agent/llm-budget-ledger.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { ElevenLabsSpeechToText } from '../../speech/elevenlabs-speech-to-text.js';
import { sniffAudioContainer } from './audio-container.js';
import { downloadPublicMedia, type MediaDownload } from './media-download.js';
import { FallbackSpeechToText } from '../../speech/fallback-speech-to-text.js';
import {
  GeminiSpeechToText,
  sdkTranscribeCall,
} from '../../speech/gemini-speech-to-text.js';
import { TelegramSender } from '../telegram/telegram-sender.js';

/**
 * The key for voice-note STT: a dedicated STT_API_KEY, else the project's
 * paid GEMINI_API_KEY (owner, 2026-11-09). Values are never logged.
 */
export function sttApiKey(env: {
  readonly STT_API_KEY?: string | undefined;
  readonly GEMINI_API_KEY?: string | undefined;
}): string | undefined {
  return env.STT_API_KEY || env.GEMINI_API_KEY || undefined;
}

/**
 * The voice-note STT the environment asks for: Gemini (the best measured on
 * the owner's recordings), with ElevenLabs Scribe as backup when its key is
 * set and STT_FALLBACK is not `none`; otherwise not configured.
 */
export function buildSpeechToText(env: {
  readonly STT_PROVIDER?: string | undefined;
  readonly STT_MODEL?: string | undefined;
  readonly STT_API_KEY?: string | undefined;
  readonly GEMINI_API_KEY?: string | undefined;
  readonly STT_FALLBACK?: string | undefined;
  readonly ELEVENLABS_API_KEY?: string | undefined;
}): SpeechToText {
  const key = sttApiKey(env);
  if (env.STT_PROVIDER !== 'gemini' || !key)
    return new NotConfiguredSpeechToText();
  const gemini = new GeminiSpeechToText(
    sdkTranscribeCall(key),
    env.STT_MODEL ?? 'gemini-3.5-transcribe',
    DEFAULT_VOICE_POLICY.timeoutMs,
  );
  if (env.STT_FALLBACK === 'none' || !env.ELEVENLABS_API_KEY) return gemini;
  return new FallbackSpeechToText(
    gemini,
    new ElevenLabsSpeechToText({
      apiKey: env.ELEVENLABS_API_KEY,
      timeoutMs: DEFAULT_VOICE_POLICY.timeoutMs,
    }),
    // ElevenLabs' own language detection mislabelled Uzbek as Turkish.
    'uz-Latn',
  );
}

/** Optional override of the speech-to-text adapter (tests). */
export const SPEECH_TO_TEXT = Symbol('SPEECH_TO_TEXT');

/** Optional override of the public-media download (tests). */
export const MEDIA_DOWNLOADER = Symbol('MEDIA_DOWNLOADER');
export type MediaDownloader = (
  url: string,
  options: { maxBytes: number; timeoutMs: number },
) => Promise<MediaDownload>;

/**
 * Instagram voice messages (ADR 042). The webhook carries only a URL, no
 * duration and no format, and the Meta docs do not say how long it lives or
 * what the container is (read 2026-11-10), so: the file is fetched at once by
 * the worker through the SSRF-guarded downloader, bounded to 2 MiB (about two
 * minutes of 128 kbit/s audio); its length is unknown, so the metering
 * reserves the policy maximum; and only a response with a known audio media
 * type is sent to a provider (no guessing: anything else is "please type").
 */
const INSTAGRAM_MAX_BYTES = 2 * 1024 * 1024;
const INSTAGRAM_DOWNLOAD_TIMEOUT_MS = 10_000;
/** Same container, the name Gemini and the policy know. */
const MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
};

/**
 * ADR 042: turns the PENDING voice notes of a conversation into text before
 * the agent answers. Each note is downloaded from the channel, checked
 * against the voice policy (type, size, length) before any audio leaves the
 * server, transcribed, and stored: TRANSCRIBED with the transcript as the
 * message text, or FAILED with an empty text. The agent turn answers a
 * failed note by code (ask to type, then a person). The transcript is
 * untrusted customer text; audio is never stored or logged.
 */
@Injectable()
export class VoiceTranscriptionService {
  private readonly logger = new Logger(VoiceTranscriptionService.name);
  private readonly stt: SpeechToText;
  private readonly downloadMedia: MediaDownloader;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() private readonly telegram?: TelegramSender,
    @Optional() @Inject(SPEECH_TO_TEXT) stt?: SpeechToText,
    @Optional() private readonly ledger?: LlmBudgetLedger,
    @Optional() @Inject(MEDIA_DOWNLOADER) downloader?: MediaDownloader,
  ) {
    this.downloadMedia = downloader ?? downloadPublicMedia;
    this.stt =
      stt ??
      buildSpeechToText({
        STT_PROVIDER: config.get('STT_PROVIDER', { infer: true }),
        STT_MODEL: config.get('STT_MODEL', { infer: true }),
        STT_API_KEY: config.get('STT_API_KEY', { infer: true }),
        GEMINI_API_KEY: config.get('GEMINI_API_KEY', { infer: true }),
        STT_FALLBACK: config.get('STT_FALLBACK', { infer: true }),
        ELEVENLABS_API_KEY: config.get('ELEVENLABS_API_KEY', { infer: true }),
      });
  }

  async resolvePending(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    const pending = await this.prisma.message.findMany({
      where: {
        tenantId,
        conversationId,
        direction: 'INBOUND',
        type: 'VOICE',
        voiceStatus: 'PENDING',
      },
      orderBy: { sequence: 'asc' },
      take: 4,
      select: {
        id: true,
        channelAccountId: true,
        mediaRef: true,
        mediaMimeType: true,
        mediaDurationSeconds: true,
        channelAccount: { select: { channelType: true } },
      },
    });
    for (const message of pending) {
      const outcome = await this.transcribeOne(
        tenantId,
        conversationId,
        message,
      );
      const text = outcome.ok ? outcome.text.slice(0, 4_000) : '';
      const usable =
        outcome.ok && text.length >= DEFAULT_VOICE_POLICY.minTranscriptChars;
      await this.prisma.message.updateMany({
        where: { id: message.id, tenantId, voiceStatus: 'PENDING' },
        data: {
          text: usable ? text : '',
          voiceStatus: usable ? 'TRANSCRIBED' : 'FAILED',
        },
      });
      if (!usable)
        this.logger.warn(
          JSON.stringify({
            event: 'voice.transcription_failed',
            messageId: message.id,
            reason: outcome.ok ? 'UNINTELLIGIBLE' : outcome.code,
            provider: this.stt.providerId,
          }),
        );
    }
  }

  private async transcribeOne(
    tenantId: string,
    conversationId: string,
    message: {
      readonly id: string;
      readonly channelAccountId: string;
      readonly mediaRef: string | null;
      readonly mediaMimeType: string | null;
      readonly mediaDurationSeconds: number | null;
      readonly channelAccount: { readonly channelType: string };
    },
  ): Promise<TranscriptionResult | { ok: false; code: string }> {
    if (this.stt.providerId === 'none')
      return { ok: false, code: 'NOT_CONFIGURED' };
    if (message.channelAccount.channelType === 'instagram')
      return this.transcribeInstagram(tenantId, conversationId, message);
    const mimeType = message.mediaMimeType ?? 'audio/ogg';
    const durationSeconds = message.mediaDurationSeconds ?? 0;
    // Length and type are checked before anything is downloaded.
    const early = checkClip({ mimeType, durationSeconds, size: 1 });
    if (!early.ok) return early;
    if (
      message.channelAccount.channelType !== 'telegram' ||
      !message.mediaRef ||
      !this.telegram
    )
      return { ok: false, code: 'UNSUPPORTED_TYPE' };
    const data = await this.telegram.downloadFile(
      message.mediaRef,
      DEFAULT_VOICE_POLICY.maxBytes,
      message.channelAccountId,
    );
    if (!data) return { ok: false, code: 'PROVIDER_ERROR' };
    const checked = checkClip({
      mimeType,
      durationSeconds,
      size: data.byteLength,
    });
    if (!checked.ok) return checked;
    return this.meteredTranscribe(tenantId, conversationId, message.id, {
      data,
      mimeType,
      durationSeconds,
    });
  }

  private async transcribeInstagram(
    tenantId: string,
    conversationId: string,
    message: { readonly id: string; readonly mediaRef: string | null },
  ): Promise<TranscriptionResult | { ok: false; code: string }> {
    if (this.stt.providerId === 'none')
      return { ok: false, code: 'NOT_CONFIGURED' };
    if (!message.mediaRef) return { ok: false, code: 'UNSUPPORTED_TYPE' };
    const downloaded = await this.downloadMedia(message.mediaRef, {
      maxBytes: INSTAGRAM_MAX_BYTES,
      timeoutMs: INSTAGRAM_DOWNLOAD_TIMEOUT_MS,
    });
    // The specific download failure is the reason (never the URL).
    if (!downloaded.ok)
      return { ok: false, code: `DOWNLOAD_${downloaded.code}` };
    // The bytes decide the container: Instagram labels an Ogg/Opus voice
    // message `video/mp4`. A declared type is used only when the bytes are
    // not recognised AND it is itself a known audio type; otherwise refused.
    const declared = downloaded.contentType ?? '';
    const mimeType =
      sniffAudioContainer(downloaded.data) ??
      MEDIA_TYPE_ALIASES[declared] ??
      declared;
    // The duration is unknown: the policy maximum is both the check and the
    // metering worst case; the 2 MiB bound limits what can actually arrive.
    const clip: AudioClip = {
      data: downloaded.data,
      mimeType,
      durationSeconds: DEFAULT_VOICE_POLICY.maxSeconds,
    };
    const checked = checkClip({
      mimeType,
      durationSeconds: clip.durationSeconds,
      size: clip.data.byteLength,
    });
    if (!checked.ok) return checked;
    return this.meteredTranscribe(tenantId, conversationId, message.id, clip);
  }

  /**
   * REV-03: the worst case is reserved on the tenant's LLM budget before the
   * audio leaves the server; a refused reservation means no provider call
   * (the customer is asked to type). Reported tokens are recorded as spend;
   * without a report the worst case stays counted.
   */
  private async meteredTranscribe(
    tenantId: string,
    conversationId: string,
    messageId: string,
    clip: AudioClip,
  ): Promise<TranscriptionResult | { ok: false; code: string }> {
    if (!this.ledger) return this.stt.transcribe(clip);
    // The same caps as model calls: tenant month and conversation lifetime.
    const monthly = this.config.get('LLM_TENANT_MONTHLY_BUDGET_USD', {
      infer: true,
    });
    const conversation = this.config.get('LLM_CONVERSATION_BUDGET_USD', {
      infer: true,
    });
    const worstCaseNano = worstCaseTranscriptionNano(
      usdToNano(
        this.config.get('STT_WORST_CASE_USD_PER_MINUTE', { infer: true }),
      ),
      clip,
    );
    const turnKey = `voice:${messageId}`;
    const reservation = await this.ledger.reserve({
      tenantId,
      conversationId,
      baseInvocationId: `${turnKey}:0`,
      worstCaseNano,
      worstCaseTokens: 0,
      ...(monthly ? { monthlyCapNano: usdToNano(monthly) } : {}),
      ...(conversation ? { conversationCapNano: usdToNano(conversation) } : {}),
    });
    if (!reservation.granted) return { ok: false, code: 'BUDGET_EXHAUSTED' };
    const started = Date.now();
    let result: TranscriptionResult;
    try {
      result = await this.stt.transcribe(clip);
    } catch (error) {
      await this.ledger.markUnknown(
        tenantId,
        reservation.reservationId,
        this.usageEntry(tenantId, conversationId, turnKey, {
          worstCaseNano,
          started,
          outcome: 'unknown_usage:THROWN',
        }),
      );
      throw error;
    }
    const usage = result.usage;
    const entry = this.usageEntry(tenantId, conversationId, turnKey, {
      worstCaseNano,
      started,
      outcome: result.ok ? 'ok' : result.code,
      ...(result.responseId ? { responseId: result.responseId } : {}),
      ...(usage && this.stt.pricing
        ? {
            usage,
            costNano: transcriptionCostNano(this.stt.pricing, usage),
          }
        : {}),
    });
    if (entry.usageBasis === 'reported')
      await this.ledger.settle(tenantId, reservation.reservationId, entry);
    else
      await this.ledger.markUnknown(tenantId, reservation.reservationId, {
        ...entry,
        outcome: `unknown_usage:${entry.outcome}`,
      });
    return result;
  }

  private usageEntry(
    tenantId: string,
    conversationId: string,
    turnKey: string,
    details: {
      readonly worstCaseNano: number;
      readonly started: number;
      readonly outcome: string;
      readonly responseId?: string;
      readonly usage?: { inputTokens: number; outputTokens: number };
      readonly costNano?: number;
    },
  ): LlmUsageEntry {
    return {
      tenantId,
      conversationId,
      turnKey,
      callIndex: 0,
      purpose: 'transcribe',
      tier: 'FAST',
      providerId: this.stt.providerId,
      model: this.stt.model,
      // Unique per tenant and provider: one record per voice note.
      responseId: details.responseId ?? turnKey,
      usage: {
        inputTokens: details.usage?.inputTokens ?? 0,
        outputTokens: details.usage?.outputTokens ?? 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      costNano: details.costNano ?? 0,
      reservedNano: details.worstCaseNano,
      usageBasis: details.costNano !== undefined ? 'reported' : 'unknown',
      pricingVersion: this.stt.pricing?.version ?? 'none',
      durationMs: Date.now() - details.started,
      attempts: 1,
      outcome: details.outcome,
    };
  }
}
