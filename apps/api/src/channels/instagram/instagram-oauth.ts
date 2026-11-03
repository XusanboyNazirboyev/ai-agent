import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import type { SecretCipher } from '../../secrets/secret-cipher.js';
import { SECRET_CIPHER } from '../../secrets/channel-secret-store.js';
import {
  classifyInstagramError,
  INSTAGRAM_FETCH,
  INSTAGRAM_GRAPH_BASE_URL,
  InstagramApiError,
  type InstagramFetch,
} from './instagram-graph.js';

/**
 * Business Login for Instagram (official Meta docs, read 2026-11-03,
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login):
 * - authorize: `https://www.instagram.com/oauth/authorize?client_id&redirect_uri
 *   &response_type=code&scope=...&state=...`; on cancel the redirect carries
 *   `error=access_denied`;
 * - code exchange: `POST https://api.instagram.com/oauth/access_token` with
 *   `client_id`, `client_secret`, `grant_type=authorization_code`,
 *   `redirect_uri` (the same URI) and `code` (valid 1 hour, single use);
 *   the answer holds a short-lived `access_token`, `user_id` and the granted
 *   `permissions`;
 * - long-lived token (server side only): `GET https://graph.instagram.com/access_token
 *   ?grant_type=ig_exchange_token&client_secret&access_token`, valid 60 days;
 *   refreshed with `ig_refresh_token` once at least 24 hours old (a later slice).
 * Unverified until a live check: whether the exchange answer is wrapped in
 * `data: [...]` and whether `permissions` is a list or a comma string (both
 * are accepted below).
 */
export const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
] as const;

const AUTHORIZE_BASE = 'https://www.instagram.com';
const TOKEN_BASE = 'https://api.instagram.com';
const TIMEOUT_MS = 10_000;
/** An authorization started in tezda must come back within this time. */
export const STATE_TTL_MS = 10 * 60_000;
const STATE_AAD = 'instagram-oauth-state';

/** Who started an authorization: it must come back to the same session. */
export interface OAuthStarter {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly sessionId: string;
}

export class OAuthStateError extends Error {
  constructor() {
    super('Invalid or expired Instagram authorization state');
    this.name = 'OAuthStateError';
  }
}

export class MissingPermissionsError extends Error {
  constructor() {
    super('Instagram did not grant the required permissions');
    this.name = 'MissingPermissionsError';
  }
}

const b64url = (data: Buffer): string => data.toString('base64url');

@Injectable()
export class InstagramOAuthClient {
  private readonly request: InstagramFetch;
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly redirectUri?: string;
  private readonly authorizeBase: string;
  private readonly tokenBase: string;
  private readonly graphOrigin: string;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(SECRET_CIPHER) private readonly cipher?: SecretCipher,
    @Optional() @Inject(INSTAGRAM_FETCH) request?: InstagramFetch,
  ) {
    this.request = request ?? fetch;
    this.appId = config.get('INSTAGRAM_APP_ID', { infer: true });
    this.appSecret = config.get('INSTAGRAM_APP_SECRET', { infer: true });
    this.redirectUri = config.get('INSTAGRAM_OAUTH_REDIRECT_URI', {
      infer: true,
    });
    // Test settings for fake Meta servers; refused in production.
    const fake = config
      .get('INSTAGRAM_OAUTH_BASE_URL', { infer: true })
      ?.replace(/\/+$/u, '');
    this.authorizeBase = fake ?? AUTHORIZE_BASE;
    this.tokenBase = fake ?? TOKEN_BASE;
    this.graphOrigin = new URL(
      config.get('INSTAGRAM_API_BASE_URL', { infer: true }) ??
        INSTAGRAM_GRAPH_BASE_URL,
    ).origin;
  }

  /** App id, app secret, redirect URI and the secret cipher are all set. */
  get configured(): boolean {
    return Boolean(
      this.appId && this.appSecret && this.redirectUri && this.cipher,
    );
  }

  /** An encrypted, authenticated state bound to the starter and a deadline. */
  state(starter: OAuthStarter, now = Date.now()): string {
    const sealed = this.cipher!.seal(
      JSON.stringify({
        v: 1,
        t: starter.tenantId,
        o: starter.operatorId,
        s: starter.sessionId,
        e: now + STATE_TTL_MS,
      }),
      STATE_AAD,
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

  /** Refuses a state that is forged, expired or from another session. */
  checkState(state: string, starter: OAuthStarter, now = Date.now()): void {
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
        this.cipher!.open(
          {
            keyId: outer.k,
            nonce: Buffer.from(outer.n, 'base64url'),
            ciphertext: Buffer.from(outer.c, 'base64url'),
          },
          STATE_AAD,
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

  authorizeUrl(state: string): string {
    const url = new URL(`${this.authorizeBase}/oauth/authorize`);
    url.searchParams.set('client_id', this.appId!);
    url.searchParams.set('redirect_uri', this.redirectUri!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** A network failure never reached Meta's answer: temporary. */
  private async json(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await response.json().catch(() => undefined);
    } catch {
      throw new InstagramApiError('temporary', null, 0);
    }
    const error =
      body && typeof body === 'object'
        ? ((body as { error?: unknown; error_type?: unknown }).error ??
          (body as { error_type?: unknown }).error_type)
        : undefined;
    if (!response.ok || error !== undefined) {
      const raw =
        error && typeof error === 'object'
          ? (error as { code?: unknown }).code
          : undefined;
      const code =
        typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
      throw new InstagramApiError(
        classifyInstagramError(code, response.status),
        code,
        response.status,
      );
    }
    return body;
  }

  /**
   * Code → short-lived token → long-lived token (60 days). Refuses an answer
   * without both scopes: the account could not receive or send messages.
   */
  async exchange(code: string): Promise<{
    readonly token: string;
    readonly expiresInSeconds: number | null;
  }> {
    const form = new URLSearchParams({
      client_id: this.appId!,
      client_secret: this.appSecret!,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri!,
      code,
    });
    const raw = (await this.json(`${this.tokenBase}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })) as { data?: unknown } | null;
    const first = (Array.isArray(raw?.data) ? raw.data[0] : raw) as
      { access_token?: unknown; permissions?: unknown } | undefined;
    const short = first?.access_token;
    if (typeof short !== 'string' || !/^\S{20,2048}$/u.test(short))
      throw new InstagramApiError('rejected', null, 200);
    const granted = Array.isArray(first?.permissions)
      ? first.permissions.filter((p): p is string => typeof p === 'string')
      : typeof first?.permissions === 'string'
        ? first.permissions.split(',').map((p) => p.trim())
        : [];
    if (!INSTAGRAM_SCOPES.every((scope) => granted.includes(scope)))
      throw new MissingPermissionsError();

    const url = new URL(`${this.graphOrigin}/access_token`);
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', this.appSecret!);
    url.searchParams.set('access_token', short);
    const long = (await this.json(url.toString(), { method: 'GET' })) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (
      typeof long?.access_token !== 'string' ||
      !/^\S{20,2048}$/u.test(long.access_token)
    )
      throw new InstagramApiError('rejected', null, 200);
    return {
      token: long.access_token,
      expiresInSeconds:
        typeof long.expires_in === 'number' ? long.expires_in : null,
    };
  }
}
