import type { SecretCipher } from '../../secrets/secret-cipher.js';

/**
 * OAuth `state` for Meta connect flows (Instagram ADR 031, Messenger ADR 040):
 * sealed with the secret cipher (AES-GCM), bound to the tenant, operator and
 * session that started it and to a deadline. The `aad` names the flow, so a
 * state started for one channel never completes another. Single use is
 * enforced separately by the OAuth state ledger (Redis).
 */

/** An authorization started in tezda must come back within this time. */
export const STATE_TTL_MS = 10 * 60_000;

/** Who started an authorization: it must come back to the same session. */
export interface OAuthStarter {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly sessionId: string;
}

export class OAuthStateError extends Error {
  constructor() {
    super('Invalid or expired authorization state');
    this.name = 'OAuthStateError';
  }
}

const b64url = (data: Buffer): string => data.toString('base64url');

export function sealOAuthState(
  cipher: SecretCipher,
  aad: string,
  starter: OAuthStarter,
  now = Date.now(),
): string {
  const sealed = cipher.seal(
    JSON.stringify({
      v: 1,
      t: starter.tenantId,
      o: starter.operatorId,
      s: starter.sessionId,
      e: now + STATE_TTL_MS,
    }),
    aad,
  );
  return b64url(
    Buffer.from(
      JSON.stringify({
        k: sealed.keyId,
        n: b64url(sealed.nonce),
        c: b64url(sealed.ciphertext),
      }),
    ),
  );
}

/** Throws OAuthStateError for a forged, expired or foreign state. */
export function openOAuthState(
  cipher: SecretCipher,
  aad: string,
  state: string,
  starter: OAuthStarter,
  now = Date.now(),
): void {
  let claims: {
    v?: unknown;
    t?: unknown;
    o?: unknown;
    s?: unknown;
    e?: unknown;
  };
  try {
    const outer = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8'),
    ) as { k?: unknown; n?: unknown; c?: unknown };
    if (
      typeof outer.k !== 'string' ||
      typeof outer.n !== 'string' ||
      typeof outer.c !== 'string'
    )
      throw new OAuthStateError();
    claims = JSON.parse(
      cipher.open(
        {
          keyId: outer.k,
          nonce: Buffer.from(outer.n, 'base64url'),
          ciphertext: Buffer.from(outer.c, 'base64url'),
        },
        aad,
      ),
    ) as typeof claims;
  } catch {
    throw new OAuthStateError();
  }
  if (
    claims.v !== 1 ||
    claims.t !== starter.tenantId ||
    claims.o !== starter.operatorId ||
    claims.s !== starter.sessionId ||
    typeof claims.e !== 'number' ||
    claims.e < now
  )
    throw new OAuthStateError();
}
