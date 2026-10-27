# Slice 1b plan: offer details as citable facts (+ DEF-001)

**Status:** plan only, for owner review (2026-10-27). No code. It amends the roadmap's slice 1b (which was DEF-001 only) and needs an ADR (029) when approved, because it adds fact kinds and changes a guardrail rule (an amendment to ADR 013). Thresholds stay frozen.

Measurement baseline ("before"): Groq lane k=1 on `9a653e7`, scenario hash `38f47101a367`. See [breakdown](../evidence/slice1c-groq-baseline-breakdown.md) and [assessment](../evidence/slice1c-groq-baseline-assessment.md) on `docs/session-handoff-2026-10-26`.

## 1. Evidence: what the 50 `UNSOURCED_NUMBER` runs could have typed
**The flagged tokens themselves are not recoverable.** The turn record stores only the violation codes (`guardrail` = `violations`, `regenerated`, `timedOut`); `draft_text` holds the handover template, and handover summaries list facts, not the model's text. So the hypothesis "the model copied uncitable digits from tool results" **cannot be confirmed from stored data**.

What stored data does show: the fact stores of those 50 turns, plus the deterministic mock fixtures (no model calls), give every digit-bearing value the tool results put in front of the model.

| Class | Value shown to the model | Citable? | Accepted by the gate under the mock (live-capable) policy | Runs where present (of 50) |
|---|---|---|---|---|
| Price | raw `price: "150.00 USD"` next to `priceFact` (listed, `live:false`) | yes, but non-live | **no** (`FACT_NOT_LIVE`) | 50 |
| Seats | raw `seatsLeft: 12` next to `seatsFact` (`live:false`) | yes, but non-live | **no** | 50 |
| Date/time (offer start) | `startsAtFact` (datetime); no raw value | yes | yes | 50 |
| Schedule time | offer attribute `schedule: "Mon/Wed 18:00-20:00"` | **no fact** | n/a, so any typed digit is blocked | 44 |
| Level | item attribute `level: "B1-B2"` | **no fact** | n/a | 44 |
| Date (attribute) | tour `departureDate` | **no fact** | n/a | 6 |
| Nights, hotel stars | tour attributes `nights`, `hotelStars` | **no fact** | n/a | 6 |
| Live price | `confirmedPriceFact` from `get_quote` | yes, live | yes | 8 |

Every one of the 50 turns had at least four digit-bearing values the model could not legally use. Other sources remain possible and unmeasured: numbered lists ("1.", "2."), arithmetic (totals for N people), and reformatted customer numbers.

**Prerequisite (from fix 3):** store the blocked first draft redacted, with each flagged token and its class, so the "after" run can measure this directly.

## 2. Design

### 2.1 New fact kinds (generic, in `core/agent/facts.ts`; nothing vertical-specific)
| Kind | Value | Rendering (by code, per locale) |
|---|---|---|
| `date` | `{ isoDate: 'YYYY-MM-DD' }` (date only) | locale date, no time, no time-zone shift |
| `weeklySchedule` | `{ slots: [{ weekday: 'MON'…'SUN', start: 'HH:mm', end?: 'HH:mm' }], timeZone }` | localized weekday names and 24-hour times, e.g. "Du/Chor 18:00–20:00" (uz-Latn), "Пн/Ср 18:00–20:00" (ru) |
| `quantity` | `{ amount: number, unit: 'hour' \| 'day' \| 'week' \| 'month' \| 'night' \| 'lesson' \| 'person' \| 'star' }` | localized number plus unit with plural forms |
| `attributeText` | `{ name, text }` (≤ 120 characters, verbatim connector text, e.g. "B1-B2") | verbatim, like titles; CRM text stays untrusted data (rule 8) and is never interpreted |
| `price` (extended) | adds `currencySource: 'connector' \| 'owner_config' \| 'none'` | `none`: the amount plus a locale "currency not stated" template; never a guessed currency |

The existing `datetime`, `seats`, `availability` and `title` kinds stay as they are.

### 2.2 Provenance
`FactProvenance` gains:
- **`sourceEndpoint`**: the connector operation, e.g. `listOffers`, `GET /api/groups`. Set by connector code, never by the model.
- **`fieldPath`**: e.g. `offer.attributes.schedule`.

`retrievedAt` is the fetch time ("fetchedAt"). Owner-config values (currency) get `tool: 'owner_config'` and `sourceEndpoint: 'tenantConnector.config.currency'`. The existing evidence binding (tenant, conversation, offer, `live`) is unchanged.

### 2.3 Tool results shown to the model
- Each digit-bearing field becomes a fact reference. Raw values are **removed** from the model-visible JSON: no raw `price` string, no raw `seatsLeft`, and attributes are replaced by `{ name, fact: "F7" }`.
- Attributes are mapped by a per-connector field map, which belongs to the connector and its config, not to core:
  - known shapes go to typed kinds (schedule to `weeklySchedule`, durations to `quantity`, dates to `date`);
  - anything else goes to `attributeText`, or is dropped when it is not on the connector's display allow-list.
- **Still subject to the display gate:** listed price, availability and seats are **still** refused when the connector can check live (ADR 013 unchanged). The fix for those is the live re-check (fix 1, and `c78d689`/`e7daf96` on `fix/agent-code-fixes`), not this slice.

### 2.4 Guardrail: numbers the model types
The rule "the model writes no digits of its own" stays the default. One narrow, deterministic addition, **auto-link**: a digit token in the model's own text is replaced by a fact reference when all of these hold:
1. **Exact match.** After normalization (grouping separators, decimal comma or point, `H:mm`/`HH:mm`, the locale date formats `dd.MM.yyyy`, ISO, and `d MMMM` with localized month names), the token equals a token of the **rendered** value of exactly one fact in this turn's store.
2. **The fact itself passes the display gate:** bound to this tenant and conversation, fresh, and live where the policy requires it.
3. **The kind is allowed:** `date`, `datetime`, `weeklySchedule`, `quantity`, `attributeText`, and `price` only when the gate accepts that price.

The shown text is then code-rendered from the fact, and the fact ID is added to `shownFactIds` (this also helps follow-up recording and grading).

**Stays blocked (unchanged):**
- digits matching no fact;
- digits matching a fact the gate refuses (a non-live price, seats or availability under a live-capable connector);
- matches against more than one fact;
- arithmetic results (totals, discounts, "3 × 150"), unless a connector total is itself a fact;
- currency names typed by the model (`UNSOURCED_CURRENCY`);
- availability phrases (`UNSOURCED_AVAILABILITY`);
- digits from another tenant's or conversation's facts.

**Owner decision:** numbered-list markers (`^\s*[1-9][.)]` up to `maxOptionsShown`). Recommended: allow them as list markers only.

### 2.5 DEF-001 (a live-quote price is not recorded for follow-up)
New finding (code reading, 2026-10-27):
- The simulation harness builds `TelegramProcessor` with `handovers`, `shownOffers`, `leads` and `leadSync` all `undefined` (`world.ts`, `new TelegramProcessor(…, undefined ×4, actions)`).
- Production injects them (`TelegramModule` imports `LeadsModule`, which provides `ShownOffersService`), and `afterDelivery` calls `shownOffers.recordDelivered`.

So DEF-001 may be **partly a harness wiring gap**, not only a v1 defect. A second suspected cause: `recordDelivered` looks up the offer by `sourceEntityId = provenance.offerId`, but `offerId` is the canonical ID (`mock-education:<entity>`). The lookup would then miss, and no `Quote` row (which has a foreign key) would be written, although the `ShownOffer` row would.

Plan:
1. A characterisation integration test with **production wiring** (the real providers): a `list_offers` then `get_quote` answer is delivered. Assert which `ShownOffer` and `Quote` rows exist, and whether a follow-up becomes eligible.
2. Fix the harness wiring (pass the real `ShownOffersService`, `LeadService` and `LeadSyncService`; the handover notifier stays a stub). **This changes the harness commit, so it belongs to the "after" commit, and the "before" ledger is never mixed with it.**
3. If the offer-lookup mismatch is confirmed: look offers up by canonical ID, or by the source ID parsed from it, then add a regression test.
4. Flip the existing characterisation test ("records that v1 sends no follow-up after a quoted price") to expect a follow-up, and make the scenario `edu-30` reachable.

### 2.6 Fit with the EduFlow mapping (connector plan decisions 1–6)
| Learnix field | Fact |
|---|---|
| `group.startDate` | `date` (or `datetime` if a time is present), rendered in Asia/Tashkent |
| `group.schedules[]` (`weekDay`, `startTime`, `endTime`) | one `weeklySchedule` fact, timeZone Asia/Tashkent |
| `course.price` + owner-config currency | `price` with `currencySource: 'owner_config'` and `live: false`; EduFlow `liveQuote: false`, so the gate accepts it; no currency configured means `currencySource: 'none'` |
| `course.durationMonth`, `durationHours` | `quantity` (month, hour) |
| `group.maxStudent` | **no fact** (decision 4: no seats claims) |
| language, level, trial slots | none exist; no facts (decision 4) |
| IDs | strings at the mapping boundary (decision 2); provenance `sourceEntityId` is the string ID |

## 3. Acceptance criteria
1. Safety unchanged:
   - invented facts and false success claims stay at 0 in the scripted eval, the lifecycle suite and the simulation suite;
   - the display gate still refuses non-live price, seats and availability under a live-capable connector;
   - no cross-tenant fact is ever used.
2. No raw digit-bearing connector value reaches the model-visible tool JSON without a fact ID, verified for the mock, GenericRest and EduFlow fixtures.
3. Auto-link accepts exactly the cases in 2.4 and nothing else, with a test per accepted and blocked class.
4. New kinds render correctly in uz-Latn, uz-Cyrl, ru and en: snapshot tests for dates, times, weekdays, plural units and "currency not stated".
5. DEF-001: with production wiring, a delivered live-quote answer records a `ShownOffer`, plus a `Quote` when the offer is synced, and the conversation becomes follow-up-eligible. The characterisation test is flipped.
6. EduFlow fixture mapping produces the 2.6 facts, and no seats, language or trial facts.
7. Measured afterwards (no threshold change; measurement only): `UNSOURCED_NUMBER` counted per class from the stored blocked drafts, and fewer GUARDRAIL handovers than the "before" baseline on the same lane and scenario hash.

## 4. Test list
- **Unit, facts:**
  - kind validation (`date`, `weeklySchedule`, `quantity`, `attributeText`, price `currencySource`);
  - rendering per locale (including uz-Cyrl weekday names and month names);
  - `attributeText` length cap and control-character stripping.
- **Unit, tool output:** raw values removed; every digit-bearing field has a fact; the per-connector field map (schedule string or structured slots to `weeklySchedule`).
- **Unit, guardrail auto-link:**
  - accepted: exact time, date in three formats, an integer with grouping, a quantity, a gate-accepted price;
  - blocked: no match, an ambiguous match, a non-live price, seats or availability under a live policy, arithmetic, a currency word, another conversation's fact, a fact used after it expired;
  - numbered-list markers per the owner decision.
- **Display gate regression:** all existing ADR 013 cases unchanged.
- **Integration:**
  - the DEF-001 production-wiring test;
  - the harness wiring test (the shown offer is recorded in the simulation);
  - the `edu-30` follow-up scenario.
- **Connector fixtures:** EduFlow recorded fixtures map to the 2.6 facts with string IDs; with and without owner-config currency.
- **Eval:** the scripted eval and lifecycle suites with no regressions; existing case expectations unchanged except where the old output depended on removed raw values (each listed in the PR).

## 5. Measurement schedule (owner, 2026-10-27; nothing starts without the owner's word)
1. After `fix/agent-code-fixes` is merged to main (by session 2): **core-30 only**. Same lane and scenario hash, k=1, new commit, new ledger.
2. After slice 1b is merged: the **full suite**, under the same rules.
3. Ledgers are never mixed across commits; the harness refuses a file with another commit or scenario hash. The `9a653e7` ledger stays the "before".
