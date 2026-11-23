import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  monthlyLlmBudgetNano,
  openPlanLimits,
} from '../../access/plan-limits.js';
import { LlmBudgetLedger } from '../../agent/llm-budget-ledger.js';
import type { AppEnvironment } from '../../config/environment.js';
import { usdToNano } from '../../core/llm/pricing.js';
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
import { NeuronAiReplyTts } from '../../speech/neuronai-reply-tts.js';
import { ELEVENLABS_PRICING, ttsCostNano } from '../../voice/metering.js';
import { TelegramSender } from '../telegram/telegram-sender.js';

/** Optional override of the reply speech engine (tests). */
export const REPLY_TTS = Symbol('REPLY_TTS');

/** ElevenLabs language codes for the conversation languages we speak. */
const LANGUAGE: Readonly<Record<string, string>> = {
  uz: 'uz',
  ru: 'ru',
  en: 'en',
};

// Owner 2026-11-23: a customer who asks for voice in text gets voice from then
// on in that conversation. Uzbek (Latin and Cyrillic), Russian, English.
const VOICE_REQUEST =
  /ovozli|ovoz\s*(bilan|orqali|xabar|habar|yubor|jo['ʻ‘’`]?nat)|овозли|голосов|голосом|\bvoice\b|\baudio\b|аудио/iu;

/** A voice reply: the last message was a voice note, or the customer asked for voice. */
export function wantsVoice(
  inbound: ReadonlyArray<{ type: string; text: string | null }>,
): boolean {
  return (
    inbound[0]?.type === 'VOICE' ||
    inbound.some(
      (message) =>
        message.type === 'TEXT' && VOICE_REQUEST.test(message.text ?? ''),
    )
  );
}

/**
 * Voice replies (owner 2026-11-21): after a bot text reply reached Telegram,
 * a customer whose last message was a voice note, or who asked for voice in
 * this conversation (owner 2026-11-23), also gets that reply as speech. The text stays (prices and dates remain readable and were checked
 * by the guardrail). Best effort: any failure (quota, network, Telegram)
 * leaves the text reply alone; it runs once per reply because the caller
 * claims the message before sending it.
 */
@Injectable()
export class VoiceReplyService {
  private readonly logger = new Logger('VoiceReplies');
  private readonly tts: ReplyTts | null;
  private readonly mode: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(REPLY_TTS) tts?: ReplyTts,
    @Optional() private readonly ledger?: LlmBudgetLedger,
  ) {
    const mode = config.get('VOICE_REPLIES', { infer: true });
    const apiKey = config.get('ELEVENLABS_API_KEY', { infer: true });
    const voiceId = config.get('VOICE_REPLY_VOICE_ID', { infer: true });
    const geminiKey = config.get('GEMINI_API_KEY', { infer: true });
    const neuronKey = config.get('NEURONAI_API_KEY', { infer: true });
    const eleven =
      apiKey && voiceId ? new ElevenLabsReplyTts({ apiKey, voiceId }) : null;
    // Owner 2026-11-21: NeuronAI's native Uzbek voice first (mode
    // `neuronai`), then Gemini, then ElevenLabs; the first audio wins.
    const neuron =
      mode === 'neuronai' && neuronKey
        ? new NeuronAiReplyTts({
            apiKey: neuronKey,
            voice: config.get('NEURONAI_TTS_VOICE', { infer: true }),
          })
        : null;
    const gemini =
      (mode === 'gemini' || mode === 'neuronai') && geminiKey
        ? new GeminiReplyTts({
            call: sdkTtsCall(geminiKey),
            model: config.get('GEMINI_TTS_MODEL', { infer: true }),
            voice: config.get('GEMINI_TTS_VOICE', { infer: true }),
          })
        : null;
    this.mode = mode;
    const chain: ReplyTts[] = [neuron, gemini, eleven].filter(
      (engine) => engine !== null,
    );
    this.tts =
      tts ??
      (neuron || gemini
        ? new FirstReplyTts(chain)
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
      const inbound = await this.prisma.message.findMany({
        where: {
          tenantId,
          conversationId: reply.conversationId,
          direction: 'INBOUND',
          sequence: { lt: reply.sequence },
        },
        orderBy: { sequence: 'desc' },
        take: 50,
        select: { type: true, text: true },
      });
      if (!wantsVoice(inbound)) return;
      const language = reply.conversation.language?.split('-')[0];
      const audio = await this.meteredSynthesize(
        tenantId,
        reply.conversationId,
        messageId,
        reply.text,
        language ? LANGUAGE[language] : undefined,
      );
      if (audio === 'BUDGET') {
        this.logger.warn(
          JSON.stringify({ event: 'voice_reply.skipped', reason: 'budget' }),
        );
        return;
      }
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

  /**
   * Speech counts on the same tenant-month and conversation caps as model
   * calls: reserved before the provider call, settled after it. A refusal
   * means text only.
   * shortcut: every engine is priced at ElevenLabs' $0.04/1K chars (the
   * dearest verified rate in the chain; Gemini TTS is ~4x cheaper, NeuronAI's
   * price is unverified); price per engine once FirstReplyTts reports which
   * engine spoke.
   */
  private async meteredSynthesize(
    tenantId: string,
    conversationId: string,
    messageId: string,
    text: string,
    languageCode: string | undefined,
  ): Promise<Uint8Array | null | 'BUDGET'> {
    const tts = this.tts!;
    if (!this.ledger) return tts.synthesize(text, languageCode);
    const monthlyCapNano = monthlyLlmBudgetNano(
      await openPlanLimits(this.prisma, tenantId),
      this.config.get('LLM_TENANT_MONTHLY_BUDGET_USD', { infer: true }),
    );
    const conversation = this.config.get('LLM_CONVERSATION_BUDGET_USD', {
      infer: true,
    });
    const costNano = ttsCostNano(ELEVENLABS_PRICING, text.length);
    const turnKey = `voice-reply:${messageId}`;
    const reservation = await this.ledger.reserve({
      tenantId,
      conversationId,
      baseInvocationId: `${turnKey}:0`,
      worstCaseNano: costNano,
      worstCaseTokens: 0,
      ...(monthlyCapNano !== undefined ? { monthlyCapNano } : {}),
      ...(conversation ? { conversationCapNano: usdToNano(conversation) } : {}),
    });
    if (!reservation.granted) return 'BUDGET';
    const started = Date.now();
    const audio = await tts.synthesize(text, languageCode).catch(() => null);
    if (!audio) {
      // Every engine failed before producing audio: nothing billable known.
      await this.ledger.release(tenantId, reservation.reservationId);
      return null;
    }
    await this.ledger.settle(tenantId, reservation.reservationId, {
      tenantId,
      conversationId,
      turnKey,
      callIndex: 0,
      purpose: 'speak',
      tier: 'FAST',
      providerId: 'reply-tts',
      model: this.mode,
      responseId: turnKey,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        estimated: true,
      },
      costNano,
      reservedNano: costNano,
      usageBasis: 'estimated',
      pricingVersion: ELEVENLABS_PRICING.version,
      durationMs: Date.now() - started,
      attempts: 1,
      outcome: 'ok',
    });
    return audio;
  }
}
