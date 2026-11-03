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
