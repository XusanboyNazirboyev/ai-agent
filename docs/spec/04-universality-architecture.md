## 5. UNIVERSALITY ARCHITECTURE

```
                         ┌────────────────────────────────────────────┐
 Channels ─► Adapters ─► │                CORE ENGINE                 │ ─► Adapters ─► Channels
 (Telegram,              │ queue • state machine • slot engine •      │
  Instagram,             │ tool loop • guardrails • lead scorer •     │
  WhatsApp...)           │ handover • eval • observability            │
                         └───────┬───────────────┬──────────────┬─────┘
                                 │               │              │
                          DOMAIN PACK     CRM CONNECTOR    LOCALE PACK(s)
                       (what the business  (where the data   (language/script
                        sells & how to      lives & how to    prompts, templates,
                        talk about it)      reach it)         formatting, rules)
```

### 5.1 Domain Pack (declarative config, versioned; NOT code where avoidable)
A pack contains:
- `catalog`: which canonical item type(s) exist and their display names (tour / course / product).
- `slots`: JSON-Schema-like definition of slots, which are **required for search**, **required for quote**, optional, with question templates per locale and inference hints.
- `toolBindings`: how generic tools map to this domain (e.g., `search_catalog` → tours; → courses; → phones).
- `leadScoring`: rules and reason codes.
- `handoverExtras`: extra triggers specific to the domain.
- `guardrailFields`: which fields are "hard facts" (price, date, seats, schedule) the guardrail must verify.
- `promptFragments`: tone, domain vocabulary, do/don't lists.
- `knowledge`: seed knowledge documents and FAQs.
- `evalCases`: domain-specific eval cases.

Packs to ship (illustrative initial slot sets):
- **education**: `subject/course`, `level`, `format (online/offline)`, `preferredTime`, `studentAge`, `goal`, `budget`; capabilities: search courses/groups, seats, price, **book trial lesson**. Out of scope v1: grades, attendance, payment status (see Section 2 scope warning).
- **tourism**: `destination`, `kind (domestic/international)`, `dateOrMonth`, `nights`, `adults`, `children[]`, `budget`, `hotelStars`, `mealPlan`; international: passport/visa concern. Regulated info (visa) only from verified knowledge with visible update date, else handover.
- **retail-electronics** (proof-of-universality, optional): `category`, `model`, `storage`, `color`, `budget`; capabilities: search, stock, price.

### 5.2 CRM Connector
```ts
interface CrmConnector {
  readonly capabilities: {
    sync: boolean; search: boolean; liveQuote: boolean; availability: boolean;
    createLead: boolean; updateLead: boolean; createBooking: boolean; webhooks: boolean;
  };
  // each method present only if the capability is true
  listItems?(params): Promise<CatalogItem[]>;            // for sync
  searchItems?(query: CanonicalQuery): Promise<CatalogItem[]>;  // live search when no sync
  getItem?(id: string): Promise<CatalogItem>;
  getOffers?(itemId: string): Promise<Offer[]>;          // variants/departures/groups with price+stock
  checkAvailability?(offerId: string, req: Req): Promise<Availability>;  // LIVE
  getQuote?(offerId: string, req: Req): Promise<Quote>;                   // LIVE
  createLead?(input: LeadInput): Promise<{ crmLeadId: string }>;
  updateLead?(crmLeadId: string, patch: Partial<LeadInput>): Promise<void>;
  createBooking?(input: BookingInput): Promise<{ bookingId: string }>;    // e.g., trial lesson, appointment
  subscribeChanges?(handler: ChangeHandler): void;
}
```
- Connectors **declare capabilities**; the engine adapts (no capability → the agent never promises that action and hands over instead).
- **Mapping layer**: native fields → canonical fields declared in config (`fieldMappings`), so simple REST/JSON systems need config rather than code. Offer a **GenericRestConnector** (configurable endpoints, auth, pagination, JSONPath/JSONata mappings) plus **custom connectors** for complex systems.
- Planned connectors: `MockConnector` (dev/tests), `GenericRestConnector`, `GoogleSheetsConnector`, `DirectDbConnector` (read-only, for owned systems), `EduFlowConnector`, `OmonCrmConnector`, later `AmoCrmConnector`, `Bitrix24Connector`.
- Connector contract tests are mandatory: each connector must pass a shared conformance suite.
- Resilience: timeouts, retries with backoff, circuit breaker; connector failure never crashes a conversation.

### 5.3 Canonical model (core vocabulary)
`CatalogItem` (id, type, title, description, attributes{}), `Offer` (id, itemId, attributes{} such as date/group/schedule/variant, price Money, stock/seats, validUntil), `Quote` (id, offerId, total, breakdown, validUntil), `Booking`, `Lead`, `Contact`. Domain Packs decide which `attributes` are meaningful and which are hard facts.

### 5.4 Onboarding a new project = configuration only
Steps: (1) choose or author a Domain Pack, (2) configure connector + field mappings, (3) upload knowledge docs, (4) choose locales and tone, (5) run the pack's eval cases, (6) shadow mode, (7) go live.
**Acceptance test for universality**: onboarding the second vertical requires **zero changes under `src/core/**`**. Track "core files changed per new onboarding" as a metric; target zero.

---
