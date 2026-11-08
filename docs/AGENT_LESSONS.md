# Agent lessons (mistakes made, and the rule that prevents each)

Read this before changing code. Each entry: what went wrong, how it was caught, the rule. Add an entry whenever a mistake reaches review, CI or staging.

## 2026-11-05 – 2026-11-07

1. **Built on an assumed Meta flow (Instagram slice 4b).** Wrote a Facebook Login / Page token flow before reading the "Unified login" docs; the configuration issues a Business Integration System User token and `/me/assigned_instagram_accounts`, not Pages. Caught when the owner tested. **Rule:** before coding an external integration, read the exact official page for the exact dashboard setup the owner has, and quote URL + date in the code comment. No docs page → ask, do not infer.
2. **Re-added a setting the owner told me to remove.** Misread "remove it" and put `INSTAGRAM_LOGIN_CONFIG_ID` back on staging. **Rule:** when the owner says remove/revert, do only that; if the wording is ambiguous, ask.
3. **Tested with fake ids that were shorter than real ones.** Every real Instagram DM failed on staging ("value too long" on a VARCHAR(200) key) while all tests passed with ids like `mid.123`. **Rule:** fakes for provider ids, tokens and payloads use real-length values (Instagram mids 150–480 characters); keys built from provider ids are hashed or bounded.
4. **Overwrote an existing file while porting another agent's work.** Copied an untracked `leads.controller.ts` from an older base over the newer one with the same name. **Rule:** before copying files between branches, check `git cat-file -e HEAD:<path>`; merge, never replace.
5. **Renamed an already-applied migration.** Local databases had `20261106100000_lead_pipeline_stages` applied; renaming it would break them. **Rule:** check `_prisma_migrations` in local/test databases before renaming; verify out-of-order deploys on a scratch database instead.
6. **Pushed agent-core changes after only unit and eval tests.** CI failed on an integration test that encoded the old STUCK rule; deploy was skipped. **Rule:** for changes under `core/`, `agent/` or `channels/`, run the full integration suite and the e2e suite locally before pushing.
7. **E2E selected a card by contact name.** CI's fresh database had two leads for the same name (strict-mode violation). **Rule:** e2e locators use stable ids (conversation id, test ids), never display names.
8. **Assumed a provider setting is supported.** `reasoning_effort: minimal` is rejected by `gemini-3.8-flash` (LLM_INVALID_REQUEST). Measured before shipping, so no harm. **Rule:** probe a provider/model option with a real call (cents) before putting it in config.
9. **Evaluation did not match production settings.** `scripts/live-eval.ts` did not pass `LLM_REASONING_EFFORT`, so live-eval results differed from staging. **Rule:** evaluation runs with the same model, thinking level and limits as production; check the provider options in the eval script.
10. **Used a stale code graph.** `graphify-out` in the main checkout was built from an old branch (`18decb29`) while work happened on `feat/production-pilot`. **Rule:** run `graphify update .` in the worktree you are changing (code only, no LLM cost) and check "Built from commit" in `GRAPH_REPORT.md` against `git rev-parse HEAD`.
11. **Committed with a failing test, and made a whole update invalid.** A `pnpm test && git commit` style chain printed a failing normalizer test but still committed; the new strict `voice` schema turned a malformed voice object into an invalid update (before: ignored). **Rule:** check test exit codes before committing (`set -e` or an explicit check); validate an optional sub-object on its own so a bad part is ignored, not fatal to the whole payload.
12. **Hid a lint failure behind a check chain.** Ran `(... pnpm lint >/dev/null && ...)` with `set -e` in a compound command; the lint errors (missing return types in a new test helper) were not seen, CI failed and skipped the deploy. **Rule:** run each gate on its own line and print its exit code (`pnpm -s lint; echo lint=$?`), never through `>/dev/null` or a pipe that hides it.

13. **Ran a formatter without the repo config.** `pnpm exec prettier --write` inside `apps/api` used Prettier defaults (double quotes) and rewrote 1,000+ lines; `prisma format` realigned the whole schema. Caught in `git diff --stat` before commit. **Rule:** format only through the package scripts (`pnpm format`, or `prettier --config ../../packages/config/prettier.json`); never run `prisma format` on the shared schema; check `git diff --stat` after any formatter.

## Standing practices
- Port, don't rewrite: another agent's work is reviewed, reconciled with newer decisions (ADRs), tested, then committed with a note of what changed.
- Never print or commit secret values; check presence and length only.
- Every claim of "works" names the check that was run; skipped checks are listed.
