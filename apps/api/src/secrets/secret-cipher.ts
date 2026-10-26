import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with a random 96-bit nonce per value. The associated data binds
 * a ciphertext to its owner (tenant, account, purpose): copying a stored value
 * to another row makes decryption fail instead of leaking it there. Keys come
 * from a keyring so the current key can be rotated: new values use the
 * current key id, old values still decrypt with the key id they were stored
 * under.
 */
export interface Keyring {
  readonly currentId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface Sealed {
  readonly keyId: string;
  readonly nonce: Buffer;
  /** Ciphertext followed by the 16-byte authentication tag. */
  readonly ciphertext: Buffer;
}

export class SecretDecryptionError extends Error {
  constructor() {
    super('A stored secret could not be decrypted');
    this.name = 'SecretDecryptionError';
  }
}

const KEY_ID = /^[A-Za-z0-9_-]{1,40}$/u;

function decodeKey(encoded: string, label: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== 32)
    throw new Error(`${label} must be 32 bytes, base64 encoded`);
  return key;
}

/**
 * Builds the keyring from configuration: the current key and optional
 * previous keys as `id:base64` pairs separated by commas. Throws a message
 * that names the setting, never a value.
 */
export function createKeyring(settings: {
  readonly SECRETS_MASTER_KEY: string;
  readonly SECRETS_KEY_ID?: string;
  readonly SECRETS_PREVIOUS_KEYS?: string;
}): Keyring {
  const currentId = settings.SECRETS_KEY_ID ?? 'k1';
  if (!KEY_ID.test(currentId))
    throw new Error('SECRETS_KEY_ID may use letters, digits, _ and - only');
  const keys = new Map<string, Buffer>();
  keys.set(
    currentId,
    decodeKey(settings.SECRETS_MASTER_KEY, 'SECRETS_MASTER_KEY'),
  );
  for (const pair of (settings.SECRETS_PREVIOUS_KEYS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const at = pair.indexOf(':');
    const id = at > 0 ? pair.slice(0, at) : '';
    if (!KEY_ID.test(id) || keys.has(id))
      throw new Error('SECRETS_PREVIOUS_KEYS must be unique id:base64 pairs');
    keys.set(id, decodeKey(pair.slice(at + 1), 'SECRETS_PREVIOUS_KEYS'));
  }
  return { currentId, keys };
}

export class SecretCipher {
  constructor(private readonly keyring: Keyring) {}

  get currentKeyId(): string {
    return this.keyring.currentId;
  }

  seal(plaintext: string, aad: string): Sealed {
    const key = this.keyring.keys.get(this.keyring.currentId)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      keyId: this.keyring.currentId,
      nonce,
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
    };
  }

  open(sealed: Sealed, aad: string): string {
    const key = this.keyring.keys.get(sealed.keyId);
    if (!key || sealed.ciphertext.length < 16)
      throw new SecretDecryptionError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(sealed.ciphertext.subarray(-16));
      return Buffer.concat([
        decipher.update(sealed.ciphertext.subarray(0, -16)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new SecretDecryptionError();
    }
  }
}
