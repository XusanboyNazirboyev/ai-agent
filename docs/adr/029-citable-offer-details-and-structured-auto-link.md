# ADR 029: Citable offer details, blocked-draft diagnostics and structured auto-link

- **Status:** **Accepted** by the owner on 2026-10-27, with additions 9 and 10 below. Decision 1 (1b-i) is implemented on the measurement-only branch `measure/step1-1b-i` (not merged). Decisions 2–10 (1b-ii, 1b-iii) are **not implemented**. It amends [ADR 013](013-stage-c-safety-gates.md) (pre-live safety gates) for the guardrail's number rule only; the display gate is unchanged.
- **Date:** 2026-10-27
- **Inputs:**
  - the "before" baseline, Groq lane k=1 on `9a653e7`, scenario hash `38f47101a367`: [breakdown](../evidence/slice1c-groq-baseline-breakdown.md) and [assessment](../evidence/slice1c-groq-baseline-assessment.md) on `docs/session-handoff-2026-10-26`;
  - the [slice 1b plan](../design/slice1b-offer-facts-plan.md).

## Context
- 53 of the 71 agent failures in the "before" baseline were display-gate GUARDRAIL handovers (`FACT_NOT_LIVE`). In 50 of them the number check also fired (`UNSOURCED_NUMBER`).
- In all 50, the tool results showed the model digit-bearing values it could not legally use:
  - raw listed price and seats strings, whose facts the gate refuses under a live-capable connector;
  - schedule times, levels, dates, nights and stars passed as plain attributes with **no fact ID**.
- **Which numbers were actually typed is unknown.** Blocked drafts are not stored; the turn keeps only the violation codes. The hypothesis is consistent with the data but not confirmed.
- The guardrail rejects every digit the model writes that it did not echo from the customer or a title. Facts can only appear as `{{F<n>}}`, so a value with no fact can never be stated correctly.

## Decisions
1. **Blocked-draft diagnostics (slice 1b-i, before any "after" measurement).**
   - When the guardrail blocks a draft, the turn stores a **diagnostic record**: the draft passed through the existing PII and secret redaction, plus, for each flagged token, its class, whether it matched a fact in this turn's store, and whether it appeared in this turn's tool results or customer text.
   - Classes: `price`, `time`, `date`, `seats_or_quantity`, `list_marker`, `phone_like`, `other`.
   - A `phone_like` token is stored as its class only, never its digits.
   - **Retention is bounded:** the record is purged after a fixed period (setting, default 14 days), following the existing inbox-event purge pattern.
   - It is internal only: never shown to customers, never sent to operators, never returned by the web API.
   - **This changes no reply text and no outcome.** That is a test.
2. **New generic fact kinds (slice 1b-ii)**, in `core/agent/facts.ts`, with nothing vertical-specific (rule 1):
   - `date` (date only);
   - `weeklySchedule` (weekday, start, optional end, time zone);
   - `quantity` (amount plus a unit from a closed list: hour, day, week, month, night, lesson, person, star);
   - `attributeText` (verbatim connector text, ≤ 120 characters; CRM text stays untrusted data and is never interpreted);
   - price gains `currencySource`: `connector`, `owner_config` or `none`.

   A price whose currency source is `none` renders with a locale "currency not stated" template. **A currency is never guessed.**
3. **Provenance (1b-ii).**
   - Every fact records `sourceEndpoint` (the connector operation) and `fieldPath`, and `retrievedAt` is the fetch time.
   - Values from owner configuration (currency) carry `tool: 'owner_config'`.
   - The evidence binding (tenant, conversation, offer, live) is unchanged.
4. **No raw digit-bearing values in model-visible tool results (1b-ii).**
   - Each such field is a fact reference. Raw price strings, raw seat counts and digit-bearing attribute values are removed.
   - Connectors map attributes to typed kinds through their own field map; anything unmapped becomes `attributeText`, or is dropped when not on the connector's display allow-list.
5. **The display gate is unchanged (ADR 013).** Listed price, availability and seats stay refused when the connector can check live. Live re-checks are separate work (fix 1; `fix/agent-code-fixes`).
6. **Structured auto-link (slice 1b-iii).** The rule "the model writes no digits of its own" stays. A typed token is replaced by a code-rendered fact reference **only for structured forms**:
   - a **date** in a supported locale format (`dd.MM.yyyy`, ISO `yyyy-MM-dd`, `d MMMM` with localized month names);
   - a **time** or **time range** (`H:mm`, `HH:mm`, `HH:mm–HH:mm`);
   - a **price with its currency**, as the fact renders it in this locale;
   - a **number followed by a locale unit word** that matches the fact's unit (e.g. "7 nights", "7 ночей", "7 kecha").

   Each form links only when, after normalization, it equals the rendered value of **exactly one** fact in this turn's store, and that fact passes the display gate. The linked fact ID is added to `shownFactIds`.
7. **Bare integers stay blocked.**
   - A bare number ("5", "5 people") is never auto-linked, even when it equals exactly one fact.
   - Equal digits can carry a different meaning: "5 people" would match `nights = 5`.
   - **Limitation:** for structured forms, the unit word, currency or time format is the only guard against meaning drift. A number can match a fact of the right shape and still be put in a wrong sentence (for example the right date presented as the wrong group's start). Auto-link checks form and value, not sentence meaning. Fact references are still the preferred path, and the prompt keeps asking for them.
8. **Numbered-list markers are allowed.** Only at line start, only the pattern `^\d+[.)]\s`. Such a marker is not treated as an unsourced number. Any other digit on the line follows the rules above.
9. **Price-format normalization tests (owner addition, 2026-10-27).** Before a typed price is compared with a fact's rendering, thousands separators normalize to the same value, whether written with:
   - a plain space ("1 500 000 so'm");
   - a no-break space (U+00A0);
   - a narrow no-break space (U+202F), which ICU emits for some locales;
   - a thin space (U+2009);
   - no separator at all.

   Tests cover each separator in uz-Latn, uz-Cyrl, ru and en renderings, with and without a decimal part. A grouping that does not match the locale's rendering of the same fact (for example "15 00 000") does not link.
10. **An eval scenario for the "right value, wrong sentence" limitation (owner addition, 2026-10-27).** One scenario has two offers, each with its own start date. A correct reply states each date with its own group.
    - The deterministic grader checks that the reply pairs each linked date fact with the offer it belongs to, which needs the auto-link record of fact IDs and their position in the reply.
    - A draft that attaches group A's date to group B is scored as a meaning error, even though every number links to a real fact.
    - The scenario measures how often the limitation in decision 7 occurs. It is reported, not gated, until the judge is calibrated (ADR 026).

## Consequences
- The "after" baseline can measure exactly which numbers are blocked and why (decision 1). That needs a schema change (diagnostics storage) and a purge job.
- Tool-result shapes change for every connector (decision 4). Scripted eval expectations that depended on raw values are listed and updated in the 1b-ii PR, never silently.
- Locale packs gain weekday names, month names, unit words with plural forms, and the "currency not stated" template for uz-Latn, uz-Cyrl, ru and en. All stay `beta` until native review.
- The EduFlow connector (plan on `docs/eduflow-connector-plan`) maps:
  - `startDate` to `date`;
  - `schedules` to `weeklySchedule`, in Asia/Tashkent;
  - durations to `quantity`;
  - the course price to `price` with owner-config currency.

  It produces no seats, language or trial facts.

## Not decided here
- The retention default (14 days is proposed).
- Whether diagnostics are kept for regenerated drafts that later passed (proposed: yes, same retention).
- KMS-level protection of diagnostics (not needed: redacted, internal and bounded).

## Rollback
Each slice is a revert:
- 1b-i drops the diagnostics columns with a new additive-down migration, which needs approval;
- 1b-ii restores the previous tool-result shape;
- 1b-iii removes auto-link, and the guardrail is back to the ADR 013 rule.
