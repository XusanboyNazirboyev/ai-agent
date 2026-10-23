# AgentCore

Universal AI sales and support agent platform. `AGENTS.md` is the lean project index; the full specification is in `docs/spec/` (start at `docs/spec/README.md`), and the current state is at the top of `docs/PROGRESS.md`.

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

## OpenAI-compatible providers (free or local testing)

`LLM_PROVIDER=openai-compatible` talks to any endpoint that implements OpenAI Chat Completions (`POST {LLM_BASE_URL}/chat/completions`). Configure it with environment variables only: `LLM_BASE_URL`, `LLM_API_KEY` (optional for local servers), `LLM_MODEL_FAST`, `LLM_MODEL_STRONG` and `LLM_PRICING_VERSION`.

The adapter:
- never sends `tool_choice` (`auto` is the default when tools are present);
- sends structured output as `response_format: json_schema` (`LLM_STRUCTURED_OUTPUT=json_object` for JSON-mode-only servers);
- uses `max_tokens` for the output ceiling (`LLM_MAX_TOKENS_PARAM=max_completion_tokens` for servers that require it);
- flags usage it had to estimate (`usage_estimated`).

It retries only transient failures (429 rate limits, 408, 5xx, timeouts), with backoff, jitter and Retry-After. Quota exhaustion, invalid payloads, unauthorized requests and unsupported features are final and end in an `LLM_UNAVAILABLE` handover, never a guardrail failure. `LLM_RATE_LIMIT_RPM`, `LLM_RATE_LIMIT_TPM` and `LLM_RATE_LIMIT_RPD` add a per-process client-side limiter. Free models cost 0, so `LLM_TURN_TOKEN_BUDGET` and `LLM_CONVERSATION_TOKEN_BUDGET` bound them.

These presets are documentation, not built-in behavior. The provider facts and their sources are in `docs/LLM_PROVIDER_EVALUATION.md`.

```sh
# Gemini API free tier via its OpenAI-compatible endpoint (beta per Google).
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_API_KEY=<Gemini API key, in .env.local only>
LLM_MODEL_FAST=gemini-3.1-flash-lite
LLM_MODEL_STRONG=gemini-3.8-flash
LLM_PRICING_VERSION=gemini-free-2026-10-23
# Copy your account's free-tier limits from AI Studio (they are not published in the docs):
LLM_RATE_LIMIT_RPM=<rpm>
LLM_RATE_LIMIT_RPD=<rpd>

# Local Ollama (no key needed; plain http is allowed only for localhost outside production).
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL_FAST=<pulled model, e.g. a local chat model with tool support>
LLM_MODEL_STRONG=<same or larger model>
LLM_PRICING_VERSION=local-free-2026-10-23
```

### Failover routing and provider presets
`LLM_PROVIDER=routed` tries an ordered list of providers per tier (FAST for extraction, STRONG for replies) and fails over on rate limits, quota, outages and unsupported features, with per-provider circuit breakers. Presets for Groq, Gemini, OpenRouter, Mistral and LLM7 are in `apps/api/src/llm/provider-presets.ts`; the default policy is in `apps/api/src/llm/routing/routing-policy.ts` (replace with `LLM_ROUTING_POLICY_FILE`). Set `LLM_PRICING_VERSION=routing-free-2026-10-23`. A candidate whose key variable is unset, or whose model is unpriced, is skipped; a tier with none left stops startup. These providers serve AgentCore only, never Claude Code. `pnpm llm:smoke [provider ...]` runs three tiny capability checks and writes `docs/LLM_PROVIDER_STATUS.md`. See ADR 012.

**Data protection.** Google's pricing page marks Gemini Free Tier content as "Used to improve our products: Yes". Use fake or seed data only with free tiers.

Only providers listed in `LLM_TRUSTED_PROVIDERS` (default `mock`) may receive real customer data. With any other provider:
- `LIVE` is always refused.
- `SHADOW` runs only on channel accounts marked `is_test_account`, unless `LLM_ALLOW_REAL_CUSTOMER_DATA=true` is set explicitly. The API logs a startup warning for untrusted providers and for that override.
- A refused account is held: its messages are closed without calling the model and nothing is sent.

Live eval against this provider: `LIVE_EVAL=1 LIVE_EVAL_PROVIDER=openai-compatible pnpm --filter @agentcore/api eval:live`. It reads the same variables from `.env.local`. `LIVE_EVAL_TOKEN_BUDGET` (default 300000) caps tokens, and the report names the provider host and model.

## Agent mode on a Telegram channel

Each channel account has an agent mode. The default is `OFF`, which keeps the Phase 2 echo. Change it with:

```sh
pnpm --filter @agentcore/api agent:mode <channel-account-uuid> shadow
```

- `SHADOW` runs the agent on every inbound batch and stores the draft reply and a turn record in `agent_turns`: tokens, estimated and actual cost, latency, PII-redacted tool calls, guardrail results and outcome. Nothing is sent to the customer, and no handover is opened. This is the mode for a first real-channel trial.
- `LIVE` sends replies and opens durable handovers. It is refused unless an operator handover notifier is configured, and that notifier does not exist until Phase 5. Until then LIVE works only with `NODE_ENV=development` on a local test bot. Elsewhere the `agent:mode` script refuses it, the API refuses to start while the configured Telegram account is LIVE, and any LIVE row is processed as SHADOW. In LIVE every handover is stored with `notification_status = PENDING`, and the bot stays silent while the conversation waits for an operator. Its notice only says that the message was recorded.

Each turn runs as claim → compute → commit (ADR 009). Only the short claim and commit steps use a transaction. The model and tools run without a database transaction, lock or held connection. A newer customer message during compute replaces the reply with one for the merged messages. An operator takeover discards it. A crashed worker's turn is retried as a new attempt, and each attempt's cost is recorded once.
