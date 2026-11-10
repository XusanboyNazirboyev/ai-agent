import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_TTL_MS,
  inviteExpiry,
  plausibleInviteToken,
} from './invite-token.js';

describe('invite tokens (ADR 047 §5)', () => {
  it('are random, url-safe and plausible', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(plausibleInviteToken(a)).toBe(true);
  });

  it('are stored only as SHA-256, never in clear', () => {
    const token = generateInviteToken();
    const hash = hashInviteToken(token);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashInviteToken(token)).toBe(hash);
  });

  it('rejects implausible shapes before any lookup', () => {
    for (const value of ['', 'short', 'x'.repeat(200), 'a b'.repeat(20), 42])
      expect(plausibleInviteToken(value)).toBe(false);
  });

  it('expire after 72 hours', () => {
    const now = new Date('2026-11-15T00:00:00Z');
    expect(INVITE_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(inviteExpiry(now).toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });
});
