# AgentCore — product gap analysis (2026-11-10)

Tree: `origin/feat/production-pilot` @ `8dd5de0`. Paths are relative to the repository root. Staging facts come from read-only queries on 2026-11-10 (counts only, last 7 days unless stated). Evidence levels: `C` code · `T` tests · `W` wired · `P` provider connected · `R` real behaviour seen on staging · (no `D`: there is no production).

Status: **IMPLEMENTED** (C T W, and R where an external party is involved) · **PARTIAL** · **MISSING** · **NOT VERIFIED** (code and tests, no real-world evidence) · **N/A**. Priority: P0–P4 as in the [roadmap](AGENTCORE_DEVELOPMENT_ROADMAP.md).

## A. Omnichannel communication

| Capability | Status | Level | Evidence | Missing | Deps | Prio |
|---|---|---|---|---|---|---|
| Telegram | IMPLEMENTED | C T W P R | `apps/api/src/channels/telegram/` (webhook with secret header, BullMQ queue runtime, sender, typing indicator); staging: 1 LIVE + 1 OFF account, 58 text + 14 voice inbound | webhook-secret rotation flow (prior audit S3) | — | P2 |
| Instagram DM | IMPLEMENTED | C T W P R | `channels/instagram/` (signed webhook, normalizer, Graph sender, 24 h window), one-click connect `webinbox/instagram-connect.controller.ts`; staging 1 LIVE account | Meta Advanced Access for non-role users (App Review) | Meta | P2 |
| Instagram voice messages | IMPLEMENTED | C T W P R | ADR 042 amendments; `channels/voice/media-download.ts`, `audio-container.ts`; first real message transcribed 2026-11-10 13:37 UTC | URL lifetime unknown | — | — |
| Instagram comment → DM | NOT VERIFIED | C T | ADR 043, `instagram_comments` table, comment classification + public reply + private reply | not subscribed on staging (0 rows); permission per login kind unverified | Meta | P2 |
| Instagram carousel (catalog cards) | NOT VERIFIED | C T W | ADR 044, `messages.rich_content` | live postback and template send unverified | Meta | P3 |
| Reels / Stories triggers, keyword triggers | MISSING | — | no `story_mention`/`story_reply`/keyword trigger code | trigger model, Meta fields | automation engine | P3 |
| Facebook Messenger | NOT VERIFIED | C T W | `channels/facebook/` (webhook, normalizer, sender), `webinbox/facebook-connect.controller.ts`, ADR 040 | no Page connected on staging (0 accounts); one commit on `feat/facebook-messenger-core` not merged | Meta Page + login config | P2 |
| Facebook comments | MISSING | — | no `feed` handling in `channels/facebook/` | — | — | P3 |
| WhatsApp Business | MISSING | — | only a disabled card in `apps/web/src/components/channels-page.tsx` (`available: false`) | Cloud API adapter, templates (24 h rule), number onboarding | Meta WABA | P2 |
| Website live chat | MISSING | — | disabled `webchat` card only | widget, public session, anti-abuse | — | P2 |
| Voice calls | PARTIAL (parked) | C T | `apps/api/src/voice/` ports, orchestrator, ElevenLabs/LiveKit adapters, latency harness (ADR 045); not wired; owner paused 2026-11-09 | SIP trunk, wiring, consent recording | owner decision | P4 |
| Voice notes (Telegram) | IMPLEMENTED | C T W P R | ADR 042, Gemini STT + ElevenLabs backup, 14 voice notes in 7 days | larger WER sample | — | — |
| Unified conversation history | PARTIAL | C T W R | one `Conversation` per (channel account, chat) | history per person across channels | identity | P1 |
| Identity resolution across channels | MISSING | — | `Contact` unique on `[tenantId, channelAccountId, providerUserId]` | identity table, merge flow | — | P1 |
| Channel connection management | IMPLEMENTED (TG, IG) | C T W R | Channels page, connect dialogs, enable/disable, encrypted `channel_secrets` | WhatsApp/web chat | — | P2 |
| Webhook reliability, idempotency, retry | IMPLEMENTED | C T W R | `inbound_events` unique `[tenant, account, providerEventId]`, `outbox_events`, `messages.send_idempotency_key`, BullMQ per-conversation ordering (D7) | dead-letter view for operators | — | P3 |
| Delivery status | PARTIAL | C T W | `messages.delivery_state` PENDING/SENT/FAILED/UNKNOWN | read receipts; UI surfacing of failures | — | P3 |
| Rate limits, messaging windows | IMPLEMENTED | C T W | `TELEGRAM_RATE_LIMIT_PER_MINUTE`; Meta 24 h / 7-day policy in the Instagram core | per-tenant outbound quotas | — | P3 |

## B. CRM core

| Capability | Status | Level | Evidence | Missing | Prio |
|---|---|---|---|---|---|
| Contacts | PARTIAL | C T W R | `Contact` (name, phone, language, script, consent, opt-out, soft delete); `/api/v1/contacts` list | edit, merge, per-person view across channels | P1 |
| Companies | MISSING | — | no model | Company + contact link | P1 |
| Leads | IMPLEMENTED | C T W R | `Lead` with score (rules + LLM, reason codes, D13), status, requirements, CRM sync; 4 on staging | owner/assignee, value, source, expected close | P1 |
| Deals / opportunities | MISSING (Lead plays this role) | — | — | value, currency, products; decide Lead = opportunity (see data model review) | P1 |
| Pipelines, custom stages, Kanban | PARTIAL | C T W | `LeadStage` (tenant-configurable, ADR 039), `/leads` board, `/settings/pipeline` | multiple pipelines, stage rules, win/loss reasons | P1 |
| Lead sources | PARTIAL | C W | derivable from channel account | explicit `source` / campaign attribution | P1 |
| Lead scoring / qualification | IMPLEMENTED | C T W R | HOT/WARM/COLD + reason codes, operator override (ADR 037) | configurable criteria per pack | P2 |
| Segmentation, tags, custom fields | MISSING | — | none | tag model, field definitions, filters | P1 |
| Operator assignment | PARTIAL | C T W R | `conversations.assigned_operator_id`, handover assignment, idle return | rules (round robin, team, skill), reassignment history | P1 |
| Team management | IMPLEMENTED (new) | C T W | ADR 047 Team page, invites, roles, seat limit | teams/queues (groups of operators) | P1 |
| Tasks and reminders | MISSING | — | none (follow-ups are bot messages, not tasks) | Task model, due dates, notifications | P1 |
| Follow-up scheduling | IMPLEMENTED (bot) | C T W | `followup/`, opt-out, quiet hours, per-tenant limits | operator-scheduled follow-ups | P2 |
| Activity timeline | MISSING | — | events scattered across `messages`, `audit_events`, `handovers`, `leads` | unified timeline API/UI | P1 |
| Duplicate detection | PARTIAL | C T W | only in the Bitrix24 sink (`crm.duplicate.findbycomm`) | local duplicate detection on phone/e-mail | P1 |
| Import / export | MISSING | — | FAQ import exists; no contact/lead CSV | CSV import/export with mapping | P2 |

## C. Unified operator inbox

| Capability | Status | Level | Evidence | Missing | Prio |
|---|---|---|---|---|---|
| Unified inbox (all channels) | IMPLEMENTED | C T W R | `/inbox`, `webinbox/inbox-read.service.ts` | person-level threads (needs identity) | P1 |
| Ownership, take-over, return to bot | IMPLEMENTED | C T W R | ADR 038, state machine with version (`conversations.version`), races covered by `e2e/realtime.spec.ts` ("exactly one wins") | — | — |
| Assignment, team queues | PARTIAL | C T W | single assignee | queues, routing rules, load balancing | P1 |
| Online/offline presence | MISSING | — | none | presence (Redis), away status, routing by presence | P1 |
| Unread state | PARTIAL | C W | `apps/web/src/lib/seen.ts` keeps "seen" in the browser's localStorage | server-side per-operator read state | P1 |
| Internal notes | IMPLEMENTED | C T W | `internal_notes` | mentions | P3 |
| Canned responses | PARTIAL | C T W | fixed locale strings `canned.*` picked in `apps/web/src/components/conversation-view.tsx:519` (e2e `operator-flow.spec.ts:130`); not tenant-editable | tenant library with variables, per-team | P1 |
| Labels | MISSING | — | none | conversation tags | P1 |
| Search and filtering | PARTIAL | C T W | contact name and message text search (`operator-flow.spec.ts:94`), state filters | filters by tag, assignee, channel, date | P2 |
| AI → human escalation, SLA | IMPLEMENTED | C T W R | explicit handover triggers (D11), `handovers.sla_due_at`, SLA alerts, digest | per-team SLA policies | P2 |
| First response / resolution time | IMPLEMENTED (analytics) | C T W | `webinbox/analytics.service.ts` (`firstResponse`, `resolution`) | per-operator breakdown | P2 |
| Realtime updates | IMPLEMENTED | C T W | SSE `webinbox/events.controller.ts`, polling bus with REST catch-up | horizontal scale beyond one API instance not tested | P3 |

## D. AI sales agent

| Capability | Status | Level | Evidence | Missing | Prio |
|---|---|---|---|---|---|
| Support and Q&A | IMPLEMENTED | C T W P R | `core/agent/agent-turn.ts`, ADR 041 conversational turns | quality (see below) | P2 |
| Lead qualification, slot filling (D3/D4) | IMPLEMENTED | C T W R | pack slots, `ASKED_SLOT` outcomes (10 in 7 days) | — | — |
| Recommendations from catalog | IMPLEMENTED | C T W R | code-driven catalog search, aliases, Uzbek orthography folding (ADR 017) | ranking signals | P3 |
| CRM data retrieval via tools | IMPLEMENTED | C T W | tools `search_catalog`, `get_item_details`, `list_offers`, `get_quote` | live CRM reads beyond catalog | P2 |
| Tenant-scoped RAG | IMPLEMENTED | C T W | pgvector `knowledge_chunks`, regulated passages with validity (ADR 019); 1 document on staging | PDF/Word ingestion, site crawl | P2 |
| Hard-fact verification | IMPLEMENTED | C T W R | typed provenance, guardrail, code-rendered numbers | — | — |
| Memory | PARTIAL | C T W | conversation history window + versioned slots | long-term per-person memory (needs identity) | P2 |
| Brand tone | PARTIAL | C W | pack/locale texts | tenant tone settings + review | P3 |
| Confidence-based escalation | IMPLEMENTED | C T W R | `CLARIFICATION_REQUIRED`, language gate, STUCK rule | — | — |
| Multi-step business actions | IMPLEMENTED | C T W | customer-confirmed actions (ADR 022/024), scheduling tools (ADR 046) | — | — |
| Objection handling, follow-up suggestions | MISSING | — | none | playbooks | P3 |
| Uzbek Latin/Cyrillic, Russian | IMPLEMENTED (beta) | C T W R | locale packs, script detection, folding; ADR 016/017 | native review (D18), uz-Cyrl live-eval failures | P2 |
| Answer quality on staging | PARTIAL | R | 61 turns: 19 HANDOVER, 12 ANSWERED, 10 ASKED_SLOT, 8 FALLBACK, 8 NO_RESULTS, 4 CLARIFICATION | handover reasons review, Uzbek final-draft truncation (latency audit) | P0/P2 |
| Latency | NOT VERIFIED (after fix) | C T | `docs/audit/2026-11-10-latency-experiments.md`: p50 14 s → ~7 s expected after the reasoning-effort fix, deployed 2026-11-10 | measurement from `agent.turn_committed` timings | P0 |

## E. Visual automation builder

| Capability | Status | Evidence | Note |
|---|---|---|---|
| Triggers, conditions, actions, delays, AI/CRM/assign/message/webhook nodes | MISSING | no flow model | Foundations to reuse: outbox + BullMQ (delays/retries), `ActionProposal` lifecycle (human-approved actions), follow-up scheduler, connector operations (idempotent external writes), guardrails. |
| Versioning, draft/publish, execution history, retries, testing, templates | MISSING | — | Recommendation (architecture doc): an **internal declarative flow engine on the existing outbox/BullMQ**, not n8n/Temporal, for tenant isolation, one database and reuse of the guardrails. |

## F. Voice and speech

| Capability | Status | Level | Evidence / note |
|---|---|---|---|
| STT port and real providers | IMPLEMENTED | C T W P R | `core/speech/speech-to-text.ts`; `speech/gemini-*`, `elevenlabs-*`, `fallback-*`; Whisper (Groq) adapter exists but unusable for Uzbek (93–174% WER) |
| Why `NOT_CONFIGURED` | explained | C | `config/environment.ts:173` `STT_PROVIDER` defaults to `none` → `buildSpeechToText` returns `NotConfiguredSpeechToText` → `voice-transcription.service.ts:201/240` returns `NOT_CONFIGURED` ("please type"). Operational needs: `STT_PROVIDER=gemini` and `STT_API_KEY` or `GEMINI_API_KEY` (paid tier), optional `ELEVENLABS_API_KEY` with `STT_FALLBACK=elevenlabs`. Staging has these; a fresh environment does not. |
| Uzbek / Russian / mixed | PARTIAL | R | measured on 9 owner recordings: Gemini 35–37% WER overall, ru 9–18%; small sample, one speaker |
| TTS, calls, LiveKit/SIP | PARTIAL (parked) | C T | adapters exist, unwired (ADR 045) |
| Audio storage and privacy | IMPLEMENTED (by design: not stored) | C | audio fetched, transcribed, not persisted; Instagram URL kept as `media_ref` (expires at Meta) |
| Cost tracking | IMPLEMENTED | C T W R | `llm_usage_records` purpose `transcribe` with reservation on the budget ledger (REV-03) |
| Failure handling | IMPLEMENTED | C T W R | "please type", two failures → `VOICE_UNREADABLE` handover |
| WhatsApp audio | N/A until WhatsApp exists | — | — |

## G. CRM connectors

| Capability | Status | Level | Evidence |
|---|---|---|---|
| Connector framework (contracts, conformance, resilience, idempotent operations) | IMPLEMENTED | C T W | `connectors/interfaces`, `contracts`, `resilience`, `connector_operations` (ADR 023) |
| Bitrix24 lead/deal sink | IMPLEMENTED | C T W P R | `connectors/bitrix24/` uses `crm.item.add/list`, `crm.duplicate.findbycomm`, `crm.timeline.comment.add`; 3 of 4 staging leads synced |
| Bitrix24 catalog read, contacts sync, two-way stage sync | MISSING / proposed | — | ADR 034 proposed on unmerged `docs/bitrix24-stage-sync` |
| Kommo / amoCRM, others | MISSING | — | none |
| Generic REST catalog connector + sync | IMPLEMENTED | C T W | `connectors/generic-rest/`, `catalog_sync_runs`, SSRF guard |
| Calendar / appointment sync | MISSING | — | ADR 046 step 3 pending |
| Connector secrets, health | IMPLEMENTED / PARTIAL | C T W | encrypted `connector_secrets`; health = sync run status, no alerting dashboard |

## H. Payments and business operations

| Capability | Status | Evidence |
|---|---|---|
| Platform subscription billing (plans, periods, manual payments) | IMPLEMENTED (manual) | ADR 047, `subscription_*` tables, console |
| Click integration | MISSING | no code; official Shop API contract read 2026-11-10 (Prepare/Complete, MD5 signature, error codes −1…−9) and recorded for the next slice |
| Customer payments, transactions, refunds, overpayment, reminders | MISSING | D16 says no payments in v1; needs an owner decision |
| Quotes | IMPLEMENTED | `quotes` with snapshot and validity, `shown_offers` |
| Booking (offer) | PARTIAL | `bookings` + customer-confirmed action; CRM booking via connector |
| Appointment scheduling | NOT VERIFIED | ADR 046 tables + 4 agent tools; 0 appointments on staging; no admin UI, no reminders |

## I. Analytics and reporting

| Capability | Status | Evidence |
|---|---|---|
| Funnel, leads by score, handover rate, auto-resolved rate, first response, resolution, guardrail blocks, language detection, LLM cost per conversation, latency, errors | IMPLEMENTED | `webinbox/analytics.service.ts`, `/analytics` page (Phase 7.3) |
| Channel performance, operator performance, campaign and automation metrics | MISSING | no per-channel/per-operator breakdowns, no campaigns/automation |
| Cost per successful task, STT usage | PARTIAL | raw data in `llm_usage_records` / `agent_turns`; no report |
| Tenant usage limits | PARTIAL | LLM budget per turn/conversation and monthly ledger; plan `limits` (operators enforced; channels and LLM budget not yet enforced from the plan) |

## J. Security and production readiness
Summarised here; full findings in the [security review](AGENTCORE_SECURITY_AND_PRODUCTION_REVIEW.md).

| Area | Status |
|---|---|
| Sessions, CSRF, Origin check, login limiter, scrypt | IMPLEMENTED |
| Two-layer RBAC (platform / tenant) | IMPLEMENTED (ADR 047) |
| MFA | MISSING |
| Tenant isolation | PARTIAL (by convention and tests; no RLS) |
| Webhook signatures, OAuth state, SSRF, secret encryption, security headers, body limit, shutdown hooks, non-root containers | IMPLEMENTED |
| General API rate limiting | MISSING (login only) |
| CI secret / dependency / container scanning | MISSING |
| Retention jobs, data deletion workflow | MISSING (legal page only; `inbound_events.expires_at` without a purge job found) |
| Backups | PARTIAL (daily on-host `pg_dump`, no off-host copy, no restore drill) |

## Competitor comparison

| Area | Kommo | ManyChat | Jivo / Chatra | AgentCore today | Adopt | Not for first release |
|---|---|---|---|---|---|---|
| Channels | many messengers | IG, FB, WhatsApp, TikTok | site chat + messengers | Telegram, Instagram DM (+ voice); Messenger code | WhatsApp, website chat | TikTok, SMS, e-mail |
| Comment automation | — | core feature | — | comment→DM code, not enabled | keyword triggers on comments, Reels/Stories | giveaways, growth tools |
| CRM objects | contacts, companies, leads, pipelines, tasks | contact fields, tags | basic contact card | contacts (per channel), leads, one pipeline | identity, companies, pipelines, tasks, tags, fields | quotas, forecasting |
| Automation | Salesbot, digital pipeline | visual flow builder | triggers | none (follow-ups only) | declarative flows with triggers/conditions/actions/delays | marketplace of templates |
| Inbox | yes | live chat | best-in-class (presence, canned, routing) | strong ownership model, SLA, notes | presence, queues, canned library, server unread | co-browsing, visitor tracking |
| AI | add-on | AI step | AI assistant | **AI-native agent with tool-verified facts** | — | — |

**Where AgentCore can win:** (1) the agent answers with **verified business facts** and refuses to invent prices or dates — none of the three guarantee this; (2) **Uzbek Latin/Cyrillic + Russian** handled as separate language and script, with voice notes; (3) **one engine, many industries** through packs and connectors; (4) **AI/operator collaboration** with explicit handover reasons and SLA; (5) **SaaS or dedicated** deployment from the same images.
