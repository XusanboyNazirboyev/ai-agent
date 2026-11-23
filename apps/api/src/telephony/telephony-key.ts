import type { TelephonyProvider } from '../generated/prisma/client.js';
import type { SecretCipher } from '../secrets/secret-cipher.js';

/**
 * The PBX API key, sealed in its telephony_accounts row (ADR 085) with the
 * channel-secret cipher. The associated data binds it to the tenant and
 * provider, so a value copied to another tenant's row does not decrypt.
 */
const aad = (tenantId: string, provider: TelephonyProvider): string =>
  `telephony:${tenantId}:${provider}:api_key`;

export function sealTelephonyApiKey(
  cipher: SecretCipher,
  tenantId: string,
  provider: TelephonyProvider,
  apiKey: string,
): {
  apiKeyKeyId: string;
  apiKeyNonce: Uint8Array<ArrayBuffer>;
  apiKeyCipher: Uint8Array<ArrayBuffer>;
} {
  const sealed = cipher.seal(apiKey, aad(tenantId, provider));
  return {
    apiKeyKeyId: sealed.keyId,
    apiKeyNonce: Uint8Array.from(sealed.nonce),
    apiKeyCipher: Uint8Array.from(sealed.ciphertext),
  };
}

/** The stored key, or undefined after a disconnect. Throws SecretDecryptionError on a tampered row. */
export function openTelephonyApiKey(
  cipher: SecretCipher,
  row: {
    readonly tenantId: string;
    readonly provider: TelephonyProvider;
    readonly apiKeyKeyId: string | null;
    readonly apiKeyNonce: Uint8Array | null;
    readonly apiKeyCipher: Uint8Array | null;
  },
): string | undefined {
  if (!row.apiKeyKeyId || !row.apiKeyNonce || !row.apiKeyCipher)
    return undefined;
  return cipher.open(
    {
      keyId: row.apiKeyKeyId,
      nonce: Buffer.from(row.apiKeyNonce),
      ciphertext: Buffer.from(row.apiKeyCipher),
    },
    aad(row.tenantId, row.provider),
  );
}
