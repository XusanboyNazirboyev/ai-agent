# Slice 1c Groq baseline: failure breakdown (2026-10-26, partial)

**Measurement only, not a gate. INCOMPLETE:** 112 of 130 units attempted, and 18 tourism units not run. The retry loop was stopped at 13:23 UTC after 3 attempts that each stopped on Groq's per-day quota.
- **Lane:** Groq, `openai/gpt-oss-20b` (fast) / `openai/gpt-oss-120b` (strong).
- **Identity:** agent commit `9a653e7`, scenario hash `38f47101a367`, k=1, scripted customer, synthetic scenarios only.
- **Sources:** the ledger (newest record per unit counts) joined with the run traces in `agentcore_slice1`. The raw reports stay gitignored.
- **Root-cause analysis:** [slice1c-groq-baseline-assessment.md](slice1c-groq-baseline-assessment.md).

## Totals (newest record per unit)
- **Attempted:** 112 of 130.
- **Completed:** 111.
  - AGENT 101: 30 passed, 71 failed.
  - MODEL-FORMAT 10, all failed: 9 `json_validate_failed`, 1 `tool_use_failed`.
- **INFRA:** 1 (`tour-01/en`, per-day quota). Left out of the pass rate.
- **Not run:** 18, all tourism.
- **Pass rate:** 30/111 = 27.0% of completed runs.
  - Scenarios that expect a handover: 22/23.
  - All other scenarios: **8/88**.

## AGENT failure codes (71)
| Code | Runs |
|---|---|
| GUARDRAIL handover: display gate `FACT_NOT_LIVE` (a listed price, availability or seats fact cited without a live check) | **53** |
| Answered, but no item cited as a fact, so nothing counts as shown | 6 |
| Wrong or early handover: NEGOTIATION | 4 |
| Ended on NO_RESULTS (no alternative offered) | 3 |
| Wrong or early handover: STUCK | 2 |
| Wrong or early handover: COMPLAINT | 1 |
| Ended on CLARIFICATION_REQUIRED (language gate on code-switching) | 1 |
| Ended on ASKED_SLOT (the scripted customer had no answer) | 1 |

Within the 53 GUARDRAIL failures, the other violations seen were `UNSOURCED_NUMBER` 50, `UNSOURCED_AVAILABILITY` 9, `UNSOURCED_CURRENCY` 6 and `FORBIDDEN_CLAIM` 1.

## By vertical
| Vertical | Attempted | Completed | Passed | Failed (of which model-format) | INFRA | Pass rate |
|---|---|---|---|---|---|---|
| Education | 100 | 100 | 29 | 71 (8) | 0 | 29.0% |
| Tourism | 12 | 11 | 1 | 10 (2) | 1 | 9.1% (18 not run) |

## By language
| Language | Attempted | Completed | Passed | Failed (of which model-format) | INFRA | Not run | Pass rate |
|---|---|---|---|---|---|---|---|
| en | 35 | 34 | 8 | 26 (3) | 1 | 5 | 23.5% |
| ru | 34 | 34 | 10 | 24 (1) | 0 | 6 | 29.4% |
| **uz-Cyrl** | 10 | 10 | 4 | 6 (1) | 0 | 0 | **40.0%** |
| uz-Latn | 33 | 33 | 8 | 25 (5) | 0 | 7 | 24.2% |

**uz-Cyrl:** only education scenarios use it, and all 10 ran.
- 1 model-format failure: `edu-19`.
- 5 agent failures:
  - 4 are the same display-gate GUARDRAIL cause as the other languages: `edu-01`, `edu-03`, `edu-07`, `edu-30`.
  - 1 is "that's expensive" handed over as COMPLAINT: `edu-13`.

Across all completed runs, language and script matched 127 of 131 times; no failure here is caused by the uz-Cyrl script.

## Reading
The largest single cause (53 of 71 agent failures) is the mismatch between the facts `list_offers` provides and the display gate (assessment, fixes 1–2). Language or script is not a leading cause. Small samples (uz-Cyrl n=10, tourism n=11) do not support per-language or per-vertical conclusions.
