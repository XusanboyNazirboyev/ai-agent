import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import {
  checkClip,
  DEFAULT_VOICE_POLICY,
  NotConfiguredSpeechToText,
  type SpeechToText,
  type TranscriptionResult,
} from '../../core/speech/speech-to-text.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import {
  GeminiSpeechToText,
  sdkTranscribeCall,
} from '../../speech/gemini-speech-to-text.js';
import { TelegramSender } from '../telegram/telegram-sender.js';

/** Optional override of the speech-to-text adapter (tests). */
export const SPEECH_TO_TEXT = Symbol('SPEECH_TO_TEXT');

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

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppEnvironment, true>,
    @Optional() private readonly telegram?: TelegramSender,
    @Optional() @Inject(SPEECH_TO_TEXT) stt?: SpeechToText,
  ) {
    const provider = config.get('STT_PROVIDER', { infer: true });
    const key = config.get('STT_API_KEY', { infer: true });
    this.stt =
      stt ??
      (provider === 'gemini' && key
        ? new GeminiSpeechToText(
            sdkTranscribeCall(key),
            config.get('STT_MODEL', { infer: true }),
            DEFAULT_VOICE_POLICY.timeoutMs,
          )
        : new NotConfiguredSpeechToText());
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
      const outcome = await this.transcribeOne(message);
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

  private async transcribeOne(message: {
    readonly channelAccountId: string;
    readonly mediaRef: string | null;
    readonly mediaMimeType: string | null;
    readonly mediaDurationSeconds: number | null;
    readonly channelAccount: { readonly channelType: string };
  }): Promise<TranscriptionResult | { ok: false; code: string }> {
    if (this.stt.providerId === 'none')
      return { ok: false, code: 'NOT_CONFIGURED' };
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
    return this.stt.transcribe({ data, mimeType, durationSeconds });
  }
}
