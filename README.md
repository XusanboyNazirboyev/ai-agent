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
