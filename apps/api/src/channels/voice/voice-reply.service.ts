import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import {
  ElevenLabsReplyTts,
  type ReplyTts,
} from '../../speech/elevenlabs-reply-tts.js';
import {
  FirstReplyTts,
  GeminiReplyTts,
  sdkTtsCall,
} from '../../speech/gemini-reply-tts.js';
import { TelegramSender } from '../telegram/telegram-sender.js';

/** Optional override of the reply speech engine (tests). */
export const REPLY_TTS = Symbol('REPLY_TTS');

/** ElevenLabs language codes for the conversation languages we speak. */
const LANGUAGE: Readonly<Record<string, string>> = {
  uz: 'uz',
  ru: 'ru',
  en: 'en',
};

/**
 * Voice replies (owner 2026-11-21): after a bot text reply reached Telegram,
 * a customer whose last message was a voice note also gets that reply as
 * speech. The text stays (prices and dates remain readable and were checked
 * by the guardrail). Best effort: any failure (quota, network, Telegram)
 * leaves the text reply alone; it runs once per reply because the caller
 * claims the message before sending it.
 */
@Injectable()
export class VoiceReplyService {
  private readonly logger = new Logger('VoiceReplies');
  private readonly tts: ReplyTts | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
    config: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(REPLY_TTS) tts?: ReplyTts,
  ) {
    const mode = config.get('VOICE_REPLIES', { infer: true });
    const apiKey = config.get('ELEVENLABS_API_KEY', { infer: true });
    const voiceId = config.get('VOICE_REPLY_VOICE_ID', { infer: true });
    const geminiKey = config.get('GEMINI_API_KEY', { infer: true });
    const eleven =
      apiKey && voiceId ? new ElevenLabsReplyTts({ apiKey, voiceId }) : null;
    // Owner 2026-11-21: Gemini speaks Uzbek; ElevenLabs answers when it fails.
    const gemini =
      mode === 'gemini' && geminiKey
        ? new GeminiReplyTts({
            call: sdkTtsCall(geminiKey),
            model: config.get('GEMINI_TTS_MODEL', { infer: true }),
            voice: config.get('GEMINI_TTS_VOICE', { infer: true }),
          })
        : null;
    this.tts =
      tts ??
      (gemini
        ? new FirstReplyTts(eleven ? [gemini, eleven] : [gemini])
        : mode === 'elevenlabs'
          ? eleven
          : null);
  }

  async afterTextSent(tenantId: string, messageId: string): Promise<void> {
    if (!this.tts) return;
    try {
      const reply = await this.prisma.message.findFirst({
        where: { id: messageId, tenantId, authorType: 'BOT' },
        select: {
          text: true,
          sequence: true,
          conversationId: true,
          providerChatId: true,
          channelAccountId: true,
          conversation: { select: { language: true } },
        },
      });
      if (!reply?.text) return;
      const lastInbound = await this.prisma.message.findFirst({
        where: {
          tenantId,
          conversationId: reply.conversationId,
          direction: 'INBOUND',
          sequence: { lt: reply.sequence },
        },
        orderBy: { sequence: 'desc' },
        select: { type: true },
      });
      if (lastInbound?.type !== 'VOICE') return;
      const language = reply.conversation.language?.split('-')[0];
      const audio = await this.tts.synthesize(
        reply.text,
        language ? LANGUAGE[language] : undefined,
      );
      if (!audio) {
        this.logger.warn(
          JSON.stringify({ event: 'voice_reply.skipped', reason: 'tts' }),
        );
        return;
      }
      await this.sender.sendVoice(
        reply.providerChatId,
        audio,
        reply.channelAccountId,
      );
    } catch {
      this.logger.warn(
        JSON.stringify({ event: 'voice_reply.skipped', reason: 'send' }),
      );
    }
  }
}
