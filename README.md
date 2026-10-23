# AgentCore

Universal AI sales and support agent platform. `AGENTS.md` is the current project specification.

## Requirements

- Node.js 24 (or Node.js 20.19+ / 22.12+)
- pnpm 10+
- Docker with Compose

## Local development

```sh
cp .env.example .env
pnpm install
docker compose up -d
pnpm dev
```

The API listens on port 4000. Check `http://localhost:4000/health` for `{"status":"ok"}`.

The repository is a pnpm workspace: the NestJS API is in `apps/api`, the future web app is reserved in `apps/web`, and shared contracts/configuration live in `packages/`. The web package is a placeholder; no frontend framework is installed yet.

## Database development

The API uses Prisma 7 with PostgreSQL's `pg` driver adapter. Copy `.env.example` to `.env` before running Prisma commands or starting the API, then start local services with `docker compose up -d postgres`. For the API running directly on the host, `POSTGRES_HOST=localhost`; an API container on the Compose network should use `POSTGRES_HOST=postgres`. The local example sets `POSTGRES_SSL_MODE=disable`; the secure default for remote PostgreSQL is `verify-full`, which requires TLS and validates the server certificate. `require` encrypts traffic but does not validate the certificate. The application creates one Prisma Client and one bounded connection pool, and closes both on Nest shutdown. Generate the client with `pnpm db:generate` and apply checked-in migrations with `pnpm db:migrate`. The development seed is repeatable and disabled when `NODE_ENV=production`; run it with `pnpm db:seed`.

Prisma CLI commands and application runtime use `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`; `POSTGRES_SSL_MODE` defaults to `verify-full` when omitted. Prisma CLI builds an encoded connection URL from those values in `apps/api/prisma.config.ts`; runtime uses the same validated values directly in the `pg` adapter. Integration tests use the parallel `TEST_POSTGRES_*` variables for the isolated `agentcore_test` database. `pnpm test:integration` creates that database only if absent, tags it with an AgentCore test marker, applies migrations, and runs real-PostgreSQL tests. It refuses an unmarked existing database, a different test database name, or the configured development database. It does not drop or reset any database. Use `pnpm db:test:seed` and `pnpm db:test:drift` for the corresponding test-database checks.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` before submitting changes.

## Telegram text-channel development

Phase 2 accepts one configured Telegram bot per API process. Create an active `telegram` `ChannelAccount`, then set its UUID as `TELEGRAM_CHANNEL_ACCOUNT_ID` together with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`; configuration is all-or-none. The webhook path is `POST /webhooks/telegram/<channel-account-uuid>`. The application authenticates `X-Telegram-Bot-Api-Secret-Token`, validates text updates, persists the event, inbound message, and outbox job in one PostgreSQL transaction, then acknowledges. `TELEGRAM_RATE_LIMIT_PER_MINUTE` defaults to 120 per account. Do not put token or secret values in source control or logs.

For local webhook development, expose the API through an HTTPS tunnel and configure Telegram's official `setWebhook` method with that URL and the same `secret_token`. Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token`; set `allowed_updates` to `message`. The API does not call `setWebhook` automatically. Unsupported non-text updates are acknowledged and ignored. Inbound text bursts are grouped for a 2 second window and serialized with a PostgreSQL advisory lock per conversation. The sender records `SENT`, `FAILED`, or `UNKNOWN`; a lost response can leave delivery ambiguous, so the system does not blindly resend that message.

Use `pnpm test:unit` for deterministic adapter tests and `pnpm test:integration` for webhook acceptance, PostgreSQL idempotency, debounce/order, and delivery-state tests. The integration suite requires the marked isolated `agentcore_test` database. Queue runtime checks require Redis from Compose.

## Agent core and LLM development

Phase 4 adds the provider-neutral agent core (`apps/api/src/core/`), the education Domain Pack (`apps/api/src/packs/education/`) and the uz-Latn, uz-Cyrl, ru and en Locale Packs (`apps/api/src/locales/`, all `beta` until native review). The default is `LLM_PROVIDER=mock`: a deterministic provider that makes no network calls and never invents facts. To use Claude, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Startup refuses a missing key or a model without a pricing entry in `LLM_PRICING_VERSION`.

Every model call reserves its worst-case cost before it is sent and settles against the usage the provider reports. Calls are bounded by `LLM_TURN_BUDGET_USD`, `LLM_CONVERSATION_BUDGET_USD`, the optional `LLM_TENANT_MONTHLY_BUDGET_USD`, and the call, tool-round and input-size limits in `.env.example`. Usage and cost are stored in nano-USD in `LlmUsageRecord`. A turn that runs out of budget hands over with reason `BUDGET_EXCEEDED` (tool-loop limits: `TOOL_LOOP_LIMIT`). Model prices are versioned config in `apps/api/src/llm/pricing-catalog.ts`, with source URL and `asOf` date. Startup warns when they are more than 30 days old. See `docs/adr/008-llm-provider-and-cost-controls.md` and `docs/LLM_PROVIDER_EVALUATION.md`.

`pnpm test:unit` includes the deterministic eval suite: `eval/cases/education/<locale>/cases.json`, generated by `eval/generate_education_cases.py`, with 50 cases each for uz-Latn and uz-Cyrl and 19 each for ru and en. It uses a scripted model, so it tests control logic, not model quality.

The live eval calls the real API and is billable. It is opt-in:
- Put `ANTHROPIC_API_KEY` in `.env.local` at the repository root (gitignored), then run `LIVE_EVAL=1 pnpm --filter @agentcore/api eval:live`. The key is read from the environment only and is never printed.
- `LIVE_EVAL_BUDGET_USD` (default 0.50, hard maximum 5) caps the whole run and is checked before every model call.
- `LIVE_EVAL_MODELS=claude-haiku-5-5,claude-sonnet-5-5` runs the same cases on each model.
- The report names the provider and model, with pass rate per locale and category, tool-call and structured-output validity, shipped and blocked hard-fact violations, handover correctness, language/script match, latency p50/p95 and cost. It goes to `eval/reports/` (gitignored).

## Agent mode on a Telegram channel

Each channel account has an agent mode. The default is `OFF`, which keeps the Phase 2 echo. Change it with:

```sh
pnpm --filter @agentcore/api agent:mode <channel-account-uuid> shadow
```

- `SHADOW` runs the agent on every inbound batch and stores the draft reply and a turn record in `agent_turns`: tokens, estimated and actual cost, latency, PII-redacted tool calls, guardrail results and outcome. Nothing is sent to the customer, and no handover is opened. This is the mode for a first real-channel trial.
- `LIVE` sends replies and opens durable handovers. It is refused unless an operator handover notifier is configured, and that notifier does not exist until Phase 5. Until then LIVE works only with `NODE_ENV=development` on a local test bot. Elsewhere the `agent:mode` script refuses it, the API refuses to start while the configured Telegram account is LIVE, and any LIVE row is processed as SHADOW. In LIVE every handover is stored with `notification_status = PENDING`, and the bot stays silent while the conversation waits for an operator. Its notice only says that the message was recorded.

Each turn runs as claim → compute → commit (ADR 009). Only the short claim and commit steps use a transaction. The model and tools run without a database transaction, lock or held connection. A newer customer message during compute replaces the reply with one for the merged messages. An operator takeover discards it. A crashed worker's turn is retried as a new attempt, and each attempt's cost is recorded once.
