# tezda Web Operator Inbox (Phase 6A)

Next.js (App Router), Tailwind, TanStack Query, ICU messages (`intl-messageformat`). The browser only talks to this origin; `/api/*` is proxied to the API (`API_URL`, default `http://127.0.0.1:4000`), so the session cookie is first-party and no CORS is opened.

- `pnpm --filter @agentcore/web dev` / `build` / `start`
- `pnpm test:web`: translation parity (uz-Latn, ru, en), ICU argument parity, no hardcoded JSX text, WCAG AA contrast of every design-token pair (light and dark), and the CSP policies.
- `pnpm test:e2e`: Playwright (Chromium) against the built API and web app and the isolated `agentcore_test` database. Needs `pnpm build`, a running PostgreSQL (pgvector) and Redis, and `pnpm --filter @agentcore/web exec playwright install chromium` once. It reads only `TEST_POSTGRES_*` and `REDIS_URL` and starts the API with an empty env file, so no Telegram or LLM secret can reach it.

Strings live in `src/i18n/<locale>.json`; add a key to all three files. UI translations (ru, uz-Latn) are not native-reviewed.

Serving: `node server.mjs` (scripts `dev` and `start`) runs Next behind a thin server that owns the client-address trust boundary (ADR 021). Production needs `WEB_PROXY_SECRET` (same value as the API) and `TRUSTED_PROXY_HOPS` = number of reverse proxies in front that append `X-Forwarded-For` (0 if none). `next start` alone would lose per-client login limits. The CSP is nonce-based and set per request in `src/proxy.ts`.

Design system: semantic tokens in `src/app/globals.css` (light and dark follow the OS), primitives in `src/components/ui/` (button, badge, avatar, toast, confirmation dialog on the native `<dialog>`, inline icons, brand mark). Never use inline `style` attributes: the production CSP refuses them. The brand mark in `components/ui/brand.tsx` is an inline approximation of the tezda logo; replace its shapes with the official artwork when available. `pnpm test:e2e` includes an axe-core accessibility audit (WCAG 2.2 A/AA) of every screen in light/dark, three languages and desktop/phone, plus keyboard tests. Under `next dev` only, `style-src` allows inline styles because Next's dev overlay needs them (ADR 025); the production build is nonce-only.
