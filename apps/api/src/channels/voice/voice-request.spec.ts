/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import { wantsVoice } from './voice-reply.service.js';

const text = (t: string) => ({ type: 'TEXT', text: t });

describe('wantsVoice (owner 2026-11-23)', () => {
  it('answers a voice note with voice', () => {
    expect(wantsVoice([{ type: 'VOICE', text: null }])).toBe(true);
  });

  it('keeps voice after the customer asked for it in text, in any of the languages', () => {
    for (const ask of [
      "menga o'zbek tilida ovozli habar jo'nata olasanmi",
      'ovoz bilan javob bering',
      'овозли хабар юборинг',
      'пришлите голосовое',
      'can you send a voice message?',
    ])
      expect(wantsVoice([text('narxi qancha?'), text(ask)])).toBe(true);
  });

  it('stays text when nobody asked for voice', () => {
    expect(
      wantsVoice([text('aylts'), text('menga general english kerak')]),
    ).toBe(false);
    expect(wantsVoice([])).toBe(false);
  });
});
