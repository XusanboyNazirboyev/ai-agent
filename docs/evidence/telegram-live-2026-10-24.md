# Telegram live verification — status 2026-10-24

**Result: NOT RUN against real Telegram.** No tunnel was opened, no webhook was registered or inspected, no Telegram API call and no message was made. The live checklist below is therefore **unverified**, not passed. Reason: the owner has not authorized the external stage (public tunnel + webhook registration). No defect was found, so no code fix was needed.

Branch `phase4c/telegram-live-verification` (a verification gate named after the Phase 4/5 notes, not a roadmap phase; it closes the "LIVE refused until a real-Telegram check" condition of Phase 5/ADR 018).

## What was verified locally (no network)
| Item | Evidence |
|---|---|
| Account `ACTIVE`, `is_test_account=true`, `SHADOW`, operator chat set; 0 Operator rows; 0 outbox events | read-only SQL on the local dev database |
| API binds `127.0.0.1:4000` (`API_HOST`), proxy binds `127.0.0.1:4100` | listening sockets checked with `lsof` during a local run |
| Webhook secret checked first; missing secret via proxy → 401; `/health` via proxy → 404 | local requests through the proxy |
| Proxy forwards only `POST /webhooks/telegram/<account id>`; 256 KiB body limit → 413 | `dev-guards.spec.ts`, live local run with a dummy upstream |
| Registration keeps pending updates unless `TELEGRAM_DROP_PENDING_UPDATES` is exactly `true` | `webhook-payload.spec.ts`; variable unset |
| Session cleanup idempotent; webhook delete attempted on exit/INT/TERM/HUP; children stopped; failure reported | `session-lib.spec.ts` (real bash library, fake children) |
| Mocked operator flow (card, forward, take-over, reply, bot silence, `/return`, idempotent redelivery) | `handover/*.integration.spec.ts`, `telegram-agent.integration.spec.ts` |
| Logs/tracked files contain no token pattern | grep of the local run logs: 0 matches |
| CI | run 40073295317, job `quality`, success on `1807c40` |

## Live checklist (all UNVERIFIED — need the external stage)
a /start and greeting; b factual answer with provenance (needs a real model; mock cannot); c slot-filling; d handover reason code; e duplicate delivery of one update_id; f two quick messages in order; g uz-Latn, uz-Cyrl, ru, en; h voice message → "unsupported, please write text" (**check first whether voice intake replies at all: currently voice is ignored, see VOICE_READINESS.md**); i photo/sticker/>4096 chars; j blocked bot / chat not found; k kill mid-turn and restart.

## Known limits of the cleanup
`telegram-session.sh` cannot clean up after SIGKILL of the script, a crash or power loss. Then run `pnpm --filter @agentcore/api telegram:live delete` and check `pgrep -fl cloudflared`.

## Requirements for the external stage (needs owner authorization)
1. Explicit GO for `trycloudflare` tunnel (foreground, proxy-only) and `setWebhook` with `drop_pending_updates=false`.
2. Choice of LLM: `mock` only exercises inbound handling and shadow silence; checks b–d, g need a real provider (new cost, data-protection rule: test account + trusted provider).
3. For operator checks: the owner's numeric Telegram user ID and approval to create an Operator row.
4. Run `pnpm build` then `apps/api/scripts/telegram-session.sh`; send the checklist messages; record results here with request ids and per-turn token/cost from the stored turn records.
