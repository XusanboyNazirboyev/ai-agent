# ADR 036: LIVE mode on a channel account with an operator group

- **Status:** Accepted, 2026-11-03 (owner asked for LIVE on staging after it stayed in drafts).
- **Context:** `agent-mode.ts` refused LIVE everywhere except `NODE_ENV=development` because `OPERATOR_HANDOVER_NOTIFIER_AVAILABLE` was `false` "until Phase 5". Phase 5 shipped a different shape: handover notices go to each channel account's own Telegram operator group (`ChannelAccount.operatorChatId`, read by `handover-notification.service.ts`), not to a server-wide notifier. The flag was never revisited, so LIVE could not run on any server, even with a group connected (found on staging, ADR 035 amendment 4).

## Decision
- LIVE is allowed on a channel account that has an operator group. The check takes the account: `liveModeRefusal(policy, account)` passes when `account.operatorChatId` is set.
- Unchanged:
  - an untrusted LLM provider never runs LIVE, group or not;
  - SHADOW rules (test account or `LLM_ALLOW_REAL_CUSTOMER_DATA`) stay as they were;
  - LIVE without a group still degrades to SHADOW (or HOLD);
  - local development still allows LIVE without a group;
  - `OPERATOR_HANDOVER_NOTIFIER_AVAILABLE` stays `false`: there is no server-wide notifier.
- The pipeline, the startup check, the channel summary and `agent:mode` read `operatorChatId`, so the page and the pipeline cannot disagree (the parity test now covers accounts with and without a group: 288 cases).
- The web refusal text (`botRefusal.NO_OPERATOR_NOTIFIER`, en/ru/uz-Latn) now says to connect an operator group first. The ru and uz-Latn wording is not native-reviewed.

## Consequences
- A tenant can run LIVE on staging or production once it connects an operator group; handovers then reach people.
- Real customers in LIVE still wait for ADR 035's P1 (data location) and the Phase 9 rollout (shadow, then limited live).
- Not covered: an Instagram account has no operator group of its own today, so it stays in SHADOW until one can be set for it.

## Amendment 1 (2026-11-03): one-click operator group
- **Why:** the only way to set the group was typing its chat id, a number Telegram does not show. The owner asked for something easier.
- **How:**
  - `POST /api/v1/channels/:id/operator-group/link` (OWNER/ADMIN, audited) returns `https://t.me/<bot>?startgroup=<code>`. Telegram documents that this link lets the user pick a group, adds the bot and starts it there with the parameter (up to 64 base64url characters; [docs](https://core.telegram.org/api/links), read 2026-11-03).
  - The code is stateless: account id, expiry (10 minutes) and an HMAC whose key is derived (HKDF) from `SECRETS_MASTER_KEY`, computed over both and the account's current operator group. Linking changes that group, so a code works once; the update is a compare-and-set, so two uses cannot both win. No table, no migration.
  - The webhook links the group on `/start <code>` or `/start@bot <code>` from a group, writes a SYSTEM audit event and posts a short confirmation there.
  - The web dialog offers "Choose the group in Telegram" and polls until the group is set; entering the chat id stays as a fallback.
- **Also fixed:** a group or channel message was accepted as a customer conversation (the normalizer ignored the chat type), so a bot added to any group would have answered there in LIVE. Now only private chats (or updates without a chat type) reach customer intake; group messages are ignored except the link command and the operator group's own traffic.
- **Checked:** unit tests (code, start parsing, controller routing), integration tests on `agentcore_test` (single use, another account's code, disabled bot, no master key, moving to a new group), the channels e2e spec (the link format and the manual fallback). The real Telegram flow (the exact `/start` text in a group) is checked on staging.

## Amendment 2 (2026-11-07): LIVE without an operator group
- **Owner decision (2026-11-07):** after Instagram was connected the bot could only draft, because an Instagram account has no operator group. The owner asked for LIVE without a Telegram group.
- **Change:** `OPERATOR_HANDOVER_NOTIFIER_AVAILABLE` is `true`. Every handover is stored and shown in the tenant's Web Inbox with its SSE updates (Phase 6A), which counts as the operator notifier; the Telegram operator group stays optional for push notices. `liveModeRefusal` now refuses LIVE only for an untrusted provider (or a policy built with the notifier off, as in tests).
- **Unchanged:** an untrusted provider never runs LIVE; the SHADOW rules; ADR 038 (an operator can take over at any time; idle return).
- **Risk accepted by the owner:** a handover in LIVE waits until someone opens the Web Inbox; there is no push notice without a group. Real customers in LIVE still wait for ADR 035's P1 (data location).
- Ported from the 2026-11-06 worktree into `feat/integration-2026-11-07`.
