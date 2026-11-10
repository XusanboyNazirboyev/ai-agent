import { createHash, randomBytes } from 'node:crypto';

/** Invites are valid for 72 hours (ADR 047 §5). */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** 32 random bytes, base64url: the plain token appears once, in a link. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored; lookups hash the presented token. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Shape check before any lookup: anything else is simply "invalid". */
export function plausibleInviteToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,60}$/u.test(token);
}

export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}
