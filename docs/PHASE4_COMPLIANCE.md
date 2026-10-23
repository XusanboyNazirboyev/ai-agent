# Phase 4 compliance matrix

Status as of 2026-10-24, branch `feat/agent-telegram-integration`.

Sources:
- `AGENTS.md` v3 (§7.3 guardrails, §15 Phase 4 acceptance).
- The optimization addendum (§3.2, §3.3, §3.10). The addendum file is not in this repository; its requirements are known through [ADR 002](adr/002-specification-reconciliation.md) and `PROGRESS.md`, so the item wording below follows those records.

Evidence gives the file and the test name. Unit specs run with `pnpm test:unit`; `*.integration.spec.ts` run with `pnpm test:integration` against the marked `agentcore_test` database.

Status values:
- **IMPLEMENTED**: in code, with a passing test.
- **PARTIAL**: present but incomplete.
- **MISSING**: not built.

No status depends on a live model run: no API key was available, so live quality is unmeasured (see the last section).

## Summary

| Area | Implemented | Partial | Missing |
|---|---|---|---|
| Addendum §3.2, provenance and facts | 4 | 2 | 0 |
| Addendum §3.3, tool safety | 5 | 0 | 0 |
| Addendum §3.10, language and disclosure | 4 | 1 | 0 |
| v3 §7.3, guardrails | 4 | 2 | 1 |
| v3 Phase 4 acceptance | 6 | 1 | 0 |

### P0 gaps fixed in this phase
- CRM text reached the prompt without escaping. Catalog descriptions and attributes were placed inside `<catalog_context>` unescaped, so text in them could close the delimiter. Tool results are now serialized with `<` and `>` escaped.
- There was no AI disclosure. A new `ai_question` intent answers with a truthful locale template.
- Handover templates promised a reply ("they will reply shortly"). No operator notification exists until Phase 5, so they now only say the message was recorded.
- A mixed-script message could flip an established conversation's script. Mixed Latin/Cyrillic text and all-caps acronyms no longer count as a script choice.
- The Uzbek Latin→Cyrillic transliterator dropped the hard sign after consonants: `san'at` came out as `сан'ат` instead of `санъат`.
- Failure reason codes were conflated. A CRM outage now gives CONNECTOR_UNAVAILABLE, separate from NO_DATA, and LLM, budget and tool-loop failures each have their own code.

## Addendum §3.2: provenance, rendering, outcomes

| Requirement | Status | Evidence | Note / next phase |
|---|---|---|---|
| Typed provenance facts | IMPLEMENTED | `core/agent/facts.ts` (`Fact`, `FactProvenance`: tool, connector, source system/entity, retrievedAt, validUntil). Tests: `agent-components.spec.ts` › "facts and guardrail"; `agent-turn.spec.ts` › "searches, lets the model look up a live quote, and renders facts in code" | — |
| Code-rendered values | IMPLEMENTED | `{{F<n>}}` references rendered by `FactStore.render` / `checkDraft`. Tests: `agent-components.spec.ts` › "renders referenced facts with locale formatting", "formats money exactly without rounding" | — |
| Outcome types FOUND / NOT_FOUND / STALE / UNAVAILABLE / INVALID_RESPONSE | IMPLEMENTED | `core/agent/tools.ts` (`ToolOutcomeType`, plus REJECTED for server-refused calls). Tests: `agent-policy.spec.ts` › "reports typed outcomes with redacted input", "marks expired offers STALE and issues no price fact for them"; eval categories `stale_offer`, `price_not_in_catalog`, `unavailable_offer` (`toolOutcomes`) | — |
| Stale facts never shown as current | IMPLEMENTED | Expired offers yield no facts. A quote or availability past `validUntil` gives `STALE`, and a stale reference gives `STALE_FACT`. Tests: same as above; `agent-components.spec.ts` guardrail cases | — |
| Live revalidation before display | PARTIAL | Agent tools always call the tenant connector live; the synced catalog copy is never used for replies. `get_quote` and `check_availability` are live calls, and quoted prices carry `confirmedQuote: true`. | A listed price (`confirmedQuote: false`) can still be shown; only a prompt rule asks for `get_quote`. Next: a guardrail rule requiring a confirmed quote for price facts when the connector has `liveQuote`. **Phase 5.** |
| Quote snapshot | PARTIAL | Each turn stores the facts it used, with full provenance, in `AgentTurn.facts`. Test: `telegram-agent.integration.spec.ts` › "stores the draft and the turn record but never sends" | A `Quote` row with `shownInMessageId` is not written: it needs a connector offer mapped to a synced `Offer` row (FK). **Phase 5**, with leads and bookings. |

## Addendum §3.3: tool authorization and untrusted data

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Server-side tool authorization | IMPLEMENTED | `AgentTools.available()`: the tool must be enabled by the pack and supported by the connector. IDs must come from this turn's results (`UNKNOWN_REFERENCE`). Tests: `agent-turn.spec.ts` › "never offers tools the connector does not support", "returns validation errors to the model instead of executing bad calls"; eval `invalid_tool_args`, `unsupported_capability` | — |
| Side-effect classes | IMPLEMENTED | `TOOL_SIDE_EFFECTS`: all exposed tools are READ. Write tools (lead, booking) are not offered to the model. Test: `agent-policy.spec.ts` › "declares every tool READ-only". The compute step writes only usage records, and replies are written at commit (`telegram-agent-pipeline.ts`). | — |
| Strict input/output validation | IMPLEMENTED | Strict zod inputs. Connector output is re-validated against the canonical schemas, and the `offerId` must match the request (`INVALID_OUTPUT`). Tests: `agent-turn.spec.ts` tool-control block | — |
| Loop and budget limits | IMPLEMENTED | `TurnBudget` covers calls, tool rounds and calls, input size, and turn, conversation and tenant cost. A prompt over the long-prompt threshold is refused. Tests: `llm-cost.spec.ts`; `agent-turn.spec.ts` › "stops an endless tool loop at the round limit and stays safe"; `telegram-agent.integration.spec.ts` › TOOL_LOOP_LIMIT and BUDGET_EXCEEDED handovers | — |
| Retrieved / CRM text is untrusted | IMPLEMENTED | Tool results are JSON with `<` and `>` escaped (`promptSafeJson`), customer text is sanitized, and the system prompt marks both as data. Tests: `agent-policy.spec.ts` › "escapes markup in CRM text so it cannot close prompt delimiters"; eval `catalog_injection`, `customer_injection` (`promptExcludes`) | — |

## Addendum §3.10: language, script, disclosure

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Reply in the customer's language and script; switch only when clear | IMPLEMENTED | `core/agent/language.ts` (`chooseLocale`, switch threshold 0.6; mixed script capped at 0.45). Tests: `agent-components.spec.ts` › "keeps the current locale unless the customer clearly switches"; `agent-policy.spec.ts` › "does not treat a Latin acronym or a mixed-script message as a script choice"; eval `mixed_script`, `script_consistency` | — |
| Apostrophe variants and Latin↔Cyrillic matching | IMPLEMENTED | `packages/shared/src/transliteration.ts`. Tests: `agent-components.spec.ts` › "Uzbek transliteration"; eval `apostrophe_variants` (o‘ oʻ o’ \`) | — |
| Transliteration never merges distinct items | IMPLEMENTED | Normalization is used for matching only; items and facts keep the connector ID and source entity. Test: `agent-policy.spec.ts` › "keeps items distinct when their titles transliterate to the same key" | — |
| Truthful AI disclosure | IMPLEMENTED | `ai_question` intent → `templates.aiDisclosure`. Tests: `agent-policy.spec.ts` › "answers a bot question truthfully in the conversation script"; eval `ai_disclosure` | — |
| Conservative handling of uncertain language; locale status honesty | PARTIAL | All locales are `beta` with `nativeReviewed: false`, and the registry refuses `stable` without review. | The `LOW_LANG_CONFIDENCE` handover is defined but has no trigger; it needs live-eval thresholds per locale. **Phase 7.** |

## v3 §7.3: guardrails on every reply

| # | Requirement | Status | Evidence | Note |
|---|---|---|---|---|
| 1 | Hard facts trace to tool results; block, regenerate once, then hand over | IMPLEMENTED | `checkDraft` checks unknown/stale facts and unsourced numbers or currency. On a second failure the turn hands over with GUARDRAIL. Tests: `agent-turn.spec.ts` › "blocks a draft with an invented price and regenerates once", "hands over (GUARDRAIL) when the regeneration also fails"; eval `invented_price*` | Since 4B, the second failure hands over; before, it fell back to a code-rendered list. |
| 2 | Never promise discounts, free extras, guarantees | PARTIAL | Per-locale forbidden stems, plus NEGOTIATION routing. Tests: guardrail cases; eval `handover_negotiation`, `catalog_injection` | Stem lists, not semantic detection. Native review should extend them. |
| 3 | Never invent hours, availability, policies | PARTIAL | Availability is fact-only; policies have no source, so the turn hands over (NO_DATA) or the prompt rule applies. | `knowledge_search` and RAG: **Phase 6**. |
| 4 | Regulated info only from verified knowledge | MISSING | — | Needs knowledge with `updatedAt`. **Phase 6.** |
| 5 | No account or personal data without verification | IMPLEMENTED | `account_question` → AUTH_REQUIRED. Tests: `agent-turn.spec.ts` › safety; eval `handover_auth`, `account_specific` | Relies on intent classification; no account tools exist. |
| 6 | Ignore embedded instructions; never reveal prompts or internals | IMPLEMENTED | `PROMPT_LEAK` guardrail and escaped data. Tests: `agent-turn.spec.ts` › "keeps injected instructions out of the system prompt and neutralizes tags"; eval `prompt_injection`, `catalog_injection` | — |
| 7 | Reply language/script matches the customer | IMPLEMENTED | `SCRIPT_MISMATCH` / `LANGUAGE_MISMATCH`. Tests: `agent-turn.spec.ts` › "rejects wrong-script drafts and internal markers" | — |

## v3 Phase 4 acceptance

| Criterion | Status | Evidence |
|---|---|---|
| `LlmProvider` abstraction with model tiers | IMPLEMENTED | `core/llm/llm-provider.ts`, `llm/anthropic/*` (`anthropic-llm-provider.spec.ts`) |
| Tool loop, slot engine from pack config, reply composer with placeholders | IMPLEMENTED | `core/agent/*`; `agent-turn.spec.ts` |
| Guardrail blocks planted wrong numbers | IMPLEMENTED | eval `invented_price`, `stale_offer`, `customer_injection` (dictated price) |
| Language/script detection; transliteration and normalized search | IMPLEMENTED | `agent-components.spec.ts` |
| Locale packs uz-Latn, uz-Cyrl, ru, en; first pack (education) | IMPLEMENTED (beta) | `locales/locale-packs.ts`, `packs/education/education.pack.ts` |
| Cost-bounded and safe in a real channel without blocking the database | IMPLEMENTED (4B) | `telegram-agent.integration.spec.ts` › "holds no transaction, lock or pooled connection while the model runs" and the concurrency block |
| Scripted dialogs in each launch language produce correct, fact-grounded replies in the right script | PARTIAL | 138 deterministic cases pass (`agent-eval.spec.ts`: 50 uz-Latn, 50 uz-Cyrl, 19 ru, 19 en). These test control logic with scripted model outputs; real model quality needs the live eval (`pnpm --filter @agentcore/api eval:live`), which has not been run. |

## Not verified

- No live model run: no API key was configured. Model quality, tool-call validity and latency on Claude are unmeasured; the runner and report are tested with the scripted model only.
- No native-speaker review of any locale.
- Operator notification of handovers does not exist (Phase 5). Every handover stays `notificationStatus = PENDING`, and LIVE mode is refused outside local development.
