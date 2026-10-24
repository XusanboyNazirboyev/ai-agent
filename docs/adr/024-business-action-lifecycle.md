# ADR 024 — Business-action lifecycle (Phase 7.0b) and second-domain onboarding (7.1)

Status: **implemented on `phase6a/web-operator-inbox`; activation for real tenants needs owner decisions D-1, D-2, D-5 (ADR 022)**. Builds on ADR 022 (design, still the reference for open decisions) and ADR 023 (durable connector operations).

## What was built
- **Pack contract** (`packages/shared/src/domain-pack.ts`): optional `actions[]` — key, generic `operation` (`createLead` in v1), `triggerIntents` (`booking_interest`), `fields` (slot or contact source, required flag, per-locale label), `confirmation: 'explicit'` (the only value v1 accepts), expiry, per-locale title, CRM summary text, whether the external reference may be shown.
- **Tenant policy** (`TenantConfigSchema.actions`): per action `mode: off|live` (default off), `allowUnprotectedConnector` (default false), `consent` per locale. An action is offered only when: the pack declares it, the tenant set it `live`, an active connector has the capability, the connector declares `native`/`lookup` idempotency **or** the tenant explicitly allowed an unprotected one, and — if it sends contact data — consent text exists for every pack locale.
- **Core** (`src/core/actions/actions.ts`, pure, no domain words): field planning (first missing required field; only declared fields in the payload; invalid phone = missing), `proposalDigest` (SHA-256 over tenant, conversation, pack, action, payload), whole-message confirmation/decline phrases from locale packs, code-rendered proposal (title, every value that will be sent, consent text, how to confirm). Agent turn hooks: Tier-0 confirm/decline before any model call; any other message supersedes the open proposal; trigger intent or an action being collected → ask the next field (pack slot question, the existing phone request, or a name question) or propose. New guardrail `ACTION_CLAIM`: a model draft may never contain completed-action phrases (per locale).
- **Persistence**: `action_proposals` (additive migration `20261103090000`): payload (declared fields only), digest, status `PROPOSED → CONFIRMED | DECLINED | SUPERSEDED | EXPIRED → SUCCEEDED | FAILED | UNCERTAIN | CANCELLED`, expiry; partial unique index = at most one open proposal per conversation; unique proposing turn; success needs `external_id`. Payload cleared at every final state except UNCERTAIN (kept until a person resolves it).
- **Commit** (pipeline, LIVE only): PROPOSE supersedes the open one and stores the new proposal; CONFIRM is a compare-and-set on (tenant, conversation, id, `PROPOSED`, digest, not expired) and, in the same transaction, creates the `connector_operations` row and the outbox event `action.execute`; a stale or duplicate confirmation changes nothing and the reply says it expired. SHADOW never stores or executes anything.
- **Execution** (`ActionService.execute`, outbox + scheduled scan): re-checks pack, tenant mode, connector capability and protection, consent and the channel account being LIVE; if revoked: CANCELLED when nothing could have been applied, UNCERTAIN otherwise. Then the ADR 023 claim/lease/recovery policy with the stable key `createLead:action_proposal:<id>`; the payload sent is the stored one (never re-extracted). Outcome, proposal, customer message, handover and lead link in one transaction.
- **Customer messages** (code templates, 4 locales): `received` after confirmation (no success claim), `succeeded` / `succeededWithReference` only after a connector-confirmed id, `ACTION_FAILED` / `ACTION_OUTCOME_UNKNOWN` handover texts (only "recorded for our team"); messages are sent only while the bot owns the conversation; failure/uncertainty opens a handover.
- **Lead de-duplication**: an action's CRM lead marks the conversation's local lead SYNCED; the lead job links later leads to it instead of creating a second CRM record.
- **Operator workflow**: the inbox conversation view lists actions with status; an UNCERTAIN one shows the confirmed values and is resolved with the record id (or as not created) — `POST /api/v1/inbox/actions/:id/resolve`, session + CSRF + role, tenant from the session, audited; values disappear once resolved.
- **Second domain** (`src/packs/travel/`, commit `Pack-Onboarding: travel@1`): its own slots (destination, month, party size, budget), questions, prompt rules and a `trip_request` action requiring name and phone and showing the reference — onboarded without any `src/core/**` change. CI gate `pnpm check:onboarding` fails any `Pack-Onboarding` commit that touches the core (verified with a probe commit).

## Alternatives considered
| Option | Why not |
|---|---|
| A write tool the model can call | The model would decide when a write happens; contradicts D4/D5 and the read-only tool rule |
| Confirmation by model-classified intent | A paraphrase or a prompt-injected "yes" could execute; replaced by exact whole-message phrases (and later buttons) |
| Execute inside the confirming turn's commit | External calls cannot join the transaction; a crash or lost result would duplicate or lose the outcome |
| Per-pack workflow code | Duplicates the safety logic per domain; universality would not be measurable |
| Keep proposals open across unrelated messages | The customer could confirm details they no longer see; any other message now retires the proposal |

## Guarantees (with tests)
- Nothing executes without an exact confirmation of the current, unexpired, unchanged proposal; a confirmation reaches no model.
- One logical CRM write per confirmed proposal; duplicate Telegram deliveries, duplicate queue jobs and two concurrent workers cause no second call; native connectors deduplicate lost responses with the same key; unprotected connectors (only if allowed) are never retried after an unclear outcome.
- Success is reported only with connector evidence; unclear/failed outcomes hand over to a person; a revoked policy writes nothing.
- Tenant isolation for proposals, confirmation, execution, resolution and inbox reads; audit stores field names and codes, never values.
Evidence: `src/agent/actions-turn.spec.ts` (13), `src/actions/action.integration.spec.ts` (15), `src/actions/action-pipeline.integration.spec.ts` (2, real pipeline + mock connector), `src/actions/cross-domain.integration.spec.ts` (education + travel in one process), `apps/web/e2e/actions.spec.ts` (2, browser).

## Limitations and deferred
- Confirmation by text phrases only; Telegram inline buttons for customers are not built (D-3).
- Only `createLead`; `createBooking`/`updateLead` actions are not enabled (D-9).
- A CRM lead created by the handover job **before** a customer-confirmed action is not merged with it (D-6).
- After an operator resolves an UNCERTAIN action the bot does not message the customer (the conversation is with the operator).
- Action wording and phrases (ru, uz-Latn, uz-Cyrl) are not native-reviewed (D18 beta).
- The mock connector stands in for any real CRM; no vendor's idempotency is claimed.

## Owner decisions still required before enabling actions for a real tenant
D-1 (confirmation for every write — implemented as the only allowed policy), D-2 (unprotected connectors — refused unless the tenant opts in), D-5 (which contact data and the legal consent wording — consent text must be configured per tenant and locale). See ADR 022 §16.
