# Slice 1c: Groq lane k=1 baseline, failure assessment (2026-10-26)

**Measurement only, not a gate.** This is a read-only analysis. No model calls, no changes to the evaluated branch, no ledger edits. The evidence comes from four places:
- the ledger `eval/reports/baselines/groq_openai_gpt-oss-20b_openai_gpt-oss-120b/9a653e7d4c4c-38f47101a367.jsonl` (gitignored, in `../ai-agent-freebase`);
- the run log;
- the simulation database `agentcore_slice1`, where every run left one tenant (`sim-<scenario>-<lang>-<uuid>`) holding messages, `agent_turns` (outcome, handover, violations, tool calls, the fact store), handovers and LLM usage;
- the code at the evaluated commit.

All 108 ledger runs were joined to their tenant, with no gaps.

## Provenance (verified)
- **Agent commit** `9a653e7d4c4cd5d646471cb2d380ef34e662a82b` (`slice1c/free-baseline`, clean tree).
  - `git diff origin/main...9a653e7` touches only harness files (`agent/testing/simulation/*`, `scripts/baseline.ts`, `scripts/provider-probe.ts`, `package.json`, `core-30.json`).
  - The agent under test is therefore v1 as on main `a19c486`.
- **Scenario-set sha256** `38f47101a3675545e0324716dbeb4c67abece0ba3c0e1d3a461cbc23d7fc821c`. The core-30 sha256 is `b9b7d28cb774…`.
- **Lane:** Groq, FAST `openai/gpt-oss-20b` (extraction), STRONG `openai/gpt-oss-120b` (reply and regeneration).
- **Run settings:** k=1, scripted customer, synthetic scenarios.
- **Time:** ledger 10:20:47–10:46:25 UTC.
- **Stop:** the run stopped on the Groq per-day quota (429 `rate_limit_exceeded`, day window) during `edu-30/uz-Cyrl`, which is the 1 INFRA run.

## Denominators
| Measure | core-30 | Full suite (130 units) |
|---|---|---|
| Attempted | 30 | 108 |
| INFRA (excluded) | 0 | 1 (`edu-30/uz-Cyrl`) |
| Completed = AGENT + MODEL-FORMAT | 30 = 27 + 3 | 107 = 97 + 10 |
| Passed | 7 | 30 |
| Reported pass rate = passed / completed | 7/30 = 23.3% | 30/107 = 28.0% (partial) |
| AGENT-only pass rate = passed / AGENT | 7/27 = 25.9% | 30/97 = 30.9% |
| Outcome over all expected units | 7/30 | 30/130 = 23.1% (22 not run count as not passed) |
| Scenarios that expect a handover | — | 22/23 passed |
| Scenarios that expect anything else (recommend, alternatives, lead, answer, …) | — | **8/85 passed (9.4%)** |

- MODEL-FORMAT runs count as failed in the pass rate. INFRA runs are left out of it.
- **Not run (22):** `edu-30/ru`, `edu-30/en`, and 20 tourism units:
  - `tour-01` ru, en;
  - `tour-02` uz-Latn, ru;
  - `tour-03` uz-Latn, en;
  - `tour-04` ru, en;
  - `tour-05` uz-Latn, ru;
  - `tour-06` uz-Latn, en;
  - `tour-07` uz-Latn, en;
  - `tour-08` ru, en;
  - `tour-09` uz-Latn, ru;
  - `tour-10` uz-Latn, ru.
- The completed set is therefore mostly education. Tourism is represented only by its 10 core-30 units.
- Two passing runs (`edu-14/ru`, `edu-19/ru`) also contain a later `LLM_UNAVAILABLE` handover. They pass because the goal was reached first.
- Safety on the 107 completed runs: 0 invented facts and 0 false success claims. Cross-tenant leaks are not stored in the ledger.

## Failure taxonomy (67 AGENT failures)
| # | Root cause | Runs | Status |
|---|---|---|---|
| T1 | **Display gate blocks the reply, then a GUARDRAIL handover.** 46 of these were blocked on the first reply. `list_offers` was called in all 49, `get_quote` in only 6. Violations: `FACT_NOT_LIVE` 49, `UNSOURCED_NUMBER` 46, `UNSOURCED_AVAILABILITY` 8, `UNSOURCED_CURRENCY` 5 | **49** | Mechanism confirmed (below) |
| T5 | The reply named items in plain text, not as `{{F}}` title references, so nothing counts as shown (`edu-05` ×3, `edu-06` ×2, `tour-05`). Rule 1 of the prompt says items appear only as references, but no guardrail enforces it | 6 | Confirmed from the transcripts |
| T2 | Wrong or early handover:<br>• NEGOTIATION on an injection plus a price question (`edu-25` ×3);<br>• NEGOTIATION on "guarantee a band 7?" (`edu-15/uz-Latn`, which expects no handover);<br>• COMPLAINT on "that's expensive" (`edu-13/uz-Cyrl`);<br>• STUCK after `preferredTime` was asked twice and the script never answers it (`edu-20` en, ru) | 7 | Confirmed outcomes; the routing cause is a hypothesis |
| T4 | No match ("SAT preparation"), and no alternative offered (`edu-11` ×3) | 3 | Confirmed; product decision |
| T3 | Code-switched ru/uz text triggers the trilingual language clarification (`edu-26/ru`) | 1 | Confirmed |
| T6 | A knowledge question ("refund if I cancel?") gets a `destination` slot question first (`tour-10/en`) | 1 | Confirmed |

**T1 mechanism (code at `9a653e7`):**
1. `list_offers` (`core/agent/tools.ts` `describeOffers`) gives the model `priceFact`, `availabilityFact` and `seatsFact` with `live: false`. It also gives the raw `price` string and `seatsLeft`.
2. The mock connector declares `liveQuote: true` and `availability: true`. `displayPolicyFor` therefore requires live evidence, and `checkFactEvidence` rejects every listed price, availability and seats reference (`FACT_NOT_LIVE`).
3. Prompt rule 2 tells the model to call `get_quote` only "when the customer asks what they will pay". It says nothing about availability or seats.
4. Offer and item `attributes` are passed raw, with no fact id: schedules such as `Mon/Wed 18:00-20:00`, `departureDate`, `nights`, `hotelStars`, levels such as `B1-B2`. Any digit the model copies from them fails the number check (`UNSOURCED_NUMBER`, `guardrails.ts`, which rejects every digit not echoed from the customer or a title). All 10 mock fixtures carry digits in their attributes.
5. The regeneration call is sent with `tools: []` (`agent-turn.ts` ~703), so the model cannot call `get_quote` or `check_availability` to repair `FACT_NOT_LIVE`. The regeneration message gives no specific guidance.
6. After one failed regeneration, ADR 013 hands the conversation over with reason GUARDRAIL. The code comment at `agent-turn.ts:669` still says "then a safe code-rendered fallback", which is stale.

Not verifiable: the blocked drafts are not stored (`agent_turns.draft_text` holds the handover template), so the exact numbers the model typed are unknown. That they come from attributes or the raw price/seat fields is a strong hypothesis.

## MODEL-FORMAT (10 runs)
- **9 × `json_validate_failed`.** In every case the first call of the turn failed: extraction, FAST `gpt-oss-20b`, `response_format: json_schema` with `strict: true` (`calls: 1`, no intent).
  - The extraction output ceiling is `min(600, LLM_MAX_OUTPUT_TOKENS)` = 600.
  - Successful extractions used up to 591 output tokens (p95 549), of which about 80% were reasoning tokens. 19 of 119 used 508–591 tokens.
  - **Hypothesis:** the output hits the 600-token ceiling during reasoning, the JSON is cut off, and Groq rejects it.
  - Groq's structured-outputs page says strict mode "never errors or produces invalid JSON" and does not cover `max_tokens`. Neither the errors page nor the tool-use page documents `json_validate_failed` or `tool_use_failed` (read 2026-10-26). The error body and `finish_reason` were not captured, so the hypothesis is **unconfirmed**.
- **1 × `tool_use_failed`** (`edu-21/ru`). It happened on the regeneration after `FACT_NOT_LIVE`, which is sent with `tools: []` while the history contains tool calls. **Hypothesis:** the model tried to call `get_quote`, which it needed, and Groq rejected the call.

## Proposed defects (to number after DEF-005..008 on `docs/telegram-live-evidence` merge)
- **P-1 (T1):** listed facts that the display policy forbids are handed to the model, and repair is impossible in regeneration.
- **P-2 (T1):** attribute values containing digits are not citable facts.
- **P-3 (T5):** item names typed as plain text are not detected.
- **P-4 (MODEL-FORMAT):** the extraction ceiling with reasoning models, and failed-call diagnostics are not captured.
- **DEF-007 evidence:** see the timestamp check below.

## DEF-007 evidence (database time)
- `max(tenants.created_at)` in `agentcore_slice1` is epoch `1792993565` (05:46:05 UTC).
- The last ledger record (JS clock) is `1793011585` (10:46:25 UTC).
- The difference is **18 020 s ≈ 5 h**. The session `TimeZone` is `Asia/Tashkent`. The rows were written through `createPostgresAdapter` (`@prisma/adapter-pg`).
- Prisma-written columns compared with each other agree (`inbound_events.received_at` against `messages.created_at`), so the earlier same-path check could not detect the shift.
- This meets the DEF-007 condition: `extract(epoch …)` differs from the true instant on this path. Raw-SQL comparisons against `now()` would be off by 5 h. Not fixed; owner decision.
