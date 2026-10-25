# Slice 1 baseline reports (tracked summary)

Generated 2026-10-25 from the JSON reports `eval/reports/sim-*.json` (gitignored) so this evidence does not depend on an ignored directory.
Synthetic data only. No transcripts, keys or tenant identifiers are copied. Agent model for all runs: Groq `openai/gpt-oss-20b` (FAST) and `openai/gpt-oss-120b` (STRONG) where noted. This is **not** the production model (Claude Haiku). Customer: scripted. k = 1.

Column legend: goal = expected outcome reached in database state; handover = expected handover reason (or none) correct; lang = replies in the expected language/script / replies checked; inv = invented numbers; claims = false success claims; turns = customer turns; tokens = agent input/output tokens.

## Throttled sample (INVALID: client throttle longer than the turn timeout; every turn timed out)

Source `sim-2026-10-25T07-42-27-674Z.json`, generated 2026-10-25T07:42:27.674Z, agent `groq openai/gpt-oss-20b`.

Runs 5 (completed 5, errors 0, not runnable 0); units passed in every run 0/5.
Goal 0.0%; correct handover 0.0%; language 100.0%; one question 100.0%; slot correction n/a; invented facts 0; false claims 0; cross-tenant 0; p95 turn 60037 ms.

| Scenario | Lang | Status | Pass | Goal | Handover | Lang | Inv | Claims | Turns | Tokens | Ended by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edu-01 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 1164/242 | state_WAITING_OPERATOR |
| edu-02 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-03 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-04 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-05 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |

## Single-unit check without throttle (Groq strict-JSON 400 on the first call)

Source `sim-2026-10-25T07-43-08-057Z.json`, generated 2026-10-25T07:43:08.057Z, agent `groq openai/gpt-oss-20b`.

Runs 1 (completed 1, errors 0, not runnable 0); units passed in every run 0/1.
Goal 0.0%; correct handover 0.0%; language 100.0%; one question 100.0%; slot correction n/a; invented facts 0; false claims 0; cross-tenant 0; p95 turn 1460 ms.

| Scenario | Lang | Status | Pass | Goal | Handover | Lang | Inv | Claims | Turns | Tokens | Ended by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edu-01 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |

## Dev-loop baseline, education + tourism, en (40 units)

Source `sim-2026-10-25T08-00-10-603Z.json`, generated 2026-10-25T08:00:10.603Z, agent `groq openai/gpt-oss-20b / openai/gpt-oss-120b`.

Runs 40 (completed 40, errors 0, not runnable 0); units passed in every run 5/40.
Goal 12.5%; correct handover 26.7%; language 100.0%; one question 97.9%; slot correction 50.0%; invented facts 0; false claims 0; cross-tenant 0; p95 turn 32407 ms.

| Scenario | Lang | Status | Pass | Goal | Handover | Lang | Inv | Claims | Turns | Tokens | Ended by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edu-01 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 4996/1464 | state_WAITING_OPERATOR |
| edu-02 | en | completed | no | no | yes | 2/2 | 0 | 0 | 2 | 3127/989 | script_done |
| edu-03 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 3807/1084 | state_WAITING_OPERATOR |
| edu-04 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 4709/1234 | state_WAITING_OPERATOR |
| edu-05 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 2537/775 | state_WAITING_OPERATOR |
| edu-06 | en | completed | yes | yes | - | 1/1 | 0 | 0 | 1 | 2546/750 | script_done |
| edu-07 | en | completed | no | no | - | 2/2 | 0 | 0 | 2 | 3905/870 | script_done |
| edu-08 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 3876/1329 | state_WAITING_OPERATOR |
| edu-09 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 3825/1295 | state_WAITING_OPERATOR |
| edu-10 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 4686/1335 | state_WAITING_OPERATOR |
| edu-11 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 1158/409 | script_done |
| edu-12 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 3894/1872 | state_WAITING_OPERATOR |
| edu-13 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 4973/1121 | state_WAITING_OPERATOR |
| edu-14 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 4673/1245 | state_WAITING_OPERATOR |
| edu-15 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 3835/1896 | state_WAITING_OPERATOR |
| edu-16 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-17 | en | completed | yes | yes | yes | 1/1 | 0 | 0 | 1 | 1160/257 | state_WAITING_OPERATOR |
| edu-18 | en | completed | yes | yes | yes | 1/1 | 0 | 0 | 1 | 1160/495 | state_WAITING_OPERATOR |
| edu-19 | en | completed | yes | yes | - | 4/4 | 0 | 0 | 3 | 2356/1025 | script_done |
| edu-20 | en | completed | no | no | - | 3/3 | 0 | 0 | 3 | 2352/684 | state_WAITING_OPERATOR |
| edu-21 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-22 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-23 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-24 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-25 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-26 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-27 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-28 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-29 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 3826/1582 | state_WAITING_OPERATOR |
| edu-30 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 4040/873 | script_done |
| tour-01 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 3511/1281 | state_WAITING_OPERATOR |
| tour-02 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 871/443 | script_done |
| tour-03 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 4584/998 | state_WAITING_OPERATOR |
| tour-04 | en | completed | yes | yes | yes | 1/1 | 0 | 0 | 1 | 867/234 | state_WAITING_OPERATOR |
| tour-05 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 1633/517 | script_done |
| tour-06 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 2624/757 | state_WAITING_OPERATOR |
| tour-07 | en | completed | no | no | no | 1/1 | 0 | 0 | 1 | 3550/1304 | state_WAITING_OPERATOR |
| tour-08 | en | completed | no | no | - | 2/2 | 0 | 0 | 2 | 872/184 | state_WAITING_OPERATOR |
| tour-09 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 867/354 | script_done |
| tour-10 | en | completed | no | no | - | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |

## Dev-loop baseline, education + tourism, uz-Latn + ru (stopped after 6 units: free quota)

Source `sim-2026-10-25T11-19-31-371Z.json`, generated 2026-10-25T11:19:31.371Z, agent `groq openai/gpt-oss-20b / openai/gpt-oss-120b`.

Runs 6 (completed 6, errors 0, not runnable 0, provider failures 4); units passed in every run 0/6.
Goal 0.0%; correct handover 0.0%; language 100.0%; one question 100.0%; slot correction n/a; invented facts 0; false claims 0; cross-tenant 0; p95 turn 38716 ms.

| Scenario | Lang | Status | Pass | Goal | Handover | Lang | Inv | Claims | Turns | Tokens | Ended by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edu-01 | uz-Latn | completed | no | no | no | 1/1 | 0 | 0 | 1 | 4014/2031 | state_WAITING_OPERATOR |
| edu-01 | ru | completed | no | no | no | 1/1 | 0 | 0 | 1 | 0/0 | state_WAITING_OPERATOR |
| edu-02 | uz-Latn | completed | no | no | no | 2/2 | 0 | 0 | 2 | 5306/2664 | state_WAITING_OPERATOR |
| edu-02 | ru | completed | no | no | no | 2/2 | 0 | 0 | 2 | 3133/1042 | state_WAITING_OPERATOR |
| edu-03 | uz-Latn | completed | no | no | no | 1/1 | 0 | 0 | 1 | 1980/414 | state_WAITING_OPERATOR |
| edu-03 | ru | completed | no | no | no | 1/1 | 0 | 0 | 1 | 4032/660 | state_WAITING_OPERATOR |

## Triage of the 40-unit English run (from the run log)

Runs with an `LLM_UNAVAILABLE` handover (provider failure): 13. Runs with a `GUARDRAIL` handover: 15. Neither: 12. Turn outcomes: 31 of 47 turns ended in a handover.
Guardrail violations: `FACT_NOT_LIVE` 14, `UNSOURCED_NUMBER` 13, `UNSOURCED_AVAILABILITY` 6, `UNSOURCED_CURRENCY` 4, `FORBIDDEN_CLAIM` 1, `EMPTY` 1. The report format of that run predates the per-run provider-failure field, so these counts were taken from the structured run log.
