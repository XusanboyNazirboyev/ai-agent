# ADR 022 — Generic, customer-confirmed business actions

Status: **Proposed — for owner review. Not implemented.** Date: 2026-10-24. Phase 7.0 (`docs/PHASE7_PLAN.md`).
Builds on: D1, D4, D5, D8, D9, D12, D16; ADR 013 (typed safety outcomes), ADR 014 (budget reservations), ADR 018 (handover, leads), ADR 019, ADR 020/021.

## 1. Context (verified on `phase6a/web-operator-inbox` @ `418872b`)
- The agent turn (`core/agent/agent-turn.ts`) is **compute-only**: it extracts slots, calls six **read-only** tools, and code renders facts; the pipeline (`channels/telegram/telegram-agent-pipeline.ts`) then commits reply + outbox event atomically (claim → compute → commit). Nothing in a turn writes to an external system.
- The only external write is lead creation: code creates a local `Lead` at handover, and a background job (`leads/lead-sync.service.ts`) calls `connector.createLead`, recording `SYNCED`/`FAILED`, retrying with backoff. The customer is never told about the CRM result.
- `CrmConnector` (`connectors/interfaces/crm-connector.ts`) advertises `createLead`, `updateLead`, `createBooking` via capability flags; errors are typed (`ConnectorErrorCategory`, `retryable`). **No write method takes an idempotency key**, and the generic REST connector sends none. **Existing defect:** a lead-sync retry after a timeout whose request actually reached the CRM can create a duplicate CRM lead.
- Domain packs (`packages/shared/src/domain-pack.ts`) are validated data: slots with per-locale questions, enabled tools, prompt fragments, lead scoring, high-value rule. The core holds no domain words (`core/architecture.spec.ts`).
- Agent modes: OFF / SHADOW (compute + store draft, send nothing) / LIVE (send), with LIVE refused outside development unless policies hold (`agent/agent-mode.ts`).

## 2. Problem
The product must let a tenant enable business actions (register an enquiry, request a callback, create a booking request, update a lead) that the agent proposes and the customer confirms, in any industry, without the model ever being able to perform a write on its own or claim a result the connected system did not confirm.

## 3. Goals
1. One action mechanism in the core, configured by packs and tenants; no per-industry code paths.
2. A write happens only after: tenant enablement, connector capability, connector write permission, required LIVE policy, validated input, and (when the policy requires it) an explicit confirmation bound to the exact details shown.
3. At most one external write per confirmed proposal across retries, redeliveries and crashes, **where the connector can support that**; honest handling where it cannot.
4. Every customer-facing statement about an action outcome is rendered by code from a stored, typed outcome.
5. Unclear outcomes go to a person; nothing is guessed.
6. Full audit and metrics without customer text in logs.

## 4. Non-goals (v1)
Payments, deposits, prices agreed by negotiation, discounts (D16 stays); cancellations or deletes of external records; multi-step transactions across several systems; actions started by operators (they keep their own commands); customer identity verification for account-specific writes (Open Question 10 — actions in v1 create new records or update records the conversation itself created); free-form "do anything" CRM calls.

## 5. Alternatives considered
| Alternative | Why not chosen |
|---|---|
| A. Let the model call write tools directly (like the read tools) | The model would decide when to write; confirmation, digest binding and outcome honesty would depend on prompt behaviour. Violates D4/D5 and makes duplicate writes likely under retries. |
| B. One workflow per pack (custom code in `src/packs/*`) | Each pack re-implements confirmation, idempotency, retries and outcome rules; inconsistent safety; the "zero core change" goal becomes meaningless because every pack ships its own engine. |
| C. Synchronous write inside the turn's commit transaction | An external call cannot join a database transaction; a crash between call and commit loses the outcome (or duplicates on retry); long calls hold leases. |
| D. Generalize the existing handover lead job only | It is system-initiated, has no confirmation, no customer-facing outcome and no idempotency key; useful as the execution pattern (outbox + bounded retries), not as the contract. |
| **E. Chosen: proposal → confirmation → durable execution → code-rendered outcome**, generic core state machine, pack-declared action specs, tenant enablement, connector idempotency declaration | Keeps the model to extraction and phrasing; reuses claim/commit, outbox, audit and handover; one safety implementation for every domain. |

## 6. Responsibilities
| Concern | Owner | Notes |
|---|---|---|
| Action spec: key, connector operation, fields and their sources, required/optional, validation, summary and outcome wording keys, expiry, whether an external reference may be shown | **Domain pack** (data, validated by schema in `packages/shared`) | e.g. an education pack declares "register enquiry"; a travel pack declares "request a trip proposal". Keys are pack-specific; the core never names them. |
| Which actions are enabled, per-action mode (`off`/`shadow`/`live`), stricter confirmation (never looser), which connector is used for writes, field overrides allowed by the pack | **Tenant configuration** | Defaults: every action `off`. |
| Write permission per connector instance (`allowWrites`), credentials, endpoint mapping, idempotency mode, reconciliation lookup | **Connector configuration / connector** | Credentials stay in the secret resolver; never in proposals, logs or audit. |
| Executing the operation, mapping to the remote API, idempotency (native header/field or lookup), classifying failures as *definitely not executed* vs *possibly executed*, returning evidence (external id) | **Connector** | New contract items in §8. |
| Proposal lifecycle, digest binding, confirmation decision, authorization checks, execution scheduling, retries, uncertain-outcome policy, outcome → template selection, guardrail against action claims, audit, metrics, SHADOW handling, handover triggers | **Universal core** (generic; no domain words) | New module `core/actions/**` plus a worker outside core. |
| Rendering a confirmation prompt (buttons where the channel supports them, text otherwise), receiving the confirmation callback idempotently, delivering outcome messages | **Channel adapter** | Telegram: inline keyboard on the customer chat with an opaque proposal token in `callback_data` (1–64 bytes, official Bot API constraint already used in Phase 5). |
| Generic wording: confirm/decline buttons, accepted confirmation phrases, outcome templates (succeeded / succeeded with reference / needs correction / not possible now / being checked by a person) | **Locale pack** | Pack-specific labels come from the pack. |

## 7. Domain-pack contract (shared schema, sketch)
```ts
actions?: Array<{
  key: string;                         // pack-specific, e.g. 'register_enquiry'
  operation: 'createLead' | 'updateLead' | 'createBooking'; // generic connector capability
  fields: Array<{
    name: string;                      // canonical target field (e.g. LeadInput.slots.<x>, contact.phone)
    from: { kind: 'slot'; slot: SlotKey } | { kind: 'contact'; field: 'name' | 'phone' }
        | { kind: 'shownFact'; factType: 'offer' | 'quote' } | { kind: 'constant'; value: string };
    required: boolean;
  }>;
  preconditions?: { offerShown?: boolean; quoteShown?: boolean };
  confirmation: 'explicit';            // v1: the only allowed value (owner decision D-1)
  expiresAfterMinutes: number;         // 5..1440
  summaryLabel: Record<LocaleId, string>;  // "your enquiry for {item}" etc., placeholders = field names
  showExternalReference: boolean;
}>
```
Validation at pack load: every `from.slot` exists; every operation is one the pack's connector type can advertise; required fields have a slot question or a contact source; placeholders exist. The tools list gains no write tools; the model only sees that an action "can be proposed" via a generic `propose_action(actionKey)` signal in its structured extraction output.

## 8. Connector contract additions
- Every write method receives a `WriteContext`: `{ idempotencyKey: string; tenantId; requestedAt }`. The key is stable per execution (= execution id) for all attempts.
- `capabilities.writeIdempotency: 'native' | 'lookup' | 'none'`, declared per connector instance and verified by conformance tests:
  - `native`: the remote API deduplicates by a key we send (header or field). Retrying with the same key is safe.
  - `lookup`: the connector can find a record it created by a reference we store on it (`findByReference(idempotencyKey)`). Before any retry after an unclear outcome, look up first.
  - `none`: neither. **No automatic retry after a possibly-executed failure.**
- Errors carry `executed: 'no' | 'unknown'`. `no` only when the connector can prove the request did not take effect (validation before sending, connection refused before any byte sent, explicit 4xx validation/authorization from the remote). Timeouts, connection resets after sending, 5xx without a guarantee, unparseable responses → `unknown`. Default is `unknown`.
- Success must return evidence: an external id (non-empty, ≤ 200 chars, already validated for `crmLeadId`). A 2xx without a parseable id is `INVALID_RESPONSE` with `executed: 'unknown'`.
- Connectors must not log payloads or credentials (existing rule) and must apply the pack's field list only (no extra fields).
What we **cannot** guarantee: exactly-once on systems without `native`/`lookup`; we guarantee *at most one automatic attempt after an unknown outcome* plus human resolution.

## 9. Lifecycle and state machine
**Proposal** (`action_proposals`, tenant-scoped): `PROPOSED → CONFIRMED | DECLINED | SUPERSEDED | EXPIRED`.
1. Turn computes as today. If extraction signals `propose_action(key)` (or the pack's deterministic rule, e.g. all required fields present after the customer asked to proceed), the core checks: action enabled for the tenant (mode ≠ `off`), connector instance has the capability and `allowWrites`, preconditions hold, all required fields present and valid (types, lengths, enum values, phone format via the existing extractor).
2. Missing field → ask exactly that field's slot question (existing `firstMissing` behaviour). Invalid field → ask again with the field's question; never send.
3. All valid → create a proposal with the **canonical payload** (only declared fields, normalized) and `digest = SHA-256(canonical JSON of {actionKey, payload, packRef, tenantId, conversationId})`, `expiresAt`. Any earlier `PROPOSED` proposal of the same conversation is `SUPERSEDED`. The reply is **code-rendered**: summary label + field values + "Confirm / Change" (buttons with an opaque token bound to proposal id + digest; text fallback lists the accepted phrases). The model does not write this message.
**Confirmation** (decided by code only):
4. Accepted only for the conversation's single current `PROPOSED` proposal, before `expiresAt`, via (a) the channel callback whose token matches proposal id + digest, or (b) a customer message that is, after normalization, exactly one of the locale pack's confirmation phrases (same mechanism as `/stop`). A model-classified "yes" alone never confirms. Any new or changed field value → new proposal (old one `SUPERSEDED`), so details cannot change between confirmation and execution. Decline phrases/button → `DECLINED`.
5. In the confirming turn's commit transaction: proposal `CONFIRMED`, one `action_executions` row (unique on `proposal_id`; `idempotency_key = execution id`), audit `action.confirmed`, outbox event `action.execute` (idempotency key `action.execute:<execution id>`). Redelivered webhooks or callbacks hit the unique constraints and change nothing.

**Execution** (`action_executions`): `QUEUED → RUNNING → SUCCEEDED | NEEDS_CORRECTION | FAILED | RETRY_WAIT | UNKNOWN → (RESOLVED_SUCCEEDED | RESOLVED_FAILED by an operator)`; `SIMULATED` in SHADOW.
6. The worker claims the row with a lease (pattern of the agent-turn claim), re-checks enablement, mode, capability and `allowWrites` at execution time (a tenant may have disabled the action since), loads the payload **from the proposal row** (never re-extracts), and calls the connector with the `WriteContext`.
7. Outcome mapping:
| Connector result | State | Customer message (code-rendered) | Next |
|---|---|---|---|
| Success + external id | `SUCCEEDED` | success template (+ reference if the pack allows) | done |
| `VALIDATION`, `executed: 'no'` | `NEEDS_CORRECTION` | ask for the specific field the connector names (mapped to a pack field), or generic correction prompt | new proposal after correction |
| `AUTHENTICATION`/`AUTHORIZATION`/`CONFIGURATION`/`CAPABILITY` | `FAILED` | "could not be completed right now; a colleague will follow up" | handover `ACTION_FAILED`; tenant alert |
| `RATE_LIMITED`/`UNAVAILABLE` with `executed: 'no'` | `RETRY_WAIT` | none yet (if a first message is due: "being processed") | bounded retries with backoff (≤ 3, honours `retryAfterMs`); then `FAILED` |
| any `executed: 'unknown'` (timeout, reset, unparseable) | `native`: `RETRY_WAIT` with the same key; `lookup`: reconcile first (found → `SUCCEEDED`, not found → retry once); `none`: `UNKNOWN` | for `UNKNOWN`: "received; a colleague will confirm" — never "done" | `UNKNOWN` → handover `ACTION_OUTCOME_UNKNOWN`; operator resolves in the inbox with the external id or failure; the customer gets the matching template |
| crash/lease expiry while `RUNNING` | treated as `executed: 'unknown'` | as above | as above |
8. Outcome messages are sent through the outbox (`telegram.send`), idempotent per execution and state. In SHADOW the worker records `SIMULATED` (no connector write) and nothing is sent; in LIVE the per-action mode must also be `live`.
9. The conversation state machine (D12) is respected: if an operator owns the conversation, no proposal is created and no outcome message is sent by the bot; execution already queued still completes and is shown to the operator.

## 10. Preventing unsupported claims
- Proposal, confirmation and outcome messages are rendered by code from stored rows; the model is not called for them.
- In other turns the guardrail adds an `ACTION_CLAIM` check: a draft may not contain the locale pack's action-claim phrases (e.g. "registered", "booked", "created") unless a `SUCCEEDED` execution for the conversation exists, and it can never reference an external id that is not stored. On violation: regenerate once, then fallback (existing GUARDRAIL path). This is defence in depth; the primary control is that outcome text never comes from the model.
- Existing handover templates keep their honest wording; the lead-sync status stays invisible to the customer.

## 11. Authorization summary (all must hold at proposal **and** at execution)
Tenant active; channel account mode allows sending (LIVE) or the action runs as SIMULATED (SHADOW); action enabled with mode `live` for the tenant; pack declares it; connector instance active, advertises the operation and `allowWrites: true`; conversation `BOT_ACTIVE`; proposal belongs to the conversation and tenant; digest matches; not expired. Untrusted LLM providers: proposals may be computed on test accounts only (existing data-protection rule); execution never depends on model output beyond the validated fields.

## 12. Data, privacy, audit and observability
- Proposals store only declared fields; contact data (name, phone) only when the action declares it; consent: the confirmation message names the data that will be sent (owner decision D-5 on wording/legal basis). Retention follows tenant retention settings; payload is redacted after a terminal state + N days (owner decision).
- Audit events (`audit_events`, safe summaries only: action key, field names, digest prefix, state, error code — no values): `action.proposed`, `action.superseded`, `action.confirmed`, `action.declined`, `action.expired`, `action.execution_started`, `action.succeeded`, `action.failed`, `action.unknown`, `action.resolved`.
- Metrics from rows (Phase 7.3 analytics): proposals, confirmation rate, success/failure/unknown rates per action and connector, retries, time to outcome, unknown backlog age. Alerts: unknown backlog > threshold, failure rate spike, write-permission errors.
- Inbox: executions are shown on the conversation timeline; `UNKNOWN` items have "mark succeeded (external id)" / "mark failed" operator commands (audited, idempotent, role-checked).

## 13. Compatibility and migration
- Additive migration: `action_proposals`, `action_executions` (tenant FKs, unique `(tenant_id, proposal_id)`, unique `idempotency_key`), new handover reasons `ACTION_FAILED`, `ACTION_OUTCOME_UNKNOWN`, audit actions.
- `DomainPackSchema.actions` is optional; existing packs stay valid; no action is enabled until a tenant enables it.
- Connector contract: `WriteContext` parameter added to write methods (existing callers updated: lead sync passes `lead:<lead id>` as idempotency key, which fixes the duplicate-lead defect for `native`/`lookup` connectors); `writeIdempotency` capability defaults to `none`; conformance suite extended.
- Existing handover lead job: unchanged in behaviour, gains the idempotency key; whether it later becomes an action of kind "system, no confirmation" is owner decision D-6.
- Telegram adapter: customer-chat `callback_query` handling (today only the operator group uses callbacks). The test registration script (`scripts/telegram-live.ts`) already subscribes to `callback_query`; any production webhook registration must too.

## 14. Testing strategy and acceptance criteria
**Unit (core, pure):** state machine transitions (every allowed and refused transition); digest stability and change detection; confirmation decision (callback token, exact phrase, model-only "yes" rejected, expired, superseded, other conversation); outcome mapping table §9.7 for each `writeIdempotency` mode; guardrail `ACTION_CLAIM`.
**Integration (real PostgreSQL, mock connector with scripted behaviours):** success; validation failure with field mapping; authorization failure; unavailable-then-success within retry bound; timeout before send (`executed: 'no'`) retried; timeout after the mock recorded the write: `native` → one remote record; `lookup` → reconciled, one record; `none` → `UNKNOWN`, handover, zero automatic retries; crash during `RUNNING` (lease expiry) → same as unknown; duplicate webhook/callback delivery and two workers racing → one execution, one remote write; tenant disables the action between confirmation and execution → `FAILED` with no write; SHADOW → `SIMULATED`, zero remote writes, zero messages; operator owns the conversation → no proposal; cross-tenant proposal token → refused.
**Contract:** conformance suite asserts `writeIdempotency` claims (a `native` connector given the same key twice returns the same id and creates one record), `executed` classification, evidence on success.
**Browser e2e (Phase 6A inbox):** an `UNKNOWN` execution appears; an operator resolves it; the customer receives the matching message (mock transport).
**Blocking metrics in eval (mock model):** 0 outcome claims without `SUCCEEDED`; 0 executions without a confirmation; 0 writes with payload ≠ confirmed payload; 0 cross-tenant leaks.

## 15. Cross-domain conformance test (Phase 7.1 acceptance)
Two tenants in one process, same pipeline and the same core action module:
- **Education** (existing pack): action derived from its documented needs (course interest + contact phone for an enquiry), operation `createLead`, connector = mock education catalog.
- **Travel** (new pack, mock tourism connector, fictional data): action with a different field set derived from the travel pack's own slots (destination, dates or month, party size; budget optional), a precondition (an offer was shown), a regulated-info rule handled by knowledge (entry requirements → fresh source or handover), operation `createLead` (or `createBooking` as a booking **request**, no payment).
- Scenarios per tenant: happy path to `SUCCEEDED` with the outcome message; customer changes a detail after the proposal → new proposal, old one not executable; duplicate confirmation delivery → one remote write; connector `none` + timeout → `UNKNOWN` + handover; SHADOW → no write.
- Assertions: the two tenants produce different questions, summaries, payloads and remote records; both traverse the identical state machine (same audit action sequence); no proposal, payload, knowledge chunk, instruction or event crosses tenants.
- **Core-unchanged check:** the travel pack lands in its own commit range; a CI job runs `git diff --name-only <base>...<head> -- apps/api/src/core` for branches/PRs marked as pack onboarding (branch prefix `pack/` or a PR label) and fails on any change. `core/architecture.spec.ts` is extended to fail if core imports from `src/packs/**` or a concrete connector.

## 16. Open decisions for the owner (prioritized)
| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-1 | Confirmation policy | (a) explicit confirmation for **every** write in v1; (b) allow `none` for low-risk actions (e.g. callback request) | (a); revisit with evidence |
| D-2 | Connectors without idempotency (`none`) in LIVE | (a) allowed: no auto-retry after unknown outcome, operator resolves; (b) LIVE requires `native` or `lookup` | (a) for leads/enquiries, (b) for bookings |
| D-3 | Accepted confirmation input | (a) buttons + exact locale phrases; (b) buttons only; (c) also model-classified intent | (a); never (c) alone |
| D-4 | Customer wording and promise for `UNKNOWN`/`FAILED` | e.g. "received, a colleague will confirm within <SLA>" | Use the tenant's handover SLA; native review per D18 |
| D-5 | Consent / data sent to the CRM | Which contact fields, explicit consent text, legal basis per tenant | Name the data in the confirmation; per-tenant consent text before LIVE |
| D-6 | Existing handover lead job | (a) keep separate (with idempotency fix); (b) migrate onto actions as a system-initiated, unconfirmed action | (a) now, (b) later |
| D-7 | Show external reference numbers to customers | per pack / per tenant | pack default off; tenant may enable |
| D-8 | Payload retention after terminal state | N days, then redact | align with retention settings (Open Question 9) |
| D-9 | Second validation domain and booking scope | travel mock with `createLead` only, or also `createBooking` request | `createLead` first; booking request after D-2 |

## 17. Why this keeps the platform universal
A new industry adds data (a pack with slots, questions, action specs), configuration (tenant enablement, connector mapping) and, if needed, a connector — the confirmation, idempotency, retry, outcome, audit, guardrail and handover rules are reused unchanged. The core never learns an industry word; the CI check makes that measurable for each onboarding.
