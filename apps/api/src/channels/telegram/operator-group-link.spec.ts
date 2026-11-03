import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGroupLinkCode,
  GROUP_LINK_TTL_SECONDS,
  groupLinkKey,
  startPayload,
  verifyGroupLinkCode,
} from './operator-group-link.js';

const KEY = groupLinkKey(randomBytes(32).toString('base64'));
const ACCOUNT = '019a4b2c-1d2e-7f30-8a4b-5c6d7e8f9a0b';
const OTHER = '019a4b2c-1d2e-7f30-8a4b-5c6d7e8f9a0c';
const NOW = new Date('2026-11-03T14:00:00Z');

describe('operator group link code', () => {
  it('fits a Telegram start parameter and verifies for its account', () => {
    const { code, expiresAt } = createGroupLinkCode(KEY, ACCOUNT, null, NOW);
    expect(code).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(
      GROUP_LINK_TTL_SECONDS * 1000,
    );
    expect(verifyGroupLinkCode(KEY, code, ACCOUNT, null, NOW)).toBe(true);
    expect(
      verifyGroupLinkCode(KEY, code, ACCOUNT.toUpperCase(), null, NOW),
    ).toBe(true);
  });

  it('works once: linking changes the group the code was signed with', () => {
    const { code } = createGroupLinkCode(KEY, ACCOUNT, null, NOW);
    expect(verifyGroupLinkCode(KEY, code, ACCOUNT, '-100111', NOW)).toBe(false);
    const relink = createGroupLinkCode(KEY, ACCOUNT, '-100111', NOW).code;
    expect(verifyGroupLinkCode(KEY, relink, ACCOUNT, '-100111', NOW)).toBe(
      true,
    );
    expect(verifyGroupLinkCode(KEY, relink, ACCOUNT, '-100222', NOW)).toBe(
      false,
    );
  });

  it('refuses another account, another key, expiry and tampering', () => {
    const { code } = createGroupLinkCode(KEY, ACCOUNT, null, NOW);
    expect(verifyGroupLinkCode(KEY, code, OTHER, null, NOW)).toBe(false);
    const otherKey = groupLinkKey(randomBytes(32).toString('base64'));
    expect(verifyGroupLinkCode(otherKey, code, ACCOUNT, null, NOW)).toBe(false);
    const late = new Date(NOW.getTime() + GROUP_LINK_TTL_SECONDS * 1000);
    expect(verifyGroupLinkCode(KEY, code, ACCOUNT, null, late)).toBe(false);
    const bytes = Buffer.from(code, 'base64url');
    bytes[17] = (bytes[17] ?? 0) ^ 1; // a later expiry
    expect(
      verifyGroupLinkCode(KEY, bytes.toString('base64url'), ACCOUNT, null, NOW),
    ).toBe(false);
    for (const bad of ['', 'short', `${code}x`, code.replace(/.$/, '*')])
      expect(verifyGroupLinkCode(KEY, bad, ACCOUNT, null, NOW)).toBe(false);
  });

  it('needs a 32-byte master key', () => {
    expect(() => groupLinkKey(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});

describe('start command payload', () => {
  it('reads /start and /start@bot with one payload', () => {
    expect(startPayload('/start abc_DEF-123')).toBe('abc_DEF-123');
    expect(startPayload('/start@tezda_bot abc')).toBe('abc');
    expect(startPayload('  /start abc  ')).toBe('abc');
  });

  it('ignores anything else', () => {
    for (const text of [
      '/start',
      '/start a b',
      '/stop abc',
      'hello /start abc',
      `/start ${'a'.repeat(65)}`,
      '/start a*b',
    ])
      expect(startPayload(text)).toBeUndefined();
  });
});
