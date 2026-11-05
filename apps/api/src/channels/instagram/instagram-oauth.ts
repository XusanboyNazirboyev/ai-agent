import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import type { SecretCipher } from '../../secrets/secret-cipher.js';
import { SECRET_CIPHER } from '../../secrets/channel-secret-store.js';
import {
  classifyInstagramError,
  FACEBOOK_GRAPH_BASE_URL,
  INSTAGRAM_FETCH,
  INSTAGRAM_ID,
  InstagramApiError,
  type InstagramFetch,
} from './instagram-graph.js';

/**
 * One-click connect through Instagram API with Unified login (ADR 031
 * amendment 2026-11-05). Newer Meta apps no longer offer "API setup with
 * Instagram login" (App Dashboard: "not available for newer apps"), so
 * `instagram.com/oauth/authorize` answers "Invalid platform app" with the
 * Meta App ID; it is not used any more. Official Meta docs read 2026-11-05:
 * - https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started:
 *   login URL `https://www.facebook.com/dialog/oauth` with `client_id` (Meta
 *   app ID), `config_id` (required), `redirect_uri` (registered in the
 *   configuration), `response_type=code`, optional `display=popup` and
 *   `prompt=login` ("shows both options": Instagram or Facebook); code
 *   exchange `GET https://graph.facebook.com/v27.0/oauth/access_token` with
 *   `client_id`, `client_secret` (Meta app ID and App Secret, "not
 *   Instagram's"), `code`, server side only; accounts with
 *   `GET /me/assigned_instagram_accounts?fields=id,username` (`id` is the
 *   Instagram professional account ID used in request paths);
 * - .../instagram-api-with-unified-login/authentication: the token is a
 *   Business Integration System User access token, scoped to the client's
 *   business portfolio; "Whether the access token expires depends on your
 *   configuration"; requests go to `graph.facebook.com/<INSTAGRAM_ACCOUNT_ID>`;
 * - the App Dashboard's Login URL for the owner's configuration (2026-11-05)
 *   also carries `override_default_response_type=true` and `state`, which
 *   the manual login flow documents
 *   (https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow.md;
 *   there `redirect_uri` is "required and must be the same" in the exchange,
 *   so it is sent too).
 * Not documented, so not done: refreshing the token (the BISU token API needs
 * `business_management`); the shape of `assigned_instagram_accounts` beyond
 * `id,username` (a `data` list, as every Graph edge, is assumed and checked).
 */
const DIALOG_BASE = 'https://www.facebook.com';
const DIALOG_PATH = '/dialog/oauth';
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

/** An Instagram professional account the client shared with the app. */
export interface AssignedInstagramAccount {
  readonly igUserId: string;
  readonly username: string | null;
}

const TOKEN_SHAPE = /^\S{20,2048}$/u;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/u;
const b64url = (data: Buffer): string => data.toString('base64url');

@Injectable()
export class InstagramOAuthClient {
  private readonly request: InstagramFetch;
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly redirectUri?: string;
  private readonly configId?: string;
  private readonly dialogBase: string;
  private readonly graph: string;

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
    this.configId = config.get('INSTAGRAM_LOGIN_CONFIG_ID', { infer: true });
    // Test settings for fake Meta servers; refused in production.
    this.dialogBase = (
      config.get('INSTAGRAM_OAUTH_BASE_URL', { infer: true }) ?? DIALOG_BASE
    ).replace(/\/+$/u, '');
    this.graph = (
      config.get('INSTAGRAM_API_BASE_URL', { infer: true }) ??
      FACEBOOK_GRAPH_BASE_URL
    ).replace(/\/+$/u, '');
  }

  /**
   * Meta app ID, App Secret, configuration ID, redirect URI and the secret
   * cipher are all set. Without the configuration ID there is no login URL
   * that works for a newer app, so one-click connect is off.
   */
  get configured(): boolean {
    return Boolean(
      this.appId &&
      this.appSecret &&
      this.configId &&
      this.redirectUri &&
      this.cipher,
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
    const url = new URL(`${this.dialogBase}${DIALOG_PATH}`);
    url.searchParams.set('client_id', this.appId!);
    url.searchParams.set('config_id', this.configId!);
    url.searchParams.set('override_default_response_type', 'true');
    url.searchParams.set('redirect_uri', this.redirectUri!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    // Offers Instagram as well as Facebook, even when Facebook is signed in.
    url.searchParams.set('prompt', 'login');
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
   * Code → Business Integration System User token → the Instagram
   * professional accounts the client shared. The token never leaves the
   * server and is never part of an error.
   */
  async exchange(code: string): Promise<{
    readonly token: string;
    readonly accounts: AssignedInstagramAccount[];
  }> {
    const exchange = new URL(`${this.graph}/oauth/access_token`);
    exchange.searchParams.set('client_id', this.appId!);
    exchange.searchParams.set('client_secret', this.appSecret!);
    exchange.searchParams.set('redirect_uri', this.redirectUri!);
    exchange.searchParams.set('code', code);
    const answer = (await this.json(exchange.toString(), {
      method: 'GET',
    })) as { access_token?: unknown } | null;
    const token = answer?.access_token;
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token))
      throw new InstagramApiError('rejected', null, 200);

    const assigned = new URL(`${this.graph}/me/assigned_instagram_accounts`);
    assigned.searchParams.set('fields', 'id,username');
    assigned.searchParams.set('access_token', token);
    const listed = (await this.json(assigned.toString(), {
      method: 'GET',
    })) as { data?: unknown } | null;
    if (!Array.isArray(listed?.data))
      throw new InstagramApiError('rejected', null, 200);
    const accounts: AssignedInstagramAccount[] = [];
    for (const row of listed.data as ({
      id?: unknown;
      username?: unknown;
    } | null)[]) {
      const raw = row?.id;
      const igUserId = typeof raw === 'number' ? String(raw) : raw;
      if (typeof igUserId !== 'string' || !INSTAGRAM_ID.test(igUserId))
        continue;
      accounts.push({
        igUserId,
        username:
          typeof row?.username === 'string' && USERNAME.test(row.username)
            ? row.username
            : null,
      });
    }
    return { token, accounts };
  }
}
