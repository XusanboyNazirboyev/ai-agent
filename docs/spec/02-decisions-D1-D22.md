## 3. LOCKED DECISIONS (with rationale)

| ID | Decision | Why |
|----|----------|-----|
| D1 | **Facts come from tools (CRM/DB), never from LLM memory or vector similarity.** | Embeddings give similarity, not exactness; near-identical items get confused; wrong prices destroy trust. |
| D2 | **RAG only for textual knowledge** (policies, descriptions, FAQ, info texts). | Text is fuzzy; numbers are not. |
| D3 | **Tool calling + slot-filling**, no fine-tuning. | Deterministic control; no retraining when data changes. |
| D4 | **Code decides which slots are missing; the LLM extracts slots from free text and phrases replies.** | LLMs are inconsistent at tracking required fields. |
| D5 | **Numbers/dates/prices in replies are rendered by code from tool results** (placeholders such as `{{price:quoteId}}`); a **guardrail** verifies every number/date in the final text exists in this conversation's tool outputs. | Prevents hallucinated figures. |
| D6 | **Channel adapter layer** normalizes every messenger to one internal format. | New channel = new adapter only. |
| D7 | **Queue (BullMQ), per-conversation ordering, idempotency by channel message ID.** | LLM latency is seconds; webhooks need instant ack; no loss or duplicates. |
| D8 | **Core + Domain Pack + CRM Connector + Locale Pack architecture** (Section 5). | Universality. |
| D9 | **Canonical data model** (`CatalogItem`, `Offer`, `Booking`, `Lead`, `Contact`). Connectors map native CRM data to canonical shapes. Core only knows canonical shapes. | Any CRM adapts without core changes. |
| D10 | **Hybrid data access**: search over synced local copy (fast) when the connector supports sync; **price and availability re-checked live before display**. If a CRM cannot sync, use live search only. | Speed plus correctness. |
| D11 | **Explicit handover triggers**, not "when unsure". | Predictable and testable. |
| D12 | **Conversation state machine**: `BOT_ACTIVE`, `WAITING_OPERATOR`, `OPERATOR_ACTIVE`, `CLOSED`; bot silent unless `BOT_ACTIVE`. | No bot/human collision. |
| D13 | **Lead scoring = deterministic rules + LLM structured output, always with reason codes.** Rules come from the Domain Pack. | Operators need to know why. |
| D14 | **Eval suite is a first-class deliverable and gates changes**, per pack and per locale. | "Better" must be measurable. |
| D15 | **`LlmProvider` abstraction with model tiers** (fast/cheap vs strong). Vendor **[OPEN]**. | No lock-in; cost/latency control. |
| D16 | **Customer text is untrusted input.** Tools narrowly scoped; no arbitrary actions; discounts/payments unavailable to the bot in v1. | Prompt-injection safety. |
| D17 | **Language and script are separate concepts.** The agent detects both per message and replies in the customer's language and script. | Uzbek is written in Latin and Cyrillic; mixing them up breaks UX and search. |
| D18 | **A language is "stable" only after passing its eval threshold with native-speaker review**; otherwise it is "beta" with conservative handover/fallback. | Honest quality; LLM quality for lower-resource languages varies. |
| D19 | **Operator experience is staged**: MVP = Telegram operator group behind an `OperatorNotifier` interface (Phase 5); then a dedicated **web Operator Inbox** (Phase 6A); Tenant Admin UI later (Phase 10). | Prove bot logic fast with minimal UI; a Telegram group does not scale to history, search, roles, or many operators. |
| D20 | **Frontend stack**: Next.js (App Router) + TypeScript strict + Tailwind + an accessible component library (shadcn/ui or equivalent). Server state via TanStack Query. **Real-time via SSE (server to client) + REST for actions**; WebSocket only if a concrete need appears. | SSE is simpler to run behind proxies and enough for push of new messages; operator actions are ordinary requests with idempotency keys. |
| D21 | **pnpm workspace monorepo**: `apps/api` (NestJS), `apps/web` (Next.js), `packages/shared` (zod schemas, DTO types, enums, locale IDs), `packages/config` (eslint/tsconfig). | Shared contracts prevent API/UI drift; one repo, one CI. |
| D22 | **UI internationalization from day one** (operator/admin UI languages are independent of customer conversation languages; initial UI languages uz-Latn, ru, en, **[OPEN, confirm]**). No hardcoded UI strings. | Operators work in different languages; retrofitting i18n is costly. |

---
