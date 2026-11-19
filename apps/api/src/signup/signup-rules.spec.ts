import { describe, expect, it } from 'vitest';
import {
  PlatformUpdate,
  SIGNUP_TTL_MS,
  botLanguage,
  botMessage,
  constantTimeEqual,
  contactIsOwn,
  generateSignupSecret,
  hashSignupSecret,
  normalizePhone,
  platformWebhookPathSecret,
  plausibleSignupToken,
  signupExpiry,
  slugBase,
  slugCandidates,
  startPayload,
} from './signup-rules.js';

describe('signup token', () => {
  it('is long, url safe, and stored only as a sha256', () => {
    const token = generateSignupSecret();
    expect(plausibleSignupToken(token)).toBe(true);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(hashSignupSecret(token)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashSignupSecret(token)).not.toContain(token);
    expect(generateSignupSecret()).not.toBe(token);
  });
  it('rejects odd shapes', () => {
    for (const bad of ['', 'abc', 'x'.repeat(70), `${'a'.repeat(41)}!`, 5])
      expect(plausibleSignupToken(bad)).toBe(false);
  });
  it('expires after 30 minutes', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(signupExpiry(now).getTime() - now.getTime()).toBe(SIGNUP_TTL_MS);
    expect(SIGNUP_TTL_MS).toBe(30 * 60 * 1000);
  });
});

describe('webhook secrets', () => {
  it('compares in constant time and derives a stable path', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abd', 'abc')).toBe(false);
    expect(constantTimeEqual(undefined, 'abc')).toBe(false);
    const a = platformWebhookPathSecret('s'.repeat(20));
    expect(a).toBe(platformWebhookPathSecret('s'.repeat(20)));
    expect(a).not.toBe(platformWebhookPathSecret('t'.repeat(20)));
    expect(a).toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe('slug', () => {
  it('makes a url slug from latin, cyrillic and accents', () => {
    expect(slugBase('Mening Do‘konim!')).toBe('mening-do-konim');
    expect(slugBase('Салон Красоты 1')).toBe('salon-krasoti-1');
    expect(slugBase('Café  Étoile')).toBe('cafe-etoile');
    expect(slugBase('***')).toBe('business');
    expect(slugBase('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it('offers the base first and suffixed alternatives', () => {
    const list = slugCandidates('Shop');
    expect(list[0]).toBe('shop');
    expect(list.slice(1).every((s) => /^shop-[0-9a-f]{6}$/u.test(s))).toBe(
      true,
    );
    expect(new Set(list).size).toBe(list.length);
    for (const s of list) expect(s.length).toBeLessThanOrEqual(80);
  });
});

describe('contact ownership', () => {
  it('counts only the sender own contact', () => {
    expect(contactIsOwn(5, { user_id: 5 })).toBe(true);
    expect(contactIsOwn(5, { user_id: 6 })).toBe(false);
    expect(contactIsOwn(5, {})).toBe(false);
  });
  it('normalises phones', () => {
    expect(normalizePhone('998 90 123-45-67')).toBe('+998901234567');
    expect(normalizePhone('+998901234567')).toBe('+998901234567');
    expect(normalizePhone('12')).toBeUndefined();
    expect(normalizePhone(5)).toBeUndefined();
  });
});

describe('bot text and parsing', () => {
  it('picks the language, default uz', () => {
    expect(botLanguage('ru-RU')).toBe('ru');
    expect(botLanguage('en')).toBe('en');
    expect(botLanguage('de')).toBe('uz');
    expect(botLanguage(undefined)).toBe('uz');
    expect(botMessage('uz', 'askPhone')).toContain('‘');
  });
  it('reads /start payloads', () => {
    expect(startPayload('/start abc')).toBe('abc');
    expect(startPayload('/start@tezda_bot abc')).toBe('abc');
    expect(startPayload('/start')).toBe('');
    expect(startPayload('hello')).toBeNull();
    expect(startPayload(undefined)).toBeNull();
  });
  it('keeps only typed fields of an update', () => {
    const ok = PlatformUpdate.safeParse({
      update_id: 1,
      message: {
        message_id: 2,
        from: { id: 3, extra: 'x' },
        chat: { id: 3, type: 'private' },
        text: '/start t',
      },
    });
    expect(ok.success).toBe(true);
    expect(PlatformUpdate.safeParse({ update_id: 'x' }).success).toBe(false);
  });
});
