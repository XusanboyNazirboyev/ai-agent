# Agent platform v2 — as-is map and audit (Stage 0)

Date: 2026-10-25. Paths are on branch `phase6a/web-operator-inbox` (`491e331`, CI green), which was 40 commits ahead of `main` at the time of the audit. It was merged into `main` as `25be79b` on 2026-10-25, so these paths now exist on `main`. Research: [agent-patterns](../research/agent-patterns.md), [channel-rules](../research/channel-rules.md). Proposal: [ADR 026](../adr/026-agent-platform-v2.md).

## 1. As-is map
- **Turn pipeline.** The path is `channels/telegram/telegram-processor.ts:117` → `TelegramAgentPipeline.run` (`telegram-agent-pipeline.ts:153`: claim → compute → commit, retried) → `AgentConversationService.compute` → `runAgentTurn` (`core/agent/agent-turn.ts:222`). Order of work:
  - Regex language/script detection.
  - Tier-0 rules: opt-out, exact confirm/decline of an action, language gate.
  - **LLM 1**: structured extraction (language, intent, slots).
  - `mergeSlots`, then the handover-intent map.
  - Action field planning.
  - `firstMissing` slot question from a pack template.
  - Code-driven `searchBySlots` (exact → orthographic → relaxed).
  - **LLM 2**: tool loop.
  - `checkDraft` guardrail, with **LLM 3** regenerating once, then handover `GUARDRAIL`.
  - HIGH_VALUE check, then phone request.
  - Commit: `applyTurnState`, message, outbox, handover, lead rescore (`telegram-agent-pipeline.ts:540-752`).
- **Prompts** (`core/agent/prompts.ts`). Extraction (:48) has the pack `businessRole`, a fixed intent list and slot descriptions. Response (:80) has the role, the locale tone, 6 hardcoded rules and up to 20 pack rules. The user message carries `<history>`, `<latest_customer_message>`, `<known_customer_details>` and `<catalog_context>`. Both tiers default to `claude-haiku-5-5` (`config/environment.ts:164`).
- **State.** Persisted: versioned slots (`ConversationSlots`), language/script, and per-turn signals in `AgentTurn` (no intent column). Context is the last 8 messages (max 20, `environment.ts:218`), each cut to 2,000 characters. There is no rolling summary and no customer memory.
- **Configuration.** `DomainPackSchema` (`packages/shared/src/domain-pack.ts:155`) covers:
  - slots, and which of the 6 fixed tools are on
  - max options, knowledge thresholds, high-value threshold
  - rule-based lead scoring
  - actions, limited to `createLead` triggered by `booking_interest`
  - `businessRole` (400 characters) and up to 20 rules.

  Locale packs hold templates and tone. `TenantConfig.tone` exists but is **never read**.
- **Tools** (`core/agent/tools.ts:175`): `search_catalog`, `get_item_details`, `list_offers`, `check_availability`, `get_quote`, `knowledge_search`, all read-only. Guardrail codes are in `core/agent/guardrails.ts:23`, and the 16 handover reasons in `core/locales/locale-pack.ts:25`.
- **Leads and follow-ups.** Scoring is deterministic rules (`core/leads/scoring.ts`). Follow-up is 1 fixed template after 24h (`core/followup/policy.ts`).
- **Actions** (ADR 024): a code-rendered proposal, exact-phrase confirmation, and a durable `ConnectorOperation`.
- **Channel.** Telegram only. Inbound text only (non-text is rejected at `telegram-normalizer.ts:110`). Outbound is plain `sendMessage({chat_id,text})` (`telegram-sender.ts:59`). `MessageType` has only `TEXT` (`schema.prisma:69`). There is no channel-neutral adapter interface; `channelType` is a string.
- **Operators.** Telegram group notifier, plus the web inbox (`apps/web`): list, view, take-over/reply/return/close, notes, lead status, actions panel, SSE.
- **Evaluation.** 368 scripted plus 136 lifecycle cases with mock models (`agent/testing/*`, `eval/`), a CI gate, and SHADOW mode. There are no simulated customers and no live-model gate.

## 2. Why the agent feels simple (root causes)
1. **One hardcoded flow for every business**: ask slot → search → answer (`agent-turn.ts:533-650`). Packs change data, not behaviour. There are no playbooks, objection handling or multi-step strategies.
2. **Thin persona**: 400 characters of role plus a locale tone. Tenant tone is unused, and the core rules are fixed in code. Every tenant sounds the same.
3. **Short memory**: 8 raw messages, intent not stored, no summary and no customer memory. It loses context in longer chats and forgets returning customers.
4. **A closed world of 13 intents and one extraction schema** (`core/agent/slots.ts:24,48`). Anything outside it falls to `other` or hands over.
5. **Text-only channel**: no buttons, quick replies, media, typing or referral context. Every choice must be typed, which feels robotic in Telegram/Instagram.
6. **Safety by refusal**: strict fact guardrails are correct (D1/D5), but every failure path ends in a fixed template or handover. That is correct and safe, but feels cold. There is no "partial answer + offer next step".
7. **Cheapest model for everything**: Haiku on both tiers, with no routing by difficulty.
8. **No way to tune it.** The owner cannot change behaviour, test a change with simulated customers, or publish/rollback without a code deploy.

## 3. Audit by dimension
Severity reflects the gap's effect on conversion, trust or onboarding speed: **H**igh, **M**edium, **L**ow.

| Dim | Current state (refs) | Gap vs research | Sev |
|---|---|---|---|
| A Agent profile | `businessRole` + 20 rules in the pack; tone in the locale; `TenantConfig.tone` unused; no versions | No templates, per-tenant persona, guidance rules or draft/publish/rollback (respond.io, Zendesk, Voiceflow) | H |
| B Playbooks | Fixed flow in `agent-turn.ts`; pack slots + `requiredFor` search/quote | No typed steps, conditions, sub-playbooks, error branches or triggers (Fin, Zendesk, Voiceflow, Decagon) | H |
| C Conversation intelligence | 13 intents, `mergeSlots` overwrites but never clears (`slots.ts:164`), 8-message window, STUCK detection | No slot correction/clearing, topic stack, rolling summary or customer memory with consent | H |
| D Channels | Telegram text only; no adapter contract; no buttons, media or referral | No capability model, entry context, splitting or window rules; IG/WA/Messenger absent | H |
| E Knowledge | pgvector RAG with `minScore` and age limit for regulated text (ADR 019); ingestion script | No source manager (URL re-sync, versions), no citations shown, no freshness dashboard; CRM-wins is implicit (D1) not a rule | M |
| F Actions | `createLead` only, exact-phrase confirm, durable operations with idempotency (ADR 023/024) | Strong base. Missing: `createBooking`/`updateLead`, dry-run, tenant approval gates, button confirm | M |
| G Sales intelligence | Rule scoring with reasons; 1 follow-up template | No qualification frameworks per vertical, objection playbooks, cadences, lost-lead recovery, next-best-action or upsell | H |
| H Handover/operators | 16 reason codes, state machine, SLA, web inbox, Telegram group | No routing (skills, language, online, load), no copilot drafts, no suggested reply in the context pack | M |
| I Safety | Typed provenance, injection fencing, ACTION_CLAIM, prompt-leak, language guardrails, audit events | Missing: PII redaction policy per tenant, anger/sentiment escalation, per-tenant policy rules | M |
| J Evaluation | Scripted cases + lifecycle + coverage gate (Phase 7.2) | No simulated customers, LLM judge, anonymized replay or version comparison | H |
| K Analytics | Data exists in `AgentTurn`, `Handover`, `Lead`, `LlmUsageRecord`; Phase 7.3 planned | No resolution taxonomy, funnel, recovered leads or cost per resolution | M |
| L Studio UI | Inbox only; packs edited in code | No agent config, test chat, simulation runner or publish | H |
| M Multilingual | Lexical detector + orthography folding (ADR 016/017); 4 locales beta | No per-tenant glossary, code-switch handling inside one message, or native-review workflow tooling | M |
| N Cost/latency | Budget reservations, pricing table, failover routing (ADR 012/014) | No difficulty-based tier routing, prompt caching or per-tenant budgets in UI | L |

**Messengers (D2).** There is no `ChannelAdapter` contract or canonical message model. Identity is per channel account, and the `Contact` model has no cross-channel link. Tokens are env-based for the single test bot, with no `secretRef` per account. Meta channels need business verification and App Review, which are the longest external lead times (see [channel-rules](../research/channel-rules.md#external-prerequisites-checklist-for-the-owner)). Severity **H**, because Instagram is Uzbekistan's second channel.
