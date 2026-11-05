# Instagram setup (Unified login)

How to set up Instagram DMs for a tezda deployment. Design and sources: [ADR 031](adr/031-instagram-dm-channel.md), amendment 2026-11-05.

Newer Meta apps only offer **Instagram API with Unified login**. The App Dashboard shows "API setup with Instagram login is not available for newer apps", and such an app has no separate Instagram app ID. Sending the Meta App ID to `instagram.com/oauth/authorize` fails with "Invalid platform app", so tezda no longer uses that dialog.

## 1. Meta App Dashboard (by hand)

1. **Use cases → Customize → Instagram API → API setup with Unified login → 1. Configure your app.** Create or select the configuration "Instagram API (Unified Login)" (badge "Instagram Login Compatible"). Copy its **Configuration ID**.
   - Required permissions: `instagram_basic` and `instagram_manage_messages`.
   - The configuration also sets whether the token expires.
2. **Redirect URL:** register `https://<web host>/channels/instagram/callback` in that configuration. Staging uses `https://18-185-27-82.sslip.io/channels/instagram/callback`.
3. **Configure webhooks** (same tab):
   - callback URL `https://<api host>/webhooks/instagram`;
   - verify token = `INSTAGRAM_VERIFY_TOKEN`;
   - subscribe the `messages` field.
4. **Settings → Basic:** the **App ID** and the **App Secret** are the values for the variables below.
5. On the client's Instagram account: **Settings → Messages and story replies → Message controls → Connected Tools → Allow access to messages** must be on. Messaging calls fail while it is off.
6. Before real customers: App Review and the app's Live mode (ADR 031; not part of this setup).

## 2. Server environment (`.env.production` on the host)

| Variable | Value |
|---|---|
| `INSTAGRAM_APP_ID` | Meta App ID (Settings → Basic) |
| `INSTAGRAM_APP_SECRET` | Meta App Secret (Settings → Basic). It also verifies webhook signatures (`X-Hub-Signature-256`). |
| `INSTAGRAM_LOGIN_CONFIG_ID` | Configuration ID from step 1 |
| `INSTAGRAM_OAUTH_REDIRECT_URI` | The redirect URL from step 2, exactly as registered |
| `INSTAGRAM_VERIFY_TOKEN` | Random value, the same one as in step 3 |
| `SECRETS_MASTER_KEY` | Already required; account tokens are stored encrypted |
| `REDIS_URL` | Already required; each authorization state is spent once in Redis |

- Never put secrets in chat, in commits or in `.env.example`.
- After a change, recreate the API container, for example `docker compose ... up -d --wait --force-recreate api` from `/opt/tezda/deploy`.
- Without `INSTAGRAM_LOGIN_CONFIG_ID`, the "Continue with Instagram" button is hidden and only a pasted token can connect an account.

## 3. Connect from tezda

**Channels → Connect Instagram → Continue with Instagram.**
1. Meta's dialog lets the client sign in with Instagram or Facebook (tezda sends `prompt=login`) and choose **one** Instagram professional account.
2. tezda exchanges the code for the system-user token, reads the shared account, stores the token encrypted, and adds the account as DISABLED.
3. **Enable** subscribes the account to `messages`.

The fallback for development, **paste a token**, accepts only an Instagram User access token (checked on graph.instagram.com). A Unified login token (`EAA…`) pasted there is refused.

## 4. Flow and endpoints

| Step | Request |
|---|---|
| Login | `https://www.facebook.com/dialog/oauth?client_id&config_id&override_default_response_type=true&redirect_uri&response_type=code&state&prompt=login` |
| Code exchange (server) | `GET https://graph.facebook.com/v27.0/oauth/access_token?client_id&client_secret&redirect_uri&code` |
| Account discovery | `GET https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?fields=id,username` |
| Webhook subscription | `POST https://graph.facebook.com/v27.0/<IG_ID>/subscribed_apps` (form: `subscribed_fields=messages`, `access_token`) |
| Send a reply | `POST https://graph.facebook.com/v27.0/<IG_ID>/messages?access_token=…` (inferred; see below) |

**State:**
- sealed, bound to tenant, operator and session;
- expires after 10 minutes;
- spent once (`SET NX PX` in Redis);
- a replayed callback is refused, and if Redis is down the connect is refused.

**Not verified with a real Meta account yet:**
- the send endpoint above (no Unified login page states it);
- whether webhook `entry.id` equals the `assigned_instagram_accounts` id;
- the token's lifetime in this configuration;
- token refresh. The Business Integration System User token API needs `business_management`; not implemented.
