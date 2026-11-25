import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ReplyTts } from '../../speech/elevenlabs-reply-tts.js';
import { TelegramApiError } from '../telegram/telegram-sender.js';
import { VoiceReplyService } from './voice-reply.service.js';

vi.mock('../../speech/ogg-opus-encoder.js', () => ({
  encodeToAac: vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xf1]))),
}));

const audio = new Uint8Array([1, 2, 3]);
const reply = {
  text: 'Kurs narxi {{F1}} emas, 1 500 000 soʻm.',
  sequence: 7,
  conversationId: 'c1',
  providerChatId: '42',
  channelAccountId: 'acc',
  conversation: { language: 'uz' },
  channelAccount: { channelType: 'telegram' },
};

type Setup = {
  service: VoiceReplyService;
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  sendVoice: ReturnType<typeof vi.fn>;
  synthesize: ReturnType<typeof vi.fn>;
};

function setup(options: {
  reply?: typeof reply | null;
  lastInbound?: { type: string } | null;
  tts?: ReplyTts;
  sendVoice?: () => Promise<void>;
}): Setup {
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce(options.reply === undefined ? reply : options.reply);
  const last =
    options.lastInbound === undefined
      ? { direction: 'INBOUND', type: 'VOICE', text: null }
      : options.lastInbound && {
          direction: 'INBOUND',
          text: null,
          ...options.lastInbound,
        };
  const findMany = vi.fn().mockResolvedValue(last ? [last] : []);
  const sendVoice = vi.fn(
    options.sendVoice ?? ((): Promise<void> => Promise.resolve()),
  );
  const synthesize = vi.fn((): Promise<Uint8Array | null> =>
    Promise.resolve(audio),
  );
  const service = new VoiceReplyService(
    { message: { findFirst, findMany } } as never,
    { sendVoice } as never,
    { get: () => undefined } as never,
    options.tts ?? { synthesize },
  );
  return { service, findFirst, findMany, sendVoice, synthesize };
}

describe('VoiceReplyService (voice replies, owner 2026-11-21)', () => {
  it('speaks a bot reply to a customer whose last message was a voice note', async () => {
    const { service, sendVoice, synthesize, findFirst, findMany } = setup({});
    await service.afterTextSent('t1', 'm1');
    expect(synthesize).toHaveBeenCalledWith(reply.text, 'uz');
    expect(sendVoice).toHaveBeenCalledWith('42', audio, 'acc');
    // Only bot replies, and the inbound looked up before this reply.
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      authorType: 'BOT',
    });
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      conversationId: 'c1',
      sequence: { lt: 7 },
    });
  });

  it('stays silent after a text message, for a non-bot message, or without a reply', async () => {
    for (const options of [
      { lastInbound: { type: 'TEXT' } },
      { lastInbound: null },
      { reply: null },
    ]) {
      const { service, sendVoice, synthesize } = setup(options);
      await service.afterTextSent('t1', 'm1');
      expect(synthesize).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    }
  });

  it('never throws: a failed synthesis or send leaves the text reply alone', async () => {
    const noAudio = setup({ tts: { synthesize: () => Promise.resolve(null) } });
    await expect(
      noAudio.service.afterTextSent('t1', 'm1'),
    ).resolves.toBeUndefined();
    expect(noAudio.sendVoice).not.toHaveBeenCalled();
    const sendFails = setup({
      sendVoice: () => Promise.reject(new Error('403')),
    });
    await expect(
      sendFails.service.afterTextSent('t1', 'm1'),
    ).resolves.toBeUndefined();
  });

  it('logs why Telegram refused the voice, without customer text', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const refused = setup({
      sendVoice: () =>
        Promise.reject(
          new TelegramApiError(
            400,
            null,
            'Bad Request: VOICE_MESSAGES_FORBIDDEN',
          ),
        ),
    });
    await refused.service.afterTextSent('t1', 'm1');
    const line = JSON.parse(String(warn.mock.calls.at(-1)?.[0])) as object;
    expect(line).toEqual({
      event: 'voice_reply.skipped',
      reason: 'send',
      error: 'TelegramApiError',
      code: 400,
      description: 'Bad Request: VOICE_MESSAGES_FORBIDDEN',
    });
    warn.mockRestore();
  });

  it('does nothing when voice replies are off', async () => {
    const findFirst = vi.fn();
    const service = new VoiceReplyService(
      { message: { findFirst } } as never,
      {} as never,
      {
        get: (key: string) => (key === 'VOICE_REPLIES' ? 'off' : undefined),
      } as never,
    );
    await service.afterTextSent('t1', 'm1');
    expect(findFirst).not.toHaveBeenCalled();
  });

  describe('budget (speech counts on the LLM caps)', () => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test fixture; the inferred mocks are the point
    function metered(granted: boolean) {
      const findFirst = vi.fn().mockResolvedValueOnce(reply);
      const findMany = vi
        .fn()
        .mockResolvedValue([
          { direction: 'INBOUND', type: 'VOICE', text: null },
        ]);
      const sendVoice = vi.fn(() => Promise.resolve());
      const synthesize = vi.fn(() => Promise.resolve(audio));
      const ledger = {
        reserve: vi.fn(() =>
          Promise.resolve(
            granted
              ? { granted: true, reservationId: 'r1' }
              : { granted: false, reason: 'TENANT_MONTHLY_LIMIT' },
          ),
        ),
        settle: vi.fn(() => Promise.resolve()),
        release: vi.fn(() => Promise.resolve()),
      };
      const service = new VoiceReplyService(
        {
          message: { findFirst, findMany },
          tenantSubscription: {
            findFirst: () =>
              Promise.resolve({ plan: { limits: { monthlyLlmBudgetUsd: 5 } } }),
          },
        } as never,
        { sendVoice } as never,
        {
          get: (key: string) =>
            key === 'LLM_CONVERSATION_BUDGET_USD' ? '0.25' : undefined,
        } as never,
        { synthesize },
        ledger as never,
      );
      return { service, sendVoice, synthesize, ledger };
    }

    it('reserves the speech cost on the tenant and conversation caps, then records it', async () => {
      const { service, sendVoice, ledger } = metered(true);
      await service.afterTextSent('t1', 'm1');
      // ElevenLabs rate: $0.04 per 1K characters.
      const cost = Math.ceil(reply.text.length * 40_000);
      expect(ledger.reserve).toHaveBeenCalledWith({
        tenantId: 't1',
        conversationId: 'c1',
        baseInvocationId: 'voice-reply:m1:0',
        worstCaseNano: cost,
        worstCaseTokens: 0,
        monthlyCapNano: 5_000_000_000,
        conversationCapNano: 250_000_000,
      });
      expect(ledger.settle).toHaveBeenCalledWith(
        't1',
        'r1',
        expect.objectContaining({
          purpose: 'speak',
          costNano: cost,
          usageBasis: 'estimated',
          conversationId: 'c1',
        }),
      );
      expect(sendVoice).toHaveBeenCalled();
    });

    it('sends text only, without calling the speech provider, when the budget refuses', async () => {
      const { service, sendVoice, synthesize, ledger } = metered(false);
      await service.afterTextSent('t1', 'm1');
      expect(synthesize).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
      expect(ledger.settle).not.toHaveBeenCalled();
    });

    it('releases the reservation when no engine produced audio', async () => {
      const { service, synthesize, ledger, sendVoice } = metered(true);
      synthesize.mockResolvedValueOnce(null as never);
      await service.afterTextSent('t1', 'm1');
      expect(ledger.release).toHaveBeenCalledWith('t1', 'r1');
      expect(ledger.settle).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    });
  });

  describe('Instagram (owner 2026-11-23: same rules as Telegram)', () => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test fixture
    function instagram(options: { media?: boolean; channelType?: string }) {
      const findFirst = vi.fn().mockResolvedValueOnce({
        ...reply,
        channelAccount: { channelType: options.channelType ?? 'instagram' },
      });
      const findMany = vi
        .fn()
        .mockResolvedValue([
          { direction: 'INBOUND', type: 'VOICE', text: null },
        ]);
      const sendVoice = vi.fn(() => Promise.resolve());
      const synthesize = vi.fn(() => Promise.resolve(audio));
      const sendAudio = vi.fn(() => Promise.resolve({ messageId: 'mid' }));
      const put = vi.fn(() =>
        Promise.resolve('https://tezda.example/webhooks/instagram/voice/t.aac'),
      );
      const service = new VoiceReplyService(
        { message: { findFirst, findMany } } as never,
        { sendVoice } as never,
        { get: () => undefined } as never,
        { synthesize },
        undefined,
        { sendAudio } as never,
        options.media === false ? undefined : ({ put } as never),
      );
      return { service, sendVoice, synthesize, sendAudio, put };
    }

    it('answers an Instagram voice note with an AAC audio attachment by URL', async () => {
      const { service, sendAudio, put, sendVoice } = instagram({});
      await service.afterTextSent('t1', 'm1');
      expect(put).toHaveBeenCalledWith(new Uint8Array([0xff, 0xf1]));
      expect(sendAudio).toHaveBeenCalledWith(
        't1',
        'acc',
        '42',
        'https://tezda.example/webhooks/instagram/voice/t.aac',
      );
      expect(sendVoice).not.toHaveBeenCalled();
    });

    it('spends nothing on speech it cannot deliver (no media store, or another channel)', async () => {
      for (const options of [{ media: false }, { channelType: 'facebook' }]) {
        const { service, synthesize, sendAudio } = instagram(options);
        await service.afterTextSent('t1', 'm1');
        expect(synthesize).not.toHaveBeenCalled();
        expect(sendAudio).not.toHaveBeenCalled();
      }
    });
  });
});
