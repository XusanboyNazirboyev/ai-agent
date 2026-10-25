# ADR 026 — Agent platform v2: profiles, playbooks, memory, channels, simulation

Status: **accepted by the owner on 2026-10-25, with the decisions and amendments below.** Implementation proceeds one slice at a time, each only after an explicit owner GO.
ADRs 020–025 came from `phase6a/web-operator-inbox`, merged into `main` as `25be79b`.
Inputs: [audit](../design/agent-platform-v2-audit.md), [patterns](../research/agent-patterns.md), [channel rules](../research/channel-rules.md), [roadmap and quality bar](../design/agent-platform-v2-roadmap.md).

## Owner decisions and amendments (2026-10-25)
Decisions:
1. Merge `phase6a/web-operator-inbox` into `main` before slice 1. **Done:** `25be79b`, CI run 40170183486 success.
2. Live-model budget: **$50/month hard cap** to start. The strong tier may use Sonnet. The dev loop uses free or cheap providers on synthetic data only; paid runs are for gating only. **A cost estimate per full suite run is required before any paid run.**
3. Retail stays **mock-only**. EduFlow is the first live project.
4. **Amended 2026-10-25:** the owner has no company documents yet, so **Business Verification is not started**.
   - The Instagram adapter (C1) is built and demonstrated under **Meta Standard Access**, using the owner's own Instagram professional account and people with roles on the app (admins, developers, testers). No App Review is needed for that.
   - Per Meta's [send-message doc](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message), *"Apps with Standard Access can only send messages to people that have a role on the app"*, so the demo can reply only to role holders, not to the public.
   - **App Review / Advanced Access is deferred** until a verified legal entity exists. The [prerequisites list](../research/channel-rules.md#meta-app-review-prerequisites) stays ready.
   - WhatsApp stays last (C3). The reading of Meta Terms §4.7 must be confirmed against Meta's official text, or in writing from Meta or a BSP, before any WhatsApp work.
   - Messaging costs are recorded in [channel-rules](../research/channel-rules.md#messaging-costs).
5. Telegram Business mode: yes, but **re-verify the Premium requirement from official docs before building it**.
6. Customer memory, narrow scope:
   - structured facts only, never raw transcripts across conversations
   - explicit consent wording
   - retention 90 days by default, configurable per tenant
   - deletion on request
   - **Legal review (Uzbek personal-data law, including data localization) is required before any live use with real customers.**

Amendments:
- **A.** Slice 4 (channel contract) does not start until live Telegram verification evidence exists (shadow and live rounds).
- **B.** The simulation judge runs deterministic checks first. The LLM judge is calibrated against **≥ 20 human-graded conversations per language**. Uzbek judgments need native review.
- **C.** The quality-bar thresholds are **frozen**. Changing one requires the owner's written approval and a recorded reason.

## Context
The owner finds the agent too simple. The audit's root causes:
- one hardcoded flow for all businesses
- a 400-character persona and an unused tenant tone
- 8 messages of memory and no summary
- a closed list of 13 intents
- text-only Telegram
- every failure ends in a template
- Haiku on every tier
- no way to change or test behaviour without a deploy

Safety (typed provenance, confirmed actions, tenant isolation) is strong and is **kept**.

## Decision (target architecture)
```
Channel adapters ──► canonical inbound ──► Conversation runtime (per turn, per conversation, ordered)
                                          1 Perceive   language/script, NLU extraction (pack + playbook schema), corrections, entry context
                                          2 Recall     rolling summary + customer memory (typed, consented) + slots
                                          3 Decide     Playbook engine (code): active playbook stack, triggers, gates, policies, lifecycle stage
                                          4 Act        read tools / confirmed actions (ADR 023/024), knowledge
                                          5 Compose    LLM phrases from fact refs + channel capabilities (buttons/quick replies)
                                          6 Guard      existing guardrails + policy gate (window, thread owner, PII)
                                          7 Render     adapter degrades to channel capabilities, splits, throttles
AgentVersion (immutable, published) = Profile + Playbooks + Guidance + Tool allow-list + Model policy, pinned per conversation
Simulation harness gates every publish; Operator copilot and analytics read the same turn trace.
```
**Principle unchanged:** code decides what happens (D4); the LLM extracts, chooses among code-offered options and phrases. Facts come only from tools (D1/D5). Everything is versioned and testable. No new infrastructure: PostgreSQL, Redis/BullMQ and the existing `LlmProvider` are enough.

## Evidence from slice 1 (2026-10-25): compose replies from fact placeholders filled by code
In the free-model v1 baseline (40 English runs, see [evidence](../evidence/slice1-v1-baseline.md)), **15 of 40 runs ended in a guardrail handover**.
- Mechanism: the model typed prices, numbers and availability itself instead of citing facts, and the guardrail blocked every such draft.
- Violations: `FACT_NOT_LIVE` 14, `UNSOURCED_NUMBER` 13, `UNSOURCED_AVAILABILITY` 6, `UNSOURCED_CURRENCY` 4.
- Outcome: no invented fact reached a customer, but those conversations ended at the first failed draft.

This supports step 5 (Compose): the model chooses **which** fact slots to use and phrases the sentence; **code renders every value**. Prices, dates, seats and availability come from tool results through placeholders. A draft that still contains a raw number should be repaired by code (replace it with the matching fact or drop it) before it falls back to a handover. The quality bar's "invented facts = 0" stays blocking.

## Dimensions
Each entry gives options, then the recommendation (★), the **smallest valuable slice** (SVS) and what is out of scope.

**A. Agent profile and templates.**
- Options: (1) extend pack `businessRole`; (2) a per-tenant `AgentProfile` row in JSON config; (3) **★ an immutable `AgentVersion` (profile + guidance + playbook refs + tool allow-list + model policy) with draft → simulate → publish → rollback, and conversations pinned to the version they started on**.
- Templates (Sales, Support, Receptionist) are pack-agnostic presets.
- Trade-off: (3) needs a version table and pinning, but it is the only option that allows safe tuning by non-engineers.
- SVS: profile fields (name, role, tone, ≤ 30 guidance rules, language style), DB-stored versions, publish/rollback over the API, and the response prompt built from the profile. `TenantConfig.tone` folds into this.
- Out: per-operator personas, A/B traffic split (later, via version pinning).

**B. Playbooks.**
- Options: (1) natural-language procedures interpreted by the LLM; (2) a visual flow graph; (3) **★ declarative typed playbooks (JSON/TS in packs, then DB)**.
- (3) has typed steps: `collect` (slot schema with validation), `ask`, `tool` (mandatory `onEmpty`/`onError`), `condition` (code expressions over slots, memory and stage), `respond` (LLM phrasing with constraints), `action` (ADR 024 confirmation), `call` (sub-playbook), `handover(reason)`, `set_stage` and `end`.
- Playbooks also declare triggers (intent, entry context, event, operator command), entry and exit gates (required slots), and allowed variables.
- The engine keeps a playbook stack, so topic switches push and pop.
- Trade-off: (1) is flexible but untestable and conflicts with D4; (2) is costly and both builder vendors are leaving canvases.
- SVS: an engine plus 3 education playbooks (qualify-and-recommend, objection: price, booking-intent → `createLead`) behind flag `engine=v2`. The current flow becomes the `default` playbook.
- Out: a canvas editor, and LLM-generated playbooks.

**C. Conversation intelligence.**
- Options: (1) raise the history window; (2) **★ rolling summary + typed memory**; (3) a vector memory of all chats.
- ★: open-set intent with pack-declared intents plus `other` with a confidence score. Slot operations become `set | correct | clear` ("not black, red" replaces a value, "no budget limit" clears it). A topic stack in the engine. The **rolling summary** is regenerated by code every N turns or at handover, stored with turn references, and never used as a fact source.
- **Customer memory** (narrowed by owner decision 6): structured, typed entries (`preference`, `interest`, `constraint`, `contact`) with source turn, tenant scope, consent flag and TTL (90 days by default, configurable per tenant). Deleted on request. No raw transcripts across conversations. Hard facts are excluded.
- Loop/stall detection extends STUCK: the same step 3 times or no slot progress in 4 turns → change strategy, then hand over.
- SVS: correct/clear operations, a persisted intent, the rolling summary, and history raised to 20 with the summary.
- Out: cross-tenant memory, and memory inferred without consent.

**D. Channel layer (with D2).**
- Options: (1) per-channel code paths; (2) **★ one `ChannelAdapter` contract and a canonical message model** (see [channel-rules](../research/channel-rules.md#design-consequences-input-to-adr-026-d)); (3) a third-party aggregator API. (3) is fast but adds a vendor, cost and data exposure, and does not support Telegram Business.
- ★ includes:
  - **capabilities** per channel and account
  - an outbound degradation ladder (carousel → buttons → numbered list)
  - `EntryContext` (ad referral, comment, story reply/mention, deep-link payload)
  - message splitting and per-chat throttling
  - conversation policy state (`windowExpiresAt`, `windowKind`, `threadOwner`, opt-in/out) enforced by a send gate
- Multiple accounts per tenant, tokens via `secretRef`, refresh/expiry tracking.
- Cross-channel identity: a `Person` that links `Contact`s only on strong evidence, reversible and audited.
- Every adapter must pass a **conformance suite**, with Telegram as the reference.
- SVS: contract + canonical model, the Telegram adapter refactored onto it, then Telegram buttons, quick replies, typing, deep-link payload and splitting.
- Out: VK, Viber, voice/STT (owner-deferred), broadcasts.

**E. Knowledge.**
- Options: (1) keep the ingestion script; (2) **★ a source manager** (file and URL sources, scheduled re-sync, content hash, document versions, `updatedAt` shown to operators, per-source audience metadata filter); (3) web crawl at scale.
- Conflict policy written into the core: **CRM/tool facts win over documents**. A document number is never a fact (D5).
- Explicit unknown: an "I don't have verified information on this; I can connect you with a colleague" template, then an offer to hand over.
- SVS: URL and file sources with re-sync and hash, plus citations (source title and date) in operator views.
- Out: a crawler, PDF OCR beyond text layers.

**F. Actions and tools.**
- Options: (1) more write tools for the model; (2) **★ extend ADR 024**.
- ★ adds operations `createBooking` and `updateLead` behind connector capabilities, a **dry-run** mode (render and validate without calling the CRM, used by simulations), and tenant approval gates: auto after confirmation, or operator approval before execution. Confirmation can come by button where the channel supports it, with a server-side signed payload bound to the proposal digest.
- SVS: dry-run plus button confirmation on Telegram.
- Out: payments, discounts and refunds (D16).

**G. Sales intelligence.**
- Options: (1) LLM-scored leads; (2) **★ deterministic rules + LLM structured signals with reason codes (D13)**, organised by pack qualification frameworks (BANT-style fields per vertical).
- ★ adds predefined **lifecycle stages** per tenant (the agent can only move between them, with criteria), objection playbooks (price, timing, trust, competitor) using only tool facts, **follow-up cadences** (sequences of up to N steps, quiet hours, window-aware, stop on reply), **lost-lead recovery** (stage-based reminders), and next-best-action for operators. Upsell is restricted to tool-returned alternatives.
- SVS: stages + an education qualification framework + a 2-step cadence + a price-objection playbook.
- Out: autonomous discounting, predictive ML scoring.

**H. Handover and operator experience.**
- Options: (1) keep group notifications; (2) **★ a context pack + routing + copilot**.
- The context pack holds: summary, slots, score with reasons, shown offers, entry context, last messages and a suggested reply.
- **Routing** by language, skill/team, online status, load (least-open) and shift, plus VIP/returning-customer rules.
- **Copilot:** a draft reply with sources, labelled as a draft and always sent by a human; a summary on close; translation.
- Return-to-bot resumes the playbook stack.
- SVS: the context pack in the inbox, language and online routing, draft replies.
- Out: workforce scheduling, call-centre features.

**I. Safety.**
- Keep all current guardrails.
- Add: a PII policy per tenant (redaction in logs and memory; card and passport numbers never stored), **anger/frustration escalation** (lexical + LLM signal, then `COMPLAINT` handover), per-tenant policy rules (forbidden topics, claims) evaluated by the guardrail, the policy gate for channel windows, and audit of version publishes.
- Prompt injection: keep fencing; playbook-scoped tool allow-lists shrink the attack surface.
- SVS: anger escalation + PII redaction in memory/summary.

**J. Evaluation.**
- Options: (1) more scripted cases; (2) **★ a simulation harness**.
- ★: YAML scenarios (persona, goal, language, constraints, mock connector fixtures, success criteria). An LLM plays the customer against an `AgentVersion` in dry-run. Grading: **deterministic checks first** (facts, false claims, handover reason, slots, tool calls), then an **LLM judge** for soft criteria with stored reasons. Each scenario runs k=3 times.
- Also: an anonymized-replay importer, version comparison reports, and a publish gate.
- Scripted (mock-model) suites stay as the CI gate. Live-model simulation runs on demand or nightly within an owner budget.
- SVS: harness + education suite + v1 baseline report.

**K. Analytics.**
- A resolution taxonomy: `resolved_confirmed`, `resolved_assumed` (shown separately), `escalated(reason)`, `abandoned`, `lead_captured`.
- Also: funnel by stage, first-response and handover time, cost per conversation and per resolution, and recovered leads (cadence-attributed).
- Built from `AgentTurn` plus new outcome rows. It is a read-only page (Phase 7.3 scope).
- SVS: an outcome table + 6 charts.

**L. Studio UI.**
- Options: (1) a canvas builder; (2) **★ form-based Studio in `apps/web`**: profile editor, playbook editor (structured form with validation, read-only graph view), knowledge sources, **test chat** against a draft version with a turn trace, simulation runner and report, and publish/rollback.
- A visual flow builder is **not worth building** now (see patterns).
- SVS: profile editor + test chat + publish.
- Out: a canvas, and multi-user co-editing.

**M. Multilingual.**
- Keep the lexical detector (ADR 016/017).
- Add: per-message language **and per-segment code-switch detection** (reply in the dominant language, preserve product names), **tenant glossaries** (brand and product terms per locale, never transliterated), and a native-review workflow (export, review and import of locale strings with reviewer and date; D18 promotion from beta to stable).
- SVS: glossary + review export/import.

**N. Cost and latency.**
- **Tier routing:** extraction stays FAST; compose uses STRONG only for playbook steps marked `quality: high` (objection, recommendation) or after a guardrail regeneration.
- **Prompt caching:** stable profile and pack prefix first, so providers that support caching benefit.
- Per-tenant monthly budgets with alerts (ADR 014 ledger).
- Latency: typing indicators during LLM calls; target p95 turn < 6s.
- SVS: tier routing per step + cache-friendly prompt order.
- No semantic answer cache: the facts are live.

## Invariants kept
- Tool facts with provenance; RAG for text only.
- Core + Pack + Connector + Locale.
- Capability connectors.
- Tenant isolation; `secretRef` only.
- Idempotent inbox/outbox; per-conversation ordering.
- Handover reason codes; versioned config.
- Agent modes off/shadow/live; live refused outside development.
- Trusted-provider guard; token caps and budget reservations.
- Voice/STT deferred. Live Telegram unverified. Uzbek wording beta.

No invariant is superseded. Two are **extended**:
- D3/D4: playbooks are code-evaluated slot-filling.
- D12: the playbook stack lives inside `BOT_ACTIVE`; handover semantics are unchanged.

## Migration (strangler)
1. The new runtime is built beside `runAgentTurn`. Flag per channel account: `engine: v1 | v2` (default v1).
2. The v1 flow is wrapped as the `default` playbook, so v2 with only that playbook must reproduce v1's scripted-eval results.
3. Switching a tenant to v2 requires its scenario suite to pass at the [quality bar](../design/agent-platform-v2-roadmap.md#quality-bar-defined-before-implementation) in simulation and in SHADOW.
4. v1 is removed only after two weeks of v2 evidence with no regression.

## Consequences
- More configuration surface, so validation, versioning and simulation are mandatory, not optional.
- Live-model simulation has a cost, which needs an owner budget.
- Meta channels depend on external reviews, so they run as a parallel track gated on owner prerequisites.
- WhatsApp has an unresolved policy risk (Meta Terms §4.7) that needs legal review first.
