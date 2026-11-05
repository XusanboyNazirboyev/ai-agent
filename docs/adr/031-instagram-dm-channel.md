# ADR 031: Instagram direct messages as a channel adapter

Status: Proposed (2026-10-31). Slice 1 (pure core), slice 2a (GET verification handshake plus raw-body capture), and slice 2b (signed POST durable intake) are implemented on `feat/instagram-webhook-ingestion`; PR pending.

## Decision
Instagram is a channel adapter beside Telegram (D6). The LLM provider stays separate (D15): one key serves every channel. Slice 1 is pure, dependency-free code in `apps/api/src/channels/instagram/`:
- `verifyInstagramSignature`: HMAC-SHA256 of the raw body with the app secret, `X-Hub-Signature-256: sha256=<hex>`, constant-time compare, run before JSON parsing.
- `answerInstagramHandshake`: GET `hub.mode=subscribe` + `hub.verify_token` -> echo `hub.challenge`.
- `normalizeInstagramWebhook`: Zod-validated payload to channel-neutral events; echoes, self-test, deleted and text-less messages are ignored so the bot never answers itself.
- `evaluateMessagingWindow`: bot 24 hours from the customer's last message; a human operator up to 7 days with the `HUMAN_AGENT` tag. The window uses our receive time, not Meta's `timestamp` (its unit is not stated in the docs read).
- `splitInstagramText`: 1,000 BYTES per text message, split on whitespace, never inside a character.

## Sources (read 2026-10-31, official Meta pages)
- Webhook Notification Examples: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md
- Signature, handshake, windows and limits: `docs/research/channel-rules.md` (checked 2026-10-25).

## Not decided / unverified
- Attachment payload shape, the `timestamp` unit, and App Review and Business Verification lead times are unverified.
- Real customers need Advanced Access (App Review + Business Verification). The owner has no company documents yet, so until then only accounts with a role in the Meta app can be tested.

## Implementation status
- Slice 2a: NestJS `GET /webhooks/instagram` verifies `hub.mode`, `hub.verify_token`, and `hub.challenge`, failing closed when the token is missing or wrong. `NestFactory` preserves raw request bodies for the next POST/signature slice. Meta app secret and verify token are optional environment settings; no secrets are committed.
- POST checks the HMAC against Nest's captured raw body before using the parsed payload. Each text `mid` is stored once per active Instagram channel; contact, conversation, message, inbound event and outbox row are committed in one transaction. Echoes and unsupported/text-less messages are acknowledged as ignored.
- The outbox event type is `instagram.inbound`.
- Slice 3 (2026-11-02, branch `feat/instagram-dm-agent-reply`, stacked on `feat/instagram-webhook-ingestion`):
  - **Agent.** The outbox poller queues `instagram.inbound` (2 s debounce, as Telegram). The processor runs the shared agent pipeline: same modes, effective-mode degradation, handover and idempotent commit. With the assistant OFF nothing is sent (the Phase 2 echo stays Telegram-only).
  - **Batch order.** `inbound-batch.ts` orders by `orderKey` when present; Instagram intake stores its per-conversation message sequence there because a `mid` is opaque. Telegram, without `orderKey`, still orders by `providerMessageId`.
  - **Send.** Customer messages keep the one send queue (`telegram.send`, historical name). `processSend` routes by the account's channel type, so an Instagram message never reaches the Telegram sender. The Instagram path sends only inside 24 hours of the customer's last message (`conversations.last_inbound_at`). The HUMAN_AGENT tag is not used, because its request field is not stated on the pages read. Replies are split into 1,000-byte parts. Retryable Meta errors (codes 1, 2, 4, 17, 341, 368, 613; HTTP 429/5xx) go back to PENDING and are retried. Token (102, 190), permission (10, 200-299) and other errors fail. A lost response stays UNKNOWN. A failure after one part was sent fails `instagram_partial_send` and is never resent.
  - **Credentials.** Each account's Instagram User access token is stored encrypted (`channel_secrets`, purpose `instagram_access_token`). `POST /api/v1/channels/instagram` takes a pasted token, reads `GET /me?fields=user_id,username` (`user_id` is the webhook `entry[].id`), and creates the account DISABLED; another tenant's account is refused. `POST /api/v1/channels/instagram/:id/enable` calls `POST /<IG_ID>/subscribed_apps?subscribed_fields=messages`, and only with `INSTAGRAM_APP_SECRET` and `INSTAGRAM_VERIFY_TOKEN` set. `/disable` stops processing.
  - **Sources (read 2026-11-02).** Graph API version `v26.0` comes from these official pages:
    - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
    - …/get-started
    - …/business-login
    - https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md
    - https://developers.facebook.com/docs/graph-api/guides/error-handling
  - **Tests.** A fake Meta transport covers intake, the agent and send end to end. `INSTAGRAM_API_BASE_URL` (test-only, refused in production) points the client at a fake server.

- Slice 3b (2026-11-02, branch `feat/dev-mock-connector`): Channels page UI for Instagram. "Connect Instagram" opens a dialog for a pasted Instagram User access token; the token is sent once to `POST /api/v1/channels/instagram` and never shown again, then "Enable now". The account card offers enable and disable through the Instagram paths. Test, operator group, token replacement and disconnect stay Telegram-only. Strings in uz-Latn, ru and en. The e2e uses a fake graph.instagram.com (`INSTAGRAM_API_BASE_URL`, test-only).

- Slice 4a (2026-11-03, branch `feat/instagram-oauth-connect`): Business Login for Instagram. "Continue with Instagram" on the Channels page asks `POST /api/v1/channels/instagram/oauth/start` for the authorization URL (`instagram_business_basic`, `instagram_business_manage_messages`) with a `state` sealed by the secret cipher and bound to tenant, operator, session and a 10-minute deadline. Instagram returns the browser to the web page `/channels/instagram/callback`; because the session cookie is SameSite=Strict, the page (not the redirect) posts `code` and `state` to `POST .../oauth/complete`, which checks the state, exchanges the code for a short-lived and then a 60-day token, refuses an answer without both scopes (`MISSING_PERMISSIONS`), and saves the account like a pasted token (audited with `via: oauth`). The page drops `code` and `state` from the address bar at once. The pasted token stays as the fallback. Settings: `INSTAGRAM_APP_ID`, `INSTAGRAM_OAUTH_REDIRECT_URI` (https in production) and the existing `INSTAGRAM_APP_SECRET`; `INSTAGRAM_OAUTH_BASE_URL` is test-only. **Unverified until a live check:** whether the code-exchange answer is wrapped in `data: [...]` and `permissions` is a list or a string (both accepted), that a form-encoded body is accepted, and that the webhook app secret is the one the token exchange takes.

## Next slices
1. Token refresh (`ig_refresh_token`, at least 24 hours old, 60-day lifetime) with expiry tracking (needs an additive migration); until then an account connected with OAuth must be reconnected within 60 days.
2. A live check with an app-role Instagram account under Standard Access (the app must be Live for webhooks); then App Review and Business Verification for the public.
3. Deliveries for a DISABLED account currently get 503 and Meta retries for up to 36 hours; decide whether to acknowledge and drop them. Comments and private replies (7-day rule) remain a separate decision.

## Amendment (2026-11-05): one-click connect through Facebook Login for Business ("Unified login")
- **Found with the owner's Meta app (staging):** the App Dashboard no longer offers "API setup with Instagram login" for this app; Use cases → Instagram API shows "API setup with Unified login" (a Facebook Login for Business configuration, "Instagram Login Compatible", Login URL `https://www.facebook.com/dialog/oauth?client_id=<Meta app id>&config_id=<configuration id>&display=popup&...`), "API setup with Facebook login" and Webhooks. Slice 4a's `instagram.com/oauth/authorize` with that app answers "Sorry, this page isn't available".
- **Owner decision:** one-click connect stays the goal (token pasting is not enough).
- **Documented flow (read 2026-11-05, https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram.md):** dialog `https://www.facebook.com/v27.0/dialog/oauth` with `client_id`, `display=page`, `extras={"setup":{"channel":"IG_API_ONBOARDING"}}`, `redirect_uri`, `response_type=token`, `scope`; tokens come back in the redirect fragment (`access_token`, `expires_in`, `long_lived_token`); then `GET /me/accounts?fields=id,name,access_token,instagram_business_account` gives the Page id, the Page access token and the linked Instagram professional account. The Instagram account must be connected to a Facebook Page.
- **Not documented on that page (to verify before coding, no guessing):** `config_id` and `state` with this dialog; the permission set for messaging (`instagram_manage_messages`, `pages_manage_metadata`); sending and webhook subscription with a Page token (Messenger Platform for Instagram); which secret signs webhooks for this app; the long-lived token's lifetime. "Unified login" itself has no page in the documentation index (llms.txt, 2026-11-05).
- **Plan (slice 4b):** the callback page reads the fragment (never logged, removed from the address bar at once) and posts it with the sealed `state` to the API; the API checks state, reads `/me/accounts`, lets the operator pick the Page/Instagram account, stores the Page token encrypted, subscribes the Page to the app's webhooks, and sends through the Page. Slice 4a stays for apps that still have Instagram login.
- **Needed from the owner:** the full Login URL from the dashboard (Copy; it holds no secret) and whether the Instagram account is connected to a Facebook Page.
