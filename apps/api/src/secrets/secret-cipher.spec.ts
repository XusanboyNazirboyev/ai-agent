import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createKeyring,
  SecretCipher,
  SecretDecryptionError,
} from './secret-cipher.js';

const key = (): string => randomBytes(32).toString('base64');
const aad = 'tenant:account:bot_token';

describe('SecretCipher', () => {
  it('round-trips, uses a new nonce each time and hides the plaintext', () => {
    const cipher = new SecretCipher(
      createKeyring({ SECRETS_MASTER_KEY: key() }),
    );
    const a = cipher.seal('123456:ABC-secret', aad);
    const b = cipher.seal('123456:ABC-secret', aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('secret');
    expect(cipher.open(a, aad)).toBe('123456:ABC-secret');
  });

  it('refuses another owner, a tampered value and an unknown key', () => {
    const cipher = new SecretCipher(
      createKeyring({ SECRETS_MASTER_KEY: key() }),
    );
    const sealed = cipher.seal('value', aad);
    expect(() => cipher.open(sealed, 'tenant:other:bot_token')).toThrow(
      SecretDecryptionError,
    );
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] ^= 1;
    expect(() => cipher.open({ ...sealed, ciphertext: flipped }, aad)).toThrow(
      SecretDecryptionError,
    );
    expect(() => cipher.open({ ...sealed, keyId: 'nope' }, aad)).toThrow(
      SecretDecryptionError,
    );
    const other = new SecretCipher(
      createKeyring({ SECRETS_MASTER_KEY: key() }),
    );
    expect(() => other.open(sealed, aad)).toThrow(SecretDecryptionError);
  });

  it('rotates: old values open with the previous key, new ones use the current', () => {
    const oldKey = key();
    const before = new SecretCipher(
      createKeyring({ SECRETS_MASTER_KEY: oldKey, SECRETS_KEY_ID: 'k1' }),
    ).seal('value', aad);
    const after = new SecretCipher(
      createKeyring({
        SECRETS_MASTER_KEY: key(),
        SECRETS_KEY_ID: 'k2',
        SECRETS_PREVIOUS_KEYS: `k1:${oldKey}`,
      }),
    );
    expect(after.open(before, aad)).toBe('value');
    expect(after.seal('x', aad).keyId).toBe('k2');
  });

  it('validates key material and names the setting, never a value', () => {
    expect(() =>
      createKeyring({ SECRETS_MASTER_KEY: 'short-secret-value' }),
    ).toThrow(/SECRETS_MASTER_KEY must be 32 bytes/u);
    try {
      createKeyring({ SECRETS_MASTER_KEY: 'short-secret-value' });
    } catch (error) {
      expect(String(error)).not.toContain('short-secret-value');
    }
    expect(() =>
      createKeyring({ SECRETS_MASTER_KEY: key(), SECRETS_KEY_ID: 'bad id!' }),
    ).toThrow(/SECRETS_KEY_ID/u);
    expect(() =>
      createKeyring({
        SECRETS_MASTER_KEY: key(),
        SECRETS_PREVIOUS_KEYS: 'k1:not-a-key',
      }),
    ).toThrow(/SECRETS_PREVIOUS_KEYS/u);
  });
});
