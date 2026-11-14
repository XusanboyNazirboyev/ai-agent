import { describe, expect, it } from 'vitest';
import { looksLikeBotToken } from './telegram-token';

describe('looksLikeBotToken', () => {
  it('accepts the usual shape, with surrounding spaces', () => {
    expect(
      looksLikeBotToken(' 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw '),
    ).toBe(true);
    expect(looksLikeBotToken('7000000001:AA_bb-CC0123456789abcdefghij')).toBe(
      true,
    );
  });
  it('says no to the usual mistakes', () => {
    for (const text of [
      '',
      'not-a-token',
      '123456789',
      '123456789:',
      'abcdef:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      '123456789:short',
      'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      '123456789 AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    ])
      expect(looksLikeBotToken(text), text).toBe(false);
  });
});
