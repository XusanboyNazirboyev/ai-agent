# ADR 051 — Channel-neutral InboundProcessor extraction (P1.2)

Status: accepted (implemented as a no-behaviour-change refactor, 2026-11-11). Roadmap item P1.2; `docs/audit/2026-11-10/AGENTCORE_ARCHITECTURE_RECOMMENDATION.md` §2.

## Context

`apps/api/src/channels/telegram/telegram-processor.ts` (`TelegramProcessor`) already processed Telegram, Instagram and Messenger inbound events and sends (`processInstagramInbound`, `sendMeta`, `sendCarousel`, `instagram.inbound` / `facebook.inbound`, comment replies). The Telegram path/name hosted other channels, which would make adding WhatsApp and web chat confusing and error-prone.

## Decision

1. **Pure move (step 1):** move implementation to `apps/api/src/channels/inbound/inbound-processor.ts` and rename the class to `InboundProcessor`. Keep constructor signature, public methods, exported types (`TelegramQueueEvent`, `ProcessResult`), queries, transactions, log event names/strings, queue/job/outbox type handling, and error handling unchanged. Logger context string remains `TelegramProcessor` to avoid log-shape drift.
2. **Compatibility shim:** leave `apps/api/src/channels/telegram/telegram-processor.ts` as a thin re-export (`InboundProcessor as TelegramProcessor`, plus type re-exports) so existing imports/tests keep working untouched.
3. **Wiring (step 2):** DI in `telegram.module.ts` and `telegram-queue.runtime.ts` uses `InboundProcessor` with identical provider/token behaviour.
4. **Neutral naming (step 3):** add `InboundQueueEvent` as an alias of `TelegramQueueEvent`; keep `TelegramQueueEvent`, queue names, job names, outbox event types and log event names unchanged (persisted/monitored).
5. **Specs (step 4):** no processor-specific unit spec existed at `telegram-processor.spec*`; existing integration/spec files remain unchanged and continue to import via the compatibility path.
6. **No splitting/interfaces:** the ~726-line implementation is not split and no new abstraction layers/interfaces are introduced in this extraction.

## No-behaviour-change guarantee

This ADR covers structure and naming only. Queries, transactions, advisory locks, outbox/event types, retries, delivery states, guard/access/voice/agent/handover/lead/action/CRM flows, log lines and error handling are intended to be byte-for-byte equivalent in effect. Any defect noticed during the move is reported, not fixed here.

## Removing the compatibility file later

After a separate reviewed change migrates all imports (source, tests, scripts) to `channels/inbound/inbound-processor.js` / `InboundProcessor` / `InboundQueueEvent`, the shim `apps/api/src/channels/telegram/telegram-processor.ts` and old type names can be removed. Queue names, job ids, outbox event types and persisted payload shapes must remain stable unless migrated explicitly.

## Verification

Per-step `pnpm typecheck` and `pnpm lint`; final `pnpm format:check` and `pnpm --filter @agentcore/api test:unit` (integration/e2e left to the reviewing agent). See commit history on branch `feat/p1-2-inbound-processor`.
