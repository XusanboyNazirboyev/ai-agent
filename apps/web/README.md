# AgentCore Web Operator Inbox (Phase 6A)

Next.js (App Router), Tailwind, TanStack Query, ICU messages (`intl-messageformat`). The browser only talks to this origin; `/api/*` is proxied to the API (`API_URL`, default `http://127.0.0.1:4000`), so the session cookie is first-party and no CORS is opened.

- `pnpm --filter @agentcore/web dev` / `build` / `start`
- `pnpm test:web`: translation parity (uz-Latn, ru, en), ICU argument parity, no hardcoded JSX text.
- `pnpm test:e2e`: Playwright (Chromium) against the built API and web app and the isolated `agentcore_test` database. Needs `pnpm build`, a running PostgreSQL (pgvector) and Redis, and `pnpm --filter @agentcore/web exec playwright install chromium` once. It reads only `TEST_POSTGRES_*` and `REDIS_URL` and starts the API with an empty env file, so no Telegram or LLM secret can reach it.

Strings live in `src/i18n/<locale>.json`; add a key to all three files. UI translations (ru, uz-Latn) are not native-reviewed.
