/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import { currentTurn, wantsVoice } from './voice-reply.service.js';

const text = (t: string) => ({ type: 'TEXT', text: t });

describe('wantsVoice (owner 2026-11-23, this turn only)', () => {
  it('answers a voice note with voice', () => {
    expect(wantsVoice([{ type: 'VOICE', text: null }])).toBe(true);
  });

  it('speaks when this turn asks for voice in text, in any of the languages', () => {
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

describe('currentTurn', () => {
  const inb = (t: string) => ({ direction: 'INBOUND', type: 'TEXT', text: t });
  const out = (t: string) => ({ direction: 'OUTBOUND', type: 'TEXT', text: t });

  it('a voice request two turns ago does not make a later text reply speak (owner 2026-11-23)', () => {
    // Newest first: the customer's text, the bot's earlier voiced answer, the request.
    const recent = [
      inb('menga offline aylts kursi kerak'),
      out('Hozir bizda bor variantlar...'),
      inb('ovozli habar bilan qaysi kurslar borligini ayt'),
    ];
    expect(currentTurn(recent)).toEqual([recent[0]]);
    expect(wantsVoice(currentTurn(recent))).toBe(false);
  });

  it('keeps every message of a batched turn and skips earlier parts of the same bot reply', () => {
    const recent = [
      out('first part of this reply'),
      inb('IELTS haqida'),
      inb('ovozli xabarda ayting'),
      out('previous answer'),
      inb('old'),
    ];
    expect(currentTurn(recent).map((m) => m.text)).toEqual([
      'IELTS haqida',
      'ovozli xabarda ayting',
    ]);
    expect(wantsVoice(currentTurn(recent))).toBe(true);
    expect(currentTurn([out('only bot')])).toEqual([]);
  });
});
