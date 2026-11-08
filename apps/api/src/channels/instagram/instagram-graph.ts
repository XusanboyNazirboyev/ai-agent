import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';

/**
 * Instagram API with Instagram Login (official Meta docs, read 2026-11-02):
 * - Messaging API, https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api:
 *   `POST https://graph.instagram.com/v26.0/<IG_ID>/messages`,
 *   `Authorization: Bearer <INSTAGRAM_USER_ACCESS_TOKEN>`, body
 *   `{"recipient":{"id":"<IGSID>"},"message":{"text":"..."}}`, response
 *   `{"recipient_id","message_id"}`; text "must be UTF-8 and be a 1000 bytes
 *   or less"; a reply only after the user messaged the account.
 * - Get started, https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started:
 *   `GET /me?fields=user_id,username&access_token=...`; `user_id` "is value
 *   of the `id` field received in webhook notifications for this account".
 * - Webhooks setup, https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md:
 *   `POST /<INSTAGRAM_ACCOUNT_ID>/subscribed_apps?subscribed_fields=...&access_token=...`
 *   returns `{"success": true}`; the app must be Live for app users.
 * - Error handling, https://developers.facebook.com/docs/graph-api/guides/error-handling:
 *   `{"error":{"message","type","code","error_subcode","fbtrace_id"}}`;
 *   codes 1, 2, 4, 17, 341 and 368 are temporary ("wait and retry"), 102 and
 *   190 need a new access token, 10 and 200-299 are missing permissions.
 *   613 is the Send API rate limit (Messenger send-messages page, read
 *   2026-10-28). Rate-limit numbers are not stated on these pages.
 * Instagram API with Unified login (ADR 031 amendment 2026-11-05; official
 * Meta docs read 2026-11-05), with a Business Integration System User token:
 * - webhooks setup, https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md:
 *   "send a `POST` request to the Instagram professional account's
 *   `/subscribed_apps` edge on `graph.facebook.com`",
 *   `https://graph.facebook.com/v27.0/<INSTAGRAM_ACCOUNT_ID>/subscribed_apps`
 *   with `subscribed_fields` and `access_token` as form data, answer
 *   `{"success": true}`; Instagram User tokens and graph.instagram.com "do not
 *   work" there; payloads are signed with the app's App Secret;
 * - .../instagram-api-with-unified-login/authentication and /migration:
 *   requests go to `graph.facebook.com/v27.0/<INSTAGRAM_ACCOUNT_ID>`.
 * Inferred, not stated on any page read: sending is
 * `POST graph.facebook.com/v27.0/<INSTAGRAM_ACCOUNT_ID>/messages` with the
 * same body as the Instagram Login Send API (recipient IGSID, text at most
 * 1,000 bytes); verify on the first live send.
 * Customer text and Meta error text are never put into an error message.
 */
export const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com/v26.0';
export const FACEBOOK_GRAPH_BASE_URL = 'https://graph.facebook.com/v27.0';

/** Numeric Instagram ids (account and Instagram-scoped user ids). */
export const INSTAGRAM_ID = /^[0-9]{1,100}$/u;

export type InstagramErrorKind =
  'rate_limited' | 'temporary' | 'token' | 'permission' | 'rejected';

export class InstagramApiError extends Error {
  constructor(
    readonly kind: InstagramErrorKind,
    readonly code: number | null,
    readonly httpStatus: number,
  ) {
    super(`Instagram API error (${kind}, code ${code ?? 'none'})`);
    this.name = 'InstagramApiError';
  }

  /** Retrying later may succeed; anything else needs a person or a new token. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'temporary';
  }
}

/** A timeout or lost response after the request left: Meta may have sent it. */
export class InstagramAmbiguousSendError extends Error {
  constructor() {
    super('Instagram send outcome is ambiguous');
    this.name = 'InstagramAmbiguousSendError';
  }
}

export function classifyInstagramError(
  code: number | null,
  httpStatus: number,
): InstagramErrorKind {
  if (code !== null) {
    if ([4, 17, 341, 613].includes(code)) return 'rate_limited';
    if ([1, 2, 368].includes(code)) return 'temporary';
    if (code === 102 || code === 190) return 'token';
    if (code === 10 || (code >= 200 && code <= 299)) return 'permission';
  }
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus >= 500) return 'temporary';
  return 'rejected';
}

export type InstagramFetch = typeof fetch;
export const INSTAGRAM_FETCH = Symbol('INSTAGRAM_FETCH');

const TIMEOUT_MS = 10_000;

function errorOf(body: unknown, httpStatus: number): InstagramApiError {
  const raw =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: { code?: unknown } }).error?.code
      : undefined;
  const code = typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
  return new InstagramApiError(
    classifyInstagramError(code, httpStatus),
    code,
    httpStatus,
  );
}

function checkText(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0 || bytes > 1_000)
    throw new RangeError('Instagram text must be 1 to 1000 bytes');
}

function requireId(value: string, what: string): string {
  if (!INSTAGRAM_ID.test(value)) throw new RangeError(`Invalid ${what}`);
  return value;
}

@Injectable()
export class InstagramGraphClient {
  private readonly request: InstagramFetch;
  private readonly base: string;
  private readonly facebookBase: string;

  constructor(
    @Optional() @Inject(INSTAGRAM_FETCH) request?: InstagramFetch,
    @Optional() config?: ConfigService<AppEnvironment, true>,
  ) {
    this.request = request ?? fetch;
    // INSTAGRAM_API_BASE_URL exists for tests with a fake Meta server and is
    // refused in production by the environment schema.
    this.base = (
      config?.get('INSTAGRAM_API_BASE_URL', { infer: true }) ??
      INSTAGRAM_GRAPH_BASE_URL
    ).replace(/\/+$/u, '');
    this.facebookBase = (
      config?.get('INSTAGRAM_API_BASE_URL', { infer: true }) ??
      FACEBOOK_GRAPH_BASE_URL
    ).replace(/\/+$/u, '');
  }

  /** Reads JSON; a network failure here never sent anything, so it is temporary. */
  private async call(url: string, init: RequestInit): Promise<unknown> {
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
    if (!response.ok || (body && typeof body === 'object' && 'error' in body))
      throw errorOf(body, response.status);
    return body;
  }

  /** The professional account behind a token: `user_id` matches webhook `entry[].id`. */
  async me(
    token: string,
  ): Promise<{ readonly userId: string; readonly username: string | null }> {
    const url = new URL(`${this.base}/me`);
    url.searchParams.set('fields', 'user_id,username');
    url.searchParams.set('access_token', token);
    const body = (await this.call(url.toString(), { method: 'GET' })) as {
      user_id?: unknown;
      username?: unknown;
    } | null;
    const userId =
      typeof body?.user_id === 'number' ? String(body.user_id) : body?.user_id;
    if (typeof userId !== 'string' || !INSTAGRAM_ID.test(userId))
      throw new InstagramApiError('rejected', null, 200);
    return {
      userId,
      username: typeof body?.username === 'string' ? body.username : null,
    };
  }

  /** Subscribes the app to this account's webhook fields (e.g. `messages`). */
  async subscribe(
    igUserId: string,
    token: string,
    fields: readonly string[],
  ): Promise<void> {
    const url = new URL(
      `${this.base}/${requireId(igUserId, 'Instagram account id')}/subscribed_apps`,
    );
    url.searchParams.set('subscribed_fields', fields.join(','));
    url.searchParams.set('access_token', token);
    const body = (await this.call(url.toString(), { method: 'POST' })) as {
      success?: unknown;
    } | null;
    if (body?.success !== true)
      throw new InstagramApiError('rejected', null, 200);
  }

  /**
   * The customer's display name (User Profile API, read 2026-11-07:
   * instagram-api-with-instagram-login/messaging-api/user-profile and
   * business-messaging/instagram-messaging/features/user-profile):
   * `GET /<IGSID>?fields=name,username`, on graph.instagram.com with an
   * Instagram User token, on graph.facebook.com otherwise (the Unified login
   * system-user token there is inferred, not stated). Consent exists once the
   * customer has messaged the business. Returns null when Meta refuses
   * (no consent, blocked) or the answer is unusable; never throws for that.
   */
  async customerName(
    igsid: string,
    token: string,
    host: 'instagram' | 'facebook',
  ): Promise<string | null> {
    const base = host === 'instagram' ? this.base : this.facebookBase;
    const url = new URL(`${base}/${requireId(igsid, 'Instagram-scoped id')}`);
    url.searchParams.set('fields', 'name,username');
    url.searchParams.set('access_token', token);
    let body: { name?: unknown; username?: unknown } | null;
    try {
      body = (await this.call(url.toString(), { method: 'GET' })) as {
        name?: unknown;
        username?: unknown;
      } | null;
    } catch {
      return null;
    }
    const clean = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      // Untrusted text: drop control characters, collapse spaces, bound it.
      const text = value
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 100);
      return text.length > 0 ? text : null;
    };
    const name = clean(body?.name);
    if (name) return name;
    const username = clean(body?.username);
    return username && /^[A-Za-z0-9._]{1,30}$/u.test(username)
      ? `@${username}`
      : null;
  }

  /** Unified login: subscribes the account on graph.facebook.com with the system-user token. */
  async subscribeUnified(
    igUserId: string,
    token: string,
    fields: readonly string[],
  ): Promise<void> {
    const body = new URLSearchParams({
      subscribed_fields: fields.join(','),
      access_token: token,
    });
    const answer = (await this.call(
      `${this.facebookBase}/${requireId(igUserId, 'Instagram account id')}/subscribed_apps`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    )) as { success?: unknown } | null;
    if (answer?.success !== true)
      throw new InstagramApiError('rejected', null, 200);
  }

  /**
   * Sends one text (at most 1,000 bytes; split longer replies first). A lost
   * response is ambiguous, never retried blindly.
   */
  async sendText(
    igUserId: string,
    token: string,
    recipientId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    checkText(text);
    return this.send(
      `${this.base}/${requireId(igUserId, 'Instagram account id')}/messages`,
      { authorization: `Bearer ${token}` },
      {
        recipient: { id: requireId(recipientId, 'recipient id') },
        message: { text },
      },
    );
  }

  /**
   * Messenger (ADR 040): subscribes the app to a Facebook Page's webhook
   * fields with that Page's access token, `POST /<PAGE_ID>/subscribed_apps`.
   */
  async subscribeMessengerPage(
    pageId: string,
    pageToken: string,
    fields: readonly string[],
  ): Promise<void> {
    const body = new URLSearchParams({
      subscribed_fields: fields.join(','),
      access_token: pageToken,
    });
    const answer = (await this.call(
      `${this.facebookBase}/${requireId(pageId, 'Facebook Page id')}/subscribed_apps`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    )) as { success?: unknown } | null;
    if (answer?.success !== true)
      throw new InstagramApiError('rejected', null, 200);
  }

  /**
   * Messenger (ADR 040): one text part as the Page, `POST /<PAGE_ID>/messages`
   * with the Page access token, `messaging_type: RESPONSE` (a reply inside
   * the 24-hour window).
   */
  async sendMessengerText(
    pageId: string,
    pageToken: string,
    recipientId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    checkText(text);
    const url = new URL(
      `${this.facebookBase}/${requireId(pageId, 'Facebook Page id')}/messages`,
    );
    url.searchParams.set('access_token', pageToken);
    return this.send(
      url.toString(),
      {},
      {
        recipient: { id: requireId(recipientId, 'recipient id') },
        messaging_type: 'RESPONSE',
        message: { text },
      },
    );
  }

  /** Unified login: sends one text as the account on graph.facebook.com. */
  async sendTextUnified(
    igUserId: string,
    token: string,
    recipientId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    checkText(text);
    const url = new URL(
      `${this.facebookBase}/${requireId(igUserId, 'Instagram account id')}/messages`,
    );
    url.searchParams.set('access_token', token);
    return this.send(
      url.toString(),
      {},
      {
        recipient: { id: requireId(recipientId, 'recipient id') },
        message: { text },
      },
    );
  }

  /**
   * ADR 043: the one private reply to a public comment, as the connected
   * account with its Unified login token. Documented with a Page token on
   * `graph.facebook.com/<PAGE_ID>/messages`, body `recipient: { comment_id }`,
   * within 7 days, one message
   * (https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies.md,
   * read 2026-11-07). The Unified token on `<IG_ID>/messages` is NOT
   * documented for this: verified live before any tenant uses it.
   */
  async sendPrivateReplyUnified(
    igUserId: string,
    token: string,
    commentId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    checkText(text);
    const url = new URL(
      `${this.facebookBase}/${requireId(igUserId, 'Instagram account id')}/messages`,
    );
    url.searchParams.set('access_token', token);
    return this.send(
      url.toString(),
      {},
      {
        recipient: { comment_id: requireId(commentId, 'comment id') },
        message: { text },
      },
    );
  }

  /**
   * ADR 043: a public reply under a top-level comment,
   * `POST graph.facebook.com/{ig-comment-id}/replies?message=...`, answered
   * with `{ id }`; not for hidden comments or live video
   * (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies,
   * read 2026-11-07). Unified token use is not documented: verified live.
   */
  async replyToCommentUnified(
    token: string,
    commentId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    checkText(text);
    const url = new URL(
      `${this.facebookBase}/${requireId(commentId, 'comment id')}/replies`,
    );
    url.searchParams.set('message', text);
    url.searchParams.set('access_token', token);
    return this.send(url.toString(), {}, {}, 'id');
  }

  private async send(
    url: string,
    headers: Record<string, string>,
    payload: unknown,
    idField: 'message_id' | 'id' = 'message_id',
  ): Promise<{ readonly messageId: string }> {
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new InstagramAmbiguousSendError();
    }
    try {
      body = await response.json();
    } catch {
      if (!response.ok) throw errorOf(undefined, response.status);
      throw new InstagramAmbiguousSendError();
    }
    if (!response.ok || (body && typeof body === 'object' && 'error' in body))
      throw errorOf(body, response.status);
    const messageId = (body as Record<string, unknown> | null)?.[idField];
    if (typeof messageId !== 'string' || messageId === '')
      throw new InstagramAmbiguousSendError();
    return { messageId };
  }
}
