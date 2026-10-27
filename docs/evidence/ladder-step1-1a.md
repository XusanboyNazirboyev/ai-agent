# Measurement ladder, steps 1 and 1a (core-30, Groq lane, k=1)

- **Date:** 2026-10-27. **Measurement only:** nothing here is merged, and no reply text or outcome was changed for the measurement.
- **Plan:** [slice 1b plan](../design/slice1b-offer-facts-plan.md), section "measurement ladder"; [ADR 029](../adr/029-citable-offer-details-and-structured-auto-link.md), decision 1 (diagnostics).
- **Data:** synthetic scenarios and the plain mock connector only.

## Provenance

| Row | Agent commit | Tag | What changed vs the row above |
|---|---|---|---|
| Before | `9a653e7` | (branch `slice1c/free-baseline`) | — |
| Step 1 | `de31ebf` | `measure/step1-de31ebf` | Harness wiring (ShownOffers, Lead, LeadSync in the simulated world) and blocked-draft diagnostics; agent code identical to `9a653e7` |
| Step 1a | `44afcf9` | `measure/step1a-44afcf9` | DEF-001 product fix: a quote is recorded for the synced offer key (`offerSourceEntityId`) |

- Same for every row:
  - lane `groq:openai/gpt-oss-20b|openai/gpt-oss-120b`;
  - k=1;
  - scenario suite hash `38f47101a367` (scenario files unchanged since `9a653e7`);
  - connector profile `mock`;
  - the same 30 `core-30` units.
- **Before row:** the core-30 units of the partial full-suite "before" baseline, newest ledger record per unit.
- **Steps 1 and 1a:** run with `SIM_UNITS=core-30-only`, sequentially, on 2026-10-27 05:42–05:56 UTC. Each step used its own worktree at the tag and its own database (`agentcore_measure_step1`, `agentcore_measure_step1a`). Neither run hit the per-day quota.

| Ledger (append-only) | sha256 |
|---|---|
| `9a653e7d4c4c-38f47101a367.jsonl` (before) | `416b11c9ffb4a4af8cd1e94dc1e5f21f65e3f00e647b6f0ee6ced77e42b8e932` |
| `de31ebf0e402-38f47101a367.jsonl` (step 1) | `97d8cadf1b9900d2fce625826267601c7b3e386ac668f2b8d1ebb2a0ab10d69d` |
| `44afcf941990-38f47101a367.jsonl` (step 1a) | `8d31f82f2e62edd7d4f918e8578b862992a3002200df1004f268e4f30777f1dd` |

The ledgers live under `eval/reports/baselines/groq_openai_gpt-oss-20b_openai_gpt-oss-120b/`, which is gitignored, in the worktrees `ai-agent-freebase`, `ai-agent-measure-step1` and `ai-agent-measure-step1a`. They are kept until the owner says otherwise.

## Results (core-30)

| Row | Passed | AGENT failed | MODEL_FORMAT | GUARDRAIL handovers | Invented facts | False success claims |
|---|---|---|---|---|---|---|
| Before `9a653e7` | 7/30 | 20 | 3 | 12 | 0 | 0 |
| Step 1 `de31ebf` | 8/30 | 18 | 4 | 12 | 0 | 0 |
| Step 1a `44afcf9` | 11/30 | 17 | 2 | 11 | 0 | 0 |

- **Before → step 1:** 1 unit newly passing (`tour-05/en`), 0 newly failing.
- **Step 1 → step 1a:** 4 newly passing (`edu-02/en`, `edu-19/uz-Cyrl`, `tour-01/uz-Latn`, `tour-08/uz-Latn`), 1 newly failing (`tour-05/en` again).

**Conclusion: within noise at k=1.**
- One unit flipped back and forth with no relevant code change, and MODEL_FORMAT failures alone moved between 2 and 4.
- So the 7 → 8 → 11 differences are not attributed to either change. Attribution needs k=3 or more runs.

## Blocked-number classes (UNSOURCED_NUMBER drafts, from the stored diagnostics)

| Class | Step 1 | Step 1a |
|---|---|---|
| time | 22 | 20 |
| seats_or_quantity | 12 | 6 |
| other | 12 | 8 |
| list_marker | 4 | 6 |
| date | 3 | 3 |
| price | 2 | 1 |
| **Flagged tokens** | **55** (14 drafts) | **44** (12 drafts) |
| Seen in a tool result the model saw | 53 | 43 |
| Matched a fact of the turn | 34 | 25 |
| From the customer's text | 0 | 0 |

- Blocked drafts in all: 26 for step 1 (14 first, 12 regeneration) and 24 for step 1a (13 first, 11 regeneration).
- **`FACT_NOT_LIVE` is still the most common violation:** 23 of 26 and 20 of 24 blocked drafts.
- Matched fact kinds: `datetime` 24 / 19, `seats` 8 / 4, `price` 2 / 2.

**Hypothesis supported:** the slice 1b hypothesis, that UNSOURCED_NUMBER comes from the model copying digit-bearing values out of tool results it cannot cite.
- Almost every flagged token, 96–98%, was a value shown in a tool result. None came from the customer.
- The largest class is schedule **times**, and only 9 of the 20–22 time tokens matched a fact. That is what ADR 029 decisions 2 and 4 (`weeklySchedule`, no raw digit-bearing values) address.
- Every seats and date token matched a fact that the display gate or the citation rule refused.
- List markers (4 and 6) would be allowed by decision 8.
- The data does **not** support "the model invents numbers".

## The 3 price tokens with no fact match and no tool-result match

All three are in the tour scenario "Antalya 7 nights" (Russian). The confirmed quote was F10 = `1200.00 USD` per person, from `get_quote`, and the synthetic customer asked for a group of 12.

| Step | Turn (draft stage) | Token | Context in the draft | Verdict |
|---|---|---|---|---|
| 1 | `01a17be6-a25c-…` (first) | `1200` | "стоимость {{F10}} (1200 USD)" | **Reformatting**: the cited quote repeated without decimals |
| 1 | `01a17be7-0ae7-…` (first) | `14400` | "всего для вашей группы 12 человек ≈ 14400 USD" | **Arithmetic**: 12 × 1200.00, a group total that is not a fact |
| 1a | `01a17bed-73d1-…` (first) | `1200` | "цена за одного {{F10}} (1200 USD)" | **Reformatting**, as above |

- **None was invented,** and all three were correctly blocked.
- **The "no match" verdict is a diagnostics false negative for the two `1200` tokens.** The matcher requires that a number not be followed by `.` and a digit, so `1200` never matches `1200.00`. In the class table above, "matched a fact" and "seen in a tool result" are therefore slightly undercounted for prices.
- **The fix belongs with ADR 029 decision 9** (price-format normalization) in 1b-iii. The tagged measurement commits are not changed.

## Not covered

- k=1 only.
- Step 2 (1b-i on current `main`) is not run. It waits until `main` is stable.
- No EduFlow profile.
- Tool outputs are not stored per turn (only inputs and outcomes), so "seen in a tool result" comes from the diagnostics record made at block time.
