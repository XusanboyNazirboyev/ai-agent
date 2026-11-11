import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * TOTP (RFC 6238) on HOTP (RFC 4226) with `node:crypto` only (ADR 048 §1):
 * HMAC-SHA1, 6 digits, 30 s step by default. Pure functions; storage, replay
 * state and rate limits belong to the caller.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accepted drift: the previous, current and next step. */
export const TOTP_WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32, ignoring case, spaces, dashes and `=` padding; throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/gu, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type HmacAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** RFC 4226 HOTP. `counter` is a non-negative integer below 2^53. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits = TOTP_DIGITS,
  algorithm: HmacAlgorithm = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(
  timeMs: number,
  stepSeconds = TOTP_STEP_SECONDS,
): number {
  return Math.floor(timeMs / 1000 / stepSeconds);
}

export function totpCode(
  secret: Uint8Array,
  timeMs: number,
  options: {
    digits?: number;
    algorithm?: HmacAlgorithm;
    stepSeconds?: number;
  } = {},
): string {
  return hotp(
    secret,
    totpStep(timeMs, options.stepSeconds),
    options.digits ?? TOTP_DIGITS,
    options.algorithm ?? 'sha1',
  );
}

const equalText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Checks a submitted code against the steps in the window and returns the
 * matching step, or undefined. A step less than or equal to `lastStep` is
 * refused (replay, ADR 048 §1). Every step in the window is compared in
 * constant time so timing does not reveal which one matched.
 */
export function verifyTotp(
  secret: Uint8Array,
  submitted: string,
  timeMs: number,
  lastStep: number | null = null,
): number | undefined {
  const code = submitted.replace(/\s/gu, '');
  if (!/^\d{6}$/u.test(code)) return undefined;
  const current = totpStep(timeMs);
  let found: number | undefined;
  for (
    let step = current - TOTP_WINDOW;
    step <= current + TOTP_WINDOW;
    step++
  ) {
    if (step < 0) continue;
    const match = equalText(hotp(secret, step), code);
    if (match && (lastStep === null || step > lastStep)) {
      if (found === undefined || step > found) found = step;
    }
  }
  return found;
}

/** 20 random bytes (160 bits), the RFC 4226 recommended size. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function otpauthUri(
  email: string,
  secret: Uint8Array,
  issuer = 'tezda',
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  return (
    `otpauth://totp/${label}?secret=${base32Encode(secret)}` +
    `&issuer=${encodeURIComponent(issuer)}`
  );
}

const RECOVERY_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 10;

/** 10 base32 characters (50 bits), shown as `XXXXX-XXXXX`. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let raw = '';
    for (let i = 0; i < RECOVERY_LENGTH; i += 1)
      raw += ALPHABET[randomInt(ALPHABET.length)];
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Canonical form of a typed recovery code; undefined when it cannot be one. */
export function normalizeRecoveryCode(input: string): string | undefined {
  const raw = input.replace(/[\s-]/gu, '').toUpperCase();
  return new RegExp(`^[A-Z2-7]{${RECOVERY_LENGTH}}$`, 'u').test(raw)
    ? raw
    : undefined;
}

/**
 * HMAC-SHA256 of a recovery code, keyed by the account's TOTP secret: no
 * extra server key to rotate, and a new enrolment invalidates old codes.
 */
export function hashRecoveryCode(
  secret: Uint8Array,
  normalized: string,
): string {
  return createHmac('sha256', secret).update(normalized).digest('hex');
}
