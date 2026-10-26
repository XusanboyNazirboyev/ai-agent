# Session handoff, 2026-10-26

Hands the work of session `c4255948` (ADR 026 Stage 0, slice 1, slice 1c, the EduFlow plan) to a fresh session. A new session should read this file, then `docs/PROGRESS.md`, `docs/adr/026-agent-platform-v2.md` and `docs/design/agent-platform-v2-roadmap.md`. Another Claude session works in the main worktree on `web/design-pages` and `docs/telegram-live-evidence`. Do not touch its processes, its worktree, its branches or `agentcore_test`.

## State on main (`a19c486`)
- `phase6a` was merged (`25be79b`), then the ADR 026 design docs.
- Slice 1 was merged (`59a31a7`): the scenario harness, 50 scenarios, the deterministic grader and the v1 baseline.
- The `llm:smoke` merge fix is DEF-004.
- DEF-001..004 are in `docs/DEFECTS.md`.
- The tracked evidence is `docs/evidence/slice1-v1-baseline.md` and `slice1-baseline-reports.md`.
- Merged branches were deleted with `git branch -d`.

## Branches awaiting owner review (pushed, NOT merged)
| Branch | Head | CI | Content |
|---|---|---|---|
| `slice1c/free-baseline` | `9a653e7` | run 40306610382: success | Free-tier baseline harness (additive): `provider-traffic.ts`, `ledger.ts`, `subsets.ts`, `baseline-report.ts`, 24 tests, `eval/scenarios/subsets/core-30.json`, scripts `baseline` and `provider:probe` |
| `docs/eduflow-connector-plan` | `d807448` | run 40305537208: success | `docs/connectors/eduflow/CONNECTOR_PLAN.md` with gaps G1–G9, plus the redacted copy of `openapi.json`. Plan only, no connector code |
| `docs/session-handoff-2026-10-26` | this file | not pushed | This handoff |

Worktrees: `../ai-agent-freebase` (slice 1c), `../ai-agent-eduflow` (plan), `../ai-agent-handoff` (this). Database `agentcore_slice1` is kept for simulation runs.

## Approved decisions (owner)
- **ADR 026**, decisions 1–6:
  - $50/month hard cap, with a cost estimate before any paid run;
  - retail stays mock-only, and EduFlow is the first live project;
  - Instagram under Standard Access first, with App Review submitted only after the demo works end to end;
  - Telegram Business only after the Premium requirement is re-verified;
  - narrow customer memory, after a legal review;
  - slice 4 only after live Telegram evidence;
  - judge calibration on ≥ 20 conversations per language.
- **Frozen thresholds.** v1 behaviour does not change in measurement slices.
- **Paid gating baseline.** Approved in principle. It runs only after the owner adds `ANTHROPIC_API_KEY` (not added; no budget for now).
- **Slice 1c amendments 1–9:**
  - Run identity is (lane, unit, k, scenario hash, commit), with no mixing.
  - Coverage is reported per lane. INFRA above 20% prints "INCOMPLETE - no pass rate".
  - Pacing comes from response headers; presets are a fallback only and labelled unverified.
  - Per-minute throttling is kept apart from per-day quota.
  - A fixed core-30 subset (sha256 `b9b7d28c…6cdbc6f3`).
  - k=1 on the Groq lane only. Other lanes get smoke checks only (≤ 5 calls per provider per day) until the owner reviews Groq.
  - The output is labelled "measurement only, not a gate".
- **EduFlow:**
  - The deployed Learnix server holds test data and is the staging target. Lead writes are allowed there only after owner approval.
  - Production is read-only with a restricted role.
  - The contract is `docs/connectors/eduflow/openapi.json`; do not ask for Swagger to be enabled.
  - The base URL comes from `EDUFLOW_BASE_URL`, with HTTPS required outside localhost.
  - CI uses recorded fixtures only.
  - The allow-list and the NEVER list are in `CONNECTOR_PLAN.md`.

## Groq lane baseline (k=1, slice 1c)
- **Lane:** `groq:openai/gpt-oss-20b|openai/gpt-oss-120b`, commit `9a653e7d4c4c`, suite `38f47101a367`, k=1, 130 units (core-30 first), scripted customer, database `agentcore_slice1`.
- **Ledger and reports:** `../ai-agent-freebase/eval/reports/baselines/groq_*/9a653e7d4c4c-38f47101a367{.jsonl,-core-30.md,-full.md}`. These are gitignored. Rebuild them with `SIM=1 pnpm baseline report`.
- **Status at handoff:** see the final report in the session reply. The run resumes from the ledger: rerunning `SIM=1 SIM_POSTGRES_DATABASE=agentcore_slice1 SIM_LANE=groq SIM_K=1 pnpm baseline run` in `apps/api` repeats only missing and INFRA runs. Any commit on that branch changes the identity and starts a new ledger.

## Smoke probes (2026-10-26, synthetic prompts only)
- **Gemini** `gemini-3.5-flash-lite`: chat, tool call and json_schema all ok.
- **OpenRouter:**
  - `/key` showed 0 of 50 free requests per day used.
  - 5 `:free` models advertise tools and structured outputs.
  - `dots-studio/dots-3-note-preview:free` passed all three calls.
- **Mistral** `mistral-small-latest`: HTTP 429 with body code 1300. The window is unknown, and the meaning of the code is unverified.

## Official-source checks on 2026-10-26 (update `docs/research/channel-rules.md` after owner review)
| Claim | Source (read 2026-10-26) | Confidence |
|---|---|---|
| WhatsApp terms §4.7 "AI Providers": providers of LLMs, generative AI and general-purpose assistants may not use the platform when AI is the primary, not incidental, functionality (Meta decides). A business may engage an AI provider as its Solution Provider, but platform data must not train or improve models; fine-tuning for the business's own use is allowed. The page was last updated 2026-09-23. **No longer from a secondary source.** | https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform (served in Russian; whatsapp.com/legal/business-solution-terms redirects here) | High for the existence and gist; the English wording is a translation |
| WhatsApp is charged per *delivered* message since 2025-07-01. Since 2026-10-01, service messages beyond 1,000 per number per month and in-window utility messages are charged. Customer-to-business messages are free. | https://developers.facebook.com/docs/whatsapp/pricing/ , …/pricing/updates-to-pricing/ | High |
| WhatsApp Rest of Asia Pacific USD rates (marketing $0.0842; utility, authentication and service $0.0113, as recorded on 2026-10-25) | Rate cards are CSV/PDF files from the pricing page; the HTML text gives no figures, and the business.whatsapp.com page loads rates by script | **Unverified** in this session. Only a marketing increase for RoAP from 2026-10-01 is stated |
| WhatsApp hosting fee | Not mentioned on the pricing pages | Unverified (no statement either way) |
| Instagram messaging API price | The Instagram Platform overview has no pricing statement | Unverified (no official statement found) |
| Standard Access: permissions only from users with a role on the app. Advanced Access: any user, which requires Business Verification and may need App Review per permission (linked-business requirement from 2023-12-01). Instagram: Advanced Access is "required if your app serves Instagram professional accounts that you don't own or manage". | https://developers.facebook.com/docs/graph-api/overview/access-levels/ , https://developers.facebook.com/docs/instagram-platform/overview/ | High |

## Open items
1. Owner review of the Groq lane results, then a decision on the other lanes and on k=3.
2. Owner review and merge decision for `slice1c/free-baseline` and `docs/eduflow-connector-plan`.
3. Six EduFlow questions for the owner (see `CONNECTOR_PLAN.md`), plus Learnix gaps G1–G9.
4. Paid baseline: waits for `ANTHROPIC_API_KEY`.
5. Not started, and not to start without a GO: slice 1b, slice 2, and connector code.
6. Owner prerequisites: Meta Business Verification, which needs company documents (none yet).
