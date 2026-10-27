# Slice 1b plan: offer details as citable facts (+ DEF-001)

**Status:** plan only (2026-10-27). No code. Owner decisions of 2026-10-27 are in section 0. The decisions are recorded in [ADR 029](../adr/029-citable-offer-details-and-structured-auto-link.md), written before code, and the roadmap is amended (slice 1b split into 1b-i, 1b-ii and 1b-iii). Thresholds stay frozen. **Implementation waits for the owner's approval of ADR 029 and the 1b-i plan (section 6).**

## 0. Owner decisions (2026-10-27)
1. Fix 3 (store the redacted blocked draft, each flagged number and its class, with bounded retention) is approved and goes into **1b-i, before any "after" run**.
2. Numbered-list markers are allowed, only as the line-start pattern `^\d+[.)]\s`. ADR 029 is approved, to be written before code. The roadmap amendment is approved with the baseline evidence; thresholds are untouched.
3. **Split:**
   - **1b-i:** observability, harness production wiring and DEF-001;
   - **1b-ii:** fact kinds, raw digits removed from tool results, currency source;
   - **1b-iii:** narrow auto-link.
4. **Auto-link covers structured forms only:** date, time or time range, price with currency, and number with a locale unit word. **Bare integers stay blocked** ("5 people" must not link to `nights = 5`). There is a test for exactly that case, and the limitation is written in ADR 029.
5. **Measurement ladder**, one variable at a time, same lane and scenario hash, each commit its own ledger:
   1. the harness production-wiring change on the baseline agent, core-30;
   2. plus `fix/agent-code-fixes`, core-30;
   3. after slice 1b, the full suite.

   The `9a653e7` ledger stays the "before". No run starts until the owner says so.

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

### 2.4 Guardrail: numbers the model types (1b-iii; **narrowed by owner decision 4 and ADR 029**)
**Superseding note:** auto-link applies **only to structured forms**:
- a date in a supported format;
- a time or time range;
- a price with its currency;
- a number with a locale unit word matching the fact's unit.

Bare integers are never linked, and the line-start marker `^\d+[.)]\s` is allowed. The text below is the original proposal; where it is broader (for example "an integer with grouping" or "a quantity" without a unit word), ADR 029 decisions 6–8 win.

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

Auto-link tests (1b-iii, per ADR 029):
- **links:** "02.11.2026" or "2 noyabr" against a `date` fact; "18:00–20:00" against a `weeklySchedule` slot; "150 USD" as the locale renders it, when the gate accepts the price; "7 nights" / "7 ночей" / "7 kecha" against `quantity{7, night}`;
- **stays blocked:** a bare "7"; **"5 people" when the only matching fact is `nights = 5` (the owner's case)**; a unit word that differs from the fact's unit; a price without a currency; a time matching two facts;
- **list markers:** "1. …" at line start is allowed; "1." in the middle of a line or "1)" without a following space is blocked.

## 5. Measurement ladder (owner, 2026-10-27; nothing starts without the owner's word)
Same lane (Groq `gpt-oss-20b` / `gpt-oss-120b`), same scenario hash `38f47101a367`, k=1, scripted customer, each commit with its own ledger:

| Step | Commit contains | Run | Variable measured |
|---|---|---|---|
| before | `9a653e7` | partial full suite (done) | — |
| 1 | baseline agent + **1b-i harness production wiring** + 1b-i diagnostics (records only, no reply change) | core-30 | harness wiring (shown offers, leads); diagnostics give the first real classified token counts |
| 2 | step 1 + `fix/agent-code-fixes` (guardrail retry keeps tools; verified-quote fallback) | core-30 | the live-quote retry and fallback |
| 3 | after slice 1b (1b-ii, 1b-iii) | full suite | citable offer details and auto-link |

Ledgers are never mixed: the harness refuses a file with another commit or scenario hash, and each step's commit is recorded with its report. If DEF-001's product fix (6.3) is needed, it is its own variable (section 6.4).

## 6. Slice 1b-i plan (observability + harness production wiring + DEF-001) — for approval
### 6.1 Blocked-draft diagnostics (ADR 029 decision 1)
- **Where:** `core/agent/agent-turn.ts`, at the two guardrail checks (first draft and regeneration). `checkDraft` returns the flagged tokens; it computes them already and returns only the codes.
- **Record:** `{ draftRedacted, tokens: [{ token | null, class, matchedFactId | null, matchedFactKind | null, inToolResult, inCustomerText }], stage: 'first' | 'regeneration' }`.
  - `draftRedacted` comes from the existing `redactPii`.
  - `token` is null for `phone_like`.
  - `inToolResult` is computed against this turn's tool outputs, including raw attribute values (which still exist before 1b-ii).
- **Storage:** a new nullable `agent_turns.diagnostics` jsonb column plus `diagnostics_expires_at` (additive migration). It is not added to the `guardrail` column, so the purge can null it without touching audit-relevant data.
- **Purge:** a periodic job like the inbox-event purge, setting both fields to null when expired. The setting `AGENT_DIAGNOSTICS_RETENTION_DAYS` defaults to 14 (proposed).
- **Exposure:** the web API and operator views never select it. A unit test checks the serializers.
- **No behavior change:** a test runs the scripted eval and lifecycle suites with diagnostics on and off and compares reply text, outcomes and handover reasons, which must be identical.
- **Harness:** the ledger also gets a per-run summary (counts per class, from the turns' diagnostics) so reports can show it without the raw drafts. This is a harness change, so a new ledger identity.

### 6.2 Harness production wiring
- `agent/testing/simulation/world.ts` builds `TelegramProcessor` with the real `ShownOffersService`, `LeadService` and `LeadSyncService` (leads go to the mock connector, as in production). The `HandoverNotificationService` stays a stub that records calls, because no Telegram exists in simulation.
- A test checks that the world wires the same providers as `TelegramModule` (a list compared against the module's providers), so the harness cannot drift from production again.
- **Effect on measurement:** follow-up and lead-score dependent scenarios (`edu-30`, follow-up category) can now behave as in production. That is the variable of ladder step 1.

### 6.3 DEF-001 diagnosis (product code only if confirmed)
1. A characterisation integration test **with production wiring**: `list_offers` then `get_quote`, delivered. Assert the `ShownOffer` row, the `Quote` row (when the offer is synced) and follow-up eligibility.
2. If the `ShownOffer` row exists and follow-up is eligible: DEF-001 was a harness artifact. Update `DEFECTS.md` and flip the simulation characterisation test. **No product change.**
3. If the `Quote` row is missing because of the suspected canonical-ID versus `sourceEntityId` lookup: a narrow product fix (look up by the canonical ID, or by the source ID parsed from it), a regression test, and `DEFECTS.md` updated.

### 6.4 Ordering and the one-variable rule
- Commit A: 6.1 diagnostics (no reply change, proven by test).
- Commit B: 6.2 harness wiring.
- Ladder step 1 runs on B.
- Commit C: 6.3, product fix only if 6.3.3 applies. **Owner decision:** measure C as its own core-30 step (1a) before step 2, or accept it alongside step 2. Recommended: its own step, since it changes only follow-up behavior and a step costs about 30 runs.

### 6.5 1b-i acceptance criteria
- Diagnostics are stored for every blocked draft with classes. No PII digits are stored (`phone_like` keeps the class only). Retention is enforced by a test with a fixed clock. Nothing is exposed through the web API.
- Diagnostics on and off: identical reply text, outcomes and handover reasons on the scripted eval and lifecycle suites.
- The harness provider list equals the production providers for the processor, checked by test.
- DEF-001 is resolved either way per 6.3, with tests.
- Lint, typecheck, unit, integration, eval, build and e2e pass in CI, plus fresh-database migration and drift checks.

### 6.6 1b-i test list
- **Unit:**
  - token classification (price with currency adjacent, `H:mm`, dates, quantities, list markers, phone-like);
  - redaction of the draft;
  - `phone_like` stores no digits;
  - the diagnostics record shape;
  - the serializer excludes diagnostics.
- **Integration:**
  - the record is written on block, and on regeneration block;
  - the purge nulls expired records (fixed clock);
  - diagnostics on and off parity;
  - the world's providers equal the production ones;
  - DEF-001 characterisation with production wiring;
  - the `edu-30` simulation follow-up (scripted model).
- **Harness:** the ledger summary per class; the old ledger is refused for the new commit (identity test).
