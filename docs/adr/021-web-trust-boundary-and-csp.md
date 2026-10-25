# ADR 021 — Web trust boundary for login limits, nonce-based CSP, SSE slot accounting

Status: accepted (implemented on `phase6a/web-operator-inbox`). Supersedes the related lines of ADR 020.

## Evidence that drove the decisions (Next.js 16.4, measured 2026-10-24)
- A Next `rewrites()` proxy forwards client-supplied `X-Forwarded-For`, `X-Real-IP` and `Forwarded` **unchanged** to the API and adds no client address of its own (only `X-Forwarded-Host/Port/Proto`). Measured with an echo upstream.
- Inside `proxy.ts` (middleware) Next sets `X-Forwarded-For` to the socket address **only when the client sent none**; a client-sent value is kept. `request.ip` does not exist.
- Consequence: the API saw every login from the web server's address (one shared limiter bucket for all operators), and "trusting the proxy" would have trusted client-controlled values.

## Decision 1 — trust boundary in a thin web server
- `apps/web/server.mjs` runs Next behind a plain Node HTTP server (production, e2e and dev). For every request it deletes `x-agentcore-client-ip` / `x-agentcore-proxy-auth`; for `/api/*` it sets `x-agentcore-client-ip` to the client address and `x-agentcore-proxy-auth` to `WEB_PROXY_SECRET`.
- Client address: the TCP peer when `TRUSTED_PROXY_HOPS=0` (X-Forwarded-For ignored); with N trusted edge proxies that append to X-Forwarded-For, the N-th entry from the right. Entries further left are client-controlled and never used.
- The API (`loginClientAddress`) believes the client-address header only with a constant-time match of the secret; otherwise it uses the TCP peer. It never reads X-Forwarded-For. `WEB_PROXY_SECRET` is required in production (API config validation and the web server both refuse to start without it).
- No Express `trust proxy` setting is used.

## Decision 2 — per-request nonce CSP
- `apps/web/src/proxy.ts` creates a 128-bit nonce per page request and sets the same policy on the request (Next reads it and stamps the nonce on every framework script) and on the response: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src 'self'`, `img-src 'self' data:`. No `'unsafe-inline'`; `'unsafe-eval'` only in `next dev`.
- Pages render per request (the root layout reads `headers()`); prerendered HTML could not carry a fresh nonce. Cost: no static prerendering of the four small pages.

## Decision 3 — SSE slot accounting (defect found while testing Decision 1)
- `EventsController` registered its `close` handler only after two awaits; a client that disconnected during setup leaked its per-operator slot, bus subscription and timers. After five leaks the operator's streams were refused (429) and the page fell back to polling. Cleanup is now registered before any await and is idempotent. A regression test fails on the old code (5 leaked slots) and passes now.

## Tests
- Unit: `apps/web/src/lib/trust-boundary.test.ts` (hop selection, spoof cases, header stripping).
- HTTP, real AppModule: `apps/api/src/webinbox/login-limit.integration.spec.ts` (independent clients get independent budgets; rotated client headers without or with a wrong secret share the peer budget; X-Forwarded-For never read).
- Browser + real web server + real API: `apps/web/e2e/security.spec.ts` (one client exhausting its budget does not block another; spoofed `X-Forwarded-For` prefixes, `X-Real-IP`, `Forwarded` and boundary headers give no new budget; fresh nonce per response, every `<script>` carries it, no `unsafe-inline`; full sign-in → inbox → conversation → locale switch → reload with zero CSP violations; an inline script injected into the HTML is blocked while the app keeps working).
- Every e2e browser context now acts as a distinct client behind one simulated edge (`TRUSTED_PROXY_HOPS=1`), so the realistic limit (10/min in e2e, 20/min default) stays on.

## Remaining limits
- The login limiter is in memory per API process; several API processes multiply the budget. A shared store (Redis) is the follow-up when more than one API process serves logins.
- If the API is reachable directly from the internet (not only through the web server), logins sent there are attributed to their TCP peer — correct, but such exposure is not intended.
- The per-account lockout (5 failures → 15 min) lets anyone who knows an operator's email lock that operator out. Owner decision below.

## Owner decisions requested (not made here)
| Topic | Options | Trade-off |
|---|---|---|
| Account lockout | (a) keep hard lock 5/15 min; (b) progressive delay per account (e.g. exponential backoff) without a hard lock; (c) lock only after failures from several client addresses, plus CAPTCHA-style challenge | (a) simplest, enables targeted lock-out; (b) slows guessing without denial of service; (c) strongest, more moving parts |
| MFA | (a) none in v1, strong passwords + limits; (b) TOTP for OWNER/ADMIN only; (c) TOTP for all operators; (d) WebAuthn/passkeys | (b) is the usual minimum before real customer data; (d) best phishing resistance, more UI work |
