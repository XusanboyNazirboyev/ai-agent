import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totpCode,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", 8-digit codes.
const SEED = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP core', () => {
  it.each(VECTORS)('matches RFC 6238 Appendix B at T=%i', (seconds, code) => {
    expect(totpCode(SEED, seconds * 1000, { digits: 8 })).toBe(code);
    // The 6-digit code is the last six digits of the 8-digit one.
    expect(totpCode(SEED, seconds * 1000)).toBe(code.slice(2));
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => expect(hotp(SEED, counter)).toBe(code));
  });

  it('round-trips base32 and reads the RFC 4648 examples', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar');
    const random = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
    expect(base32Decode(base32Encode(random)).equals(random)).toBe(true);
    expect(() => base32Decode('1!')).toThrow();
  });

  it('accepts the previous, current and next step and nothing else', () => {
    const now = 1_700_000_000_000;
    const at = (offset: number): string =>
      totpCode(SEED, now + offset * 30_000);
    expect(verifyTotp(SEED, at(-1), now)).toBe(Math.floor(now / 30000) - 1);
    expect(verifyTotp(SEED, at(0), now)).toBe(Math.floor(now / 30000));
    expect(verifyTotp(SEED, at(1), now)).toBe(Math.floor(now / 30000) + 1);
    expect(verifyTotp(SEED, at(-2), now)).toBeUndefined();
    expect(verifyTotp(SEED, at(2), now)).toBeUndefined();
    expect(verifyTotp(SEED, '12345', now)).toBeUndefined();
    expect(verifyTotp(SEED, 'abcdef', now)).toBeUndefined();
  });

  it('refuses a step that was already used (replay)', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    const code = totpCode(SEED, now);
    expect(verifyTotp(SEED, code, now, step - 1)).toBe(step);
    expect(verifyTotp(SEED, code, now, step)).toBeUndefined();
    expect(verifyTotp(SEED, code, now, step + 1)).toBeUndefined();
  });

  it('builds an otpauth URI with the issuer', () => {
    const uri = otpauthUri('a.b@example.test', Buffer.from('foobar'));
    expect(uri).toBe(
      'otpauth://totp/tezda:a.b%40example.test?secret=MZXW6YTBOI&issuer=tezda',
    );
  });

  it('makes distinct recovery codes and hashes the canonical form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes)
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/u);
    const normal = normalizeRecoveryCode(` ${codes[0]!.toLowerCase()} `);
    expect(normal).toBe(codes[0]!.replace('-', ''));
    expect(normalizeRecoveryCode('short')).toBeUndefined();
    const hash = hashRecoveryCode(SEED, normal!);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashRecoveryCode(Buffer.from('other'), normal!)).not.toBe(hash);
  });
});
