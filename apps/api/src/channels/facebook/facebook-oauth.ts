import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import type { SecretCipher } from '../../secrets/secret-cipher.js';
import { SECRET_CIPHER } from '../../secrets/channel-secret-store.js';
import {
  classifyInstagramError,
  FACEBOOK_GRAPH_BASE_URL,
  INSTAGRAM_FETCH,
  InstagramApiError,
  type InstagramFetch,
} from '../instagram/instagram-graph.js';
import {
  openOAuthState,
  sealOAuthState,
  type OAuthStarter,
} from '../meta/meta-oauth-state.js';
import { FACEBOOK_ID } from './facebook-send-body.js';

/**
 * Connecting a Facebook Page for Messenger (ADR 040 slice 2) through
 * Facebook Login for Business. Official Meta docs read 2026-11-05/06:
 * - facebook-login/facebook-login-for-business.md: `config_id` replaces
 *   `scope`; `response_type=code` with `override_default_response_type=true`;
 * - facebook-login/guides/advanced/manual-flow.md: dialog
 *   `https://www.facebook.com/v27.0/dialog/oauth` (client_id, redirect_uri,
 *   state); exchange `GET https://graph.facebook.com/v27.0/oauth/access_token`
 *   with client_id, redirect_uri (the same), client_secret, code; cancel
 *   carries `error=access_denied`;
 * - facebook-login/guides/access-tokens/get-long-lived.md: `grant_type=
 *   fb_exchange_token` gives a long-lived User token; "Long-lived Page access
 *   token do not have an expiration date";
 * - instagram-api-with-facebook-login/business-login-for-instagram.md:
 *   `GET /me/accounts` with fields `id,name,access_token`;
 * - business-messaging/messenger-platform (webhooks, send-messages):
 *   `POST /<PAGE_ID>/subscribed_apps` and `POST /<PAGE_ID>/messages` with the
 *   Page access token; needs `pages_messaging` and `pages_manage_metadata`.
 * Unverified until a live connect: that the configuration issues a User
 * token (a system-user token is used as is when the extension is refused).
 */
const DIALOG_BASE = 'https://www.facebook.com';
const DIALOG_PATH = '/v27.0/dialog/oauth';
const STATE_AAD = 'facebook-oauth-state';
const TIMEOUT_MS = 10_000;
const TOKEN_SHAPE = /^\S{20,2048}$/u;

/** A Facebook Page the person granted, with its access token. */
export interface GrantedPage {
  readonly pageId: string;
  readonly name: string | null;
  readonly pageToken: string;
}

@Injectable()
export class FacebookOAuthClient {
  private readonly request: InstagramFetch;
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly configId?: string;
  private readonly redirectUri?: string;
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
    this.configId = config.get('FACEBOOK_LOGIN_CONFIG_ID', { infer: true });
    this.redirectUri = config.get('FACEBOOK_OAUTH_REDIRECT_URI', {
      infer: true,
    });
    // Test settings for fake Meta servers; refused in production.
    this.dialogBase = (
      config.get('INSTAGRAM_OAUTH_BASE_URL', { infer: true }) ?? DIALOG_BASE
    ).replace(/\/+$/u, '');
    this.graph = (
      config.get('INSTAGRAM_API_BASE_URL', { infer: true }) ??
      FACEBOOK_GRAPH_BASE_URL
    ).replace(/\/+$/u, '');
  }

  get configured(): boolean {
    return Boolean(
      this.appId &&
      this.appSecret &&
      this.configId &&
      this.redirectUri &&
      this.cipher,
    );
  }

  state(starter: OAuthStarter, now = Date.now()): string {
    return sealOAuthState(this.cipher!, STATE_AAD, starter, now);
  }

  checkState(state: string, starter: OAuthStarter, now = Date.now()): void {
    openOAuthState(this.cipher!, STATE_AAD, state, starter, now);
  }

  authorizeUrl(state: string): string {
    const url = new URL(`${this.dialogBase}${DIALOG_PATH}`);
    url.searchParams.set('client_id', this.appId!);
    url.searchParams.set('config_id', this.configId!);
    url.searchParams.set('override_default_response_type', 'true');
    url.searchParams.set('redirect_uri', this.redirectUri!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async json(url: string): Promise<unknown> {
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(url, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await response.json().catch(() => undefined);
    } catch {
      throw new InstagramApiError('temporary', null, 0);
    }
    const error =
      body && typeof body === 'object'
        ? (body as { error?: unknown }).error
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

  private token(answer: unknown): string {
    const token = (answer as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token))
      throw new InstagramApiError('rejected', null, 200);
    return token;
  }

  /** Code → User token (long-lived when possible) → the granted Pages. */
  async exchange(code: string): Promise<GrantedPage[]> {
    const exchange = new URL(`${this.graph}/oauth/access_token`);
    exchange.searchParams.set('client_id', this.appId!);
    exchange.searchParams.set('redirect_uri', this.redirectUri!);
    exchange.searchParams.set('client_secret', this.appSecret!);
    exchange.searchParams.set('code', code);
    const short = this.token(await this.json(exchange.toString()));

    let userToken = short;
    const extend = new URL(`${this.graph}/oauth/access_token`);
    extend.searchParams.set('grant_type', 'fb_exchange_token');
    extend.searchParams.set('client_id', this.appId!);
    extend.searchParams.set('client_secret', this.appSecret!);
    extend.searchParams.set('fb_exchange_token', short);
    try {
      userToken = this.token(await this.json(extend.toString()));
    } catch (error) {
      // A system-user token cannot be extended and needs no extension.
      if (!(error instanceof InstagramApiError) || error.retryable) throw error;
    }

    const accounts = new URL(`${this.graph}/me/accounts`);
    accounts.searchParams.set('fields', 'id,name,access_token');
    accounts.searchParams.set('access_token', userToken);
    const listed = (await this.json(accounts.toString())) as {
      data?: unknown;
    } | null;
    if (!Array.isArray(listed?.data))
      throw new InstagramApiError('rejected', null, 200);
    const pages: GrantedPage[] = [];
    for (const row of listed.data as ({
      id?: unknown;
      name?: unknown;
      access_token?: unknown;
    } | null)[]) {
      const pageId = typeof row?.id === 'number' ? String(row.id) : row?.id;
      const pageToken = row?.access_token;
      if (
        typeof pageId !== 'string' ||
        !FACEBOOK_ID.test(pageId) ||
        typeof pageToken !== 'string' ||
        !TOKEN_SHAPE.test(pageToken)
      )
        continue;
      const name =
        typeof row?.name === 'string' && row.name.trim().length > 0
          ? row.name.trim().slice(0, 100)
          : null;
      pages.push({ pageId, name, pageToken });
    }
    return pages;
  }
}
