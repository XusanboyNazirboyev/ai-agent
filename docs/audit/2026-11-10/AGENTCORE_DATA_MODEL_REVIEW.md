# AgentCore — data model review (2026-11-10)

Source: `apps/api/prisma/schema.prisma` at `8dd5de0` — **49 models, 34 enums, 28 migrations** (latest `20261115090000_platform_console_subscriptions`). No schema change was made by this audit.

## 1. What exists (grouped)

| Group | Models | Notes |
|---|---|---|
| Tenancy and auth | `Tenant`, `Operator`, `OperatorCredential`, `OperatorSession`, `OperatorApiToken`, `OperatorInvite` | composite `@@unique([tenantId, id])` on every tenant table enables tenant-safe composite foreign keys |
| Platform | `PlatformAdmin`, `PlatformSession`, `PlatformAuditEvent`, `SubscriptionPlan`, `TenantSubscription`, `SubscriptionPayment` | partial unique index: one open subscription per tenant (hand-written SQL) |
| Channels and messages | `ChannelAccount`, `ChannelSecret`, `InboundEvent`, `OutboxEvent`, `Contact`, `Conversation`, `Message`, `InstagramComment`, `InboxEvent` | dedupe `[tenantId, channelAccountId, providerEventId]`; message `sequence` per conversation; `Message` carries voice and rich-content fields |
| Agent | `AgentTurn`, `ConversationSlots`, `ActionProposal`, `LlmUsageRecord`, `LlmBudgetReservation` | leases, versions, idempotency keys, per-call cost |
| CRM-lite | `Lead`, `LeadStage`, `Handover`, `InternalNote`, `FollowUp`, `Booking`, `Quote`, `ShownOffer` | one pipeline per tenant (`LeadStage`) |
| Catalog and connectors | `TenantConnector`, `ConnectorSecret`, `ConnectorOperation`, `CatalogSyncRun`, `CatalogItem`, `Offer`, `CatalogAlias` | canonical model D9; source system + source id uniques |
| Knowledge | `KnowledgeDocument`, `KnowledgeChunk` | pgvector embeddings, model + dims recorded |
| Scheduling | `ServiceType`, `StaffMember`, `AvailabilityRule`, `AvailabilityException`, `Appointment` | exclusion constraint against double booking (migration `20261114090000`) |
| Audit | `AuditEvent` | actor type, safe input summary, correlation id |

**Strengths:** consistent tenant ownership, composite keys that make cross-tenant foreign keys impossible, idempotency keys on every externally triggered write, money as typed values with currency and pricing basis, soft-delete where needed, explicit enums for every lifecycle.

**Weaknesses found:**
1. `Contact` is a **channel identity**, not a person (`@@unique([tenantId, channelAccountId, providerUserId])`). The same customer on Telegram and Instagram is two contacts, two conversations, possibly two leads.
2. One pipeline only: `LeadStage` has no pipeline id.
3. No generic extension points (tags, custom fields) — every new attribute needs a migration or goes into `Lead.requirements` JSON.
4. `messages` has no `(tenant_id, created_at)` index; "this month's inbound messages" in the console scans by date (noted by the ADR 047 builder).
5. `InboundEvent.expiresAt` is indexed but no purge job was found; `retentionSettings` on `Tenant` is not read by any job (retention not enforced).
6. `Booking` (offer bookings) and `Appointment` (scheduling) are two booking concepts; acceptable because they model different things (a seat on an offer vs a staff time slot), but the UI should present them as one "bookings" list.

## 2. Reuse before adding
| Need | Reuse | Add |
|---|---|---|
| Deal / opportunity | **`Lead`** already has stage, score, status, requirements, CRM sync | add `pipelineId`, `ownerOperatorId`, `amountMinor`, `currency`, `source`, `expectedCloseAt`, `lostReason` to `Lead` — do **not** add a parallel `Deal` table |
| Pipeline | `LeadStage` | `Pipeline` table; `LeadStage.pipelineId` |
| Conversation assignment history | `Handover` (reason, assignee, timestamps) | `ConversationAssignment` only for non-handover assignment events |
| Activity timeline | `AuditEvent`, `Message`, `Handover`, `Lead` changes | `Activity` table (denormalised, append-only) fed from the outbox |
| Transcription | `Message.voiceStatus/text` for notes | `VoiceCall` only when calls are resumed |
| Payments | `SubscriptionPayment` is **platform billing** | `CustomerPayment` + `PaymentTransaction` only if D16 changes |

## 3. Missing entities

All tables: `id uuid(7)`, `tenant_id` NOT NULL with `@@unique([tenantId, id])`, `created_at/updated_at`, composite FKs `(tenant_id, x_id)`.

### 3.1 Person and identities
- **`Contact` becomes the person** (keep the table, keep ids). New **`ContactIdentity`**: `contactId`, `channelAccountId`, `providerUserId`, `displayName`, `firstSeenAt`, `lastSeenAt`. Unique `[tenantId, channelAccountId, providerUserId]` (moves from `Contact`). Index `[tenantId, contactId]`.
- **`ContactPoint`** (optional, or columns): normalised phone/e-mail with `verified` and `source` (`typed`, `heard_in_voice`, `crm`) — needed for duplicate detection; unique `[tenantId, kind, value]` **not** enforced (shared phones exist), index instead.
- **Merge**: `ContactMerge` audit row (`survivorId`, `mergedId`, `byOperatorId`, reason). Conversations and leads re-pointed in one transaction.
- Migration: expand (new table, backfill one identity per existing contact) → switch reads/writes → contract (drop old unique) — zero downtime.

### 3.2 Companies
`Company` (`name`, `normalizedName`, `inn`/tax id optional, `phone`, `website`, `customFields`) and `ContactCompany` (role, primary). Index `[tenantId, normalizedName]`.

### 3.3 Pipelines and opportunities
`Pipeline` (`name`, `position`, `isDefault`; partial unique: one default per tenant). `LeadStage` gains `pipelineId` (backfill: one default pipeline per tenant), `kind` (`OPEN|WON|LOST`). `Lead` gains the columns listed in §2. Indexes: `[tenantId, pipelineId, pipelineStageId, updatedAt]`, `[tenantId, ownerOperatorId, status]`.

### 3.4 Tasks and activity
- `Task`: `title`, `dueAt`, `status` (`OPEN|DONE|CANCELED`), `assigneeOperatorId`, `contactId?`, `leadId?`, `conversationId?`, `createdBy` (operator | automation | agent), `completedAt`. Index `[tenantId, assigneeOperatorId, status, dueAt]`. Reminder = BullMQ delayed job keyed by task id (idempotent).
- `Activity`: `subjectType`, `subjectId`, `kind`, `actorType/actorId`, `summary` (safe), `occurredAt`, `sourceEventId` (unique per tenant for idempotent projection). Index `[tenantId, subjectType, subjectId, occurredAt]`.

### 3.5 Teams, presence, read state, labels, canned responses
- `Team`, `TeamMember` (`teamId`, `operatorId`, unique pair). Conversation gets `teamId?`.
- Presence: **Redis**, not Postgres (TTL keys per operator); only "away" preference persisted on `Operator`.
- `ConversationRead` (`conversationId`, `operatorId`, `lastReadSequence`) unique pair — replaces localStorage "seen".
- `Tag` (`name`, `color`, `scope` contact|conversation|lead; unique `[tenantId, scope, normalizedName]`) + join tables `ContactTag`, `ConversationTag`, `LeadTag`.
- `CustomFieldDefinition` (`entity`, `key`, `type`, `options`, `required`, `position`; unique `[tenantId, entity, key]`) + `customFields Json` column on `Contact`, `Company`, `Lead` validated by code against definitions (GIN index only if filtering demands it).
- `CannedResponse` (`title`, `body` with `{{variables}}`, `locale`, `teamId?`, `shortcut`; unique `[tenantId, shortcut]`).

### 3.6 Automation
`AutomationFlow` (name, status `DRAFT|PUBLISHED|ARCHIVED`), `AutomationFlowVersion` (`flowId`, `version`, `definition Json`, `publishedAt`, `publishedBy`; unique `[flowId, version]`), `AutomationRun` (`flowVersionId`, `trigger`, `subjectType/Id`, `status`, `startedAt`, `finishedAt`, `idempotencyKey` unique per tenant), `AutomationStepRun` (`runId`, `nodeId`, `status`, `attempt`, `scheduledFor`, `errorCode`, `outputSummary`). Indexes on `[tenantId, status, scheduledFor]`. Nodes are JSON inside the version (no `AutomationNode` table: versions must be immutable snapshots).

### 3.7 Campaigns (P3+)
`Campaign` (channel, audience query snapshot, template, schedule, status) + `CampaignRecipient` (unique `[campaignId, contactId]`, consent and window checks recorded). Requires consent (`Contact.consentStatus`, `marketingOptOut` already exist).

### 3.8 Payments (only after an owner decision on D16)
`CustomerPayment` (`leadId?`, `contactId`, `amountMinor`, `currency`, `status`, `provider`, `providerRef` unique per provider) and `PaymentTransaction` (each provider callback, signature-verified, idempotent on provider transaction id). Platform subscription payments stay in `SubscriptionPayment`.

### 3.9 Voice calls (when resumed)
`VoiceCall` (`conversationId`, `direction`, `from/to` hashed or masked, `startedAt`, `endedAt`, `consentAt`, `recordingRef?`, `status`), `VoiceCallSegment` for turn latencies. Recording storage per ADR 045 (encrypted S3, 90 days).

## 4. Tenant isolation, audit, constraints
- Keep composite `(tenant_id, id)` FKs for every new relation; never a bare `id` FK across tenant tables.
- Add **Postgres RLS** as defence in depth, first on `contacts`, `contact_identities`, `conversations`, `messages`, `leads`, `knowledge_chunks`, with `SET app.tenant_id` per transaction from a Prisma extension; the platform module uses a separate role that bypasses RLS explicitly.
- Every operator- or automation-initiated change writes `audit_events` (who, what, safe summary) and projects an `Activity`.
- Add `messages (tenant_id, created_at)` index before usage analytics grow.

## 5. Migration recommendations
1. Additive migrations only, expand → backfill → switch → contract, each step deployable on its own (the staging deploy runs `migrate` automatically before starting the new image).
2. Backfills as idempotent scripts under `apps/api/src/ops/`, run once per environment, with counts logged.
3. Order: Pipeline/Lead columns → ContactIdentity (+ backfill) → Tag/CustomField → Task/Activity → Team/ConversationRead/CannedResponse → Automation → (Payments, Campaigns, Voice calls later).
4. Take a verified backup before each migration on staging/production (see security review: off-host copies are a prerequisite).
