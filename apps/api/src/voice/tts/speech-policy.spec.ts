import { describe, expect, it } from 'vitest';
import {
  decideSpeech,
  type SpeechDecision,
  type SpeechPolicyInput,
} from './speech-policy.js';

const base: SpeechPolicyInput = {
  replyText: 'Of course, I can help you with that.',
  language: 'en',
  channel: 'telegram',
  settings: { enabledChannels: ['telegram', 'instagram'] },
};

const decide = (over: Partial<SpeechPolicyInput>): SpeechDecision =>
  decideSpeech({ ...base, ...over });

describe('decideSpeech', () => {
  it('speaks a plain supported reply', () => {
    expect(decide({})).toEqual({ speak: true });
    expect(
      decide({ language: 'ru-RU', replyText: 'Конечно, помогу.' }),
    ).toEqual({ speak: true });
  });

  it('is off when the channel is not enabled', () => {
    expect(decide({ settings: { enabledChannels: [] } })).toEqual({
      speak: false,
      reason: 'DISABLED',
    });
    expect(decide({ settings: { enabledChannels: ['instagram'] } })).toEqual({
      speak: false,
      reason: 'DISABLED',
    });
  });

  it('does not speak an empty reply', () => {
    expect(decide({ replyText: '   ' })).toEqual({
      speak: false,
      reason: 'EMPTY_REPLY',
    });
  });

  it('does not speak unsupported languages', () => {
    expect(decide({ language: 'uz-Latn' })).toEqual({
      speak: false,
      reason: 'UNSUPPORTED_LANGUAGE',
    });
  });

  it('enforces the maximum length, configurable', () => {
    expect(decide({ replyText: 'a'.repeat(601) })).toEqual({
      speak: false,
      reason: 'TOO_LONG',
    });
    expect(decide({ replyText: 'a'.repeat(600) })).toEqual({ speak: true });
    expect(
      decide({
        replyText: 'a'.repeat(51),
        settings: { enabledChannels: ['telegram'], maxChars: 50 },
      }),
    ).toEqual({ speak: false, reason: 'TOO_LONG' });
  });

  it.each([
    'The course starts on 5 May.',
    'It costs $20',
    'Only 50% left',
    'Price: {{F1}}',
    'Цена {{ F12 }} в наличии',
    'Это стоит сто долларов',
    'Стоимость 100 сум',
    'Бесплатно, 3 места',
    'It is 20 euro',
  ])('does not speak facts or figures: %s', (replyText) => {
    expect(decide({ replyText })).toEqual({
      speak: false,
      reason: 'CONTAINS_FACTS',
    });
  });

  it('treats non-Latin digits as digits', () => {
    expect(
      decide({
        language: 'ru',
        replyText: 'Телефон ' + String.fromCharCode(0x0663, 0x0664),
      }),
    ).toEqual({ speak: false, reason: 'CONTAINS_FACTS' });
  });

  it.each([
    'See https://example.com/page',
    'Visit www.shop.uz please',
    'Write to me at john@example.com',
    'Message @support_team for help',
    'Our site is example.com',
    'Join t.me/channel',
  ])('does not speak links or contacts: %s', (replyText) => {
    expect(decide({ replyText })).toEqual({
      speak: false,
      reason: 'CONTAINS_LINK_OR_CONTACT',
    });
  });

  it('does not mistake ordinary words for currency words', () => {
    expect(decide({ replyText: 'Awesome, that is a summary of it.' })).toEqual({
      speak: true,
    });
  });

  it('keeps matching a fact reference on repeated calls (no sticky regex state)', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(decide({ replyText: 'ok {{F2}}' })).toEqual({
        speak: false,
        reason: 'CONTAINS_FACTS',
      });
    }
  });
});
