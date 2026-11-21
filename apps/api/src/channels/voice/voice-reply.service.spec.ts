import { describe, expect, it, vi } from 'vitest';
import type { ReplyTts } from '../../speech/elevenlabs-reply-tts.js';
import { VoiceReplyService } from './voice-reply.service.js';

const audio = new Uint8Array([1, 2, 3]);
const reply = {
  text: 'Kurs narxi {{F1}} emas, 1 500 000 soʻm.',
  sequence: 7,
  conversationId: 'c1',
  providerChatId: '42',
  channelAccountId: 'acc',
  conversation: { language: 'uz' },
};

type Setup = {
  service: VoiceReplyService;
  findFirst: ReturnType<typeof vi.fn>;
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
    .mockResolvedValueOnce(options.reply === undefined ? reply : options.reply)
    .mockResolvedValueOnce(
      options.lastInbound === undefined
        ? { type: 'VOICE' }
        : options.lastInbound,
    );
  const sendVoice = vi.fn(
    options.sendVoice ?? ((): Promise<void> => Promise.resolve()),
  );
  const synthesize = vi.fn((): Promise<Uint8Array | null> =>
    Promise.resolve(audio),
  );
  const service = new VoiceReplyService(
    { message: { findFirst } } as never,
    { sendVoice } as never,
    { get: () => undefined } as never,
    options.tts ?? { synthesize },
  );
  return { service, findFirst, sendVoice, synthesize };
}

describe('VoiceReplyService (voice replies, owner 2026-11-21)', () => {
  it('speaks a bot reply to a customer whose last message was a voice note', async () => {
    const { service, sendVoice, synthesize, findFirst } = setup({});
    await service.afterTextSent('t1', 'm1');
    expect(synthesize).toHaveBeenCalledWith(reply.text, 'uz');
    expect(sendVoice).toHaveBeenCalledWith('42', audio, 'acc');
    // Only bot replies, and the inbound looked up before this reply.
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      authorType: 'BOT',
    });
    expect(findFirst.mock.calls[1]![0].where).toMatchObject({
      conversationId: 'c1',
      direction: 'INBOUND',
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
});
