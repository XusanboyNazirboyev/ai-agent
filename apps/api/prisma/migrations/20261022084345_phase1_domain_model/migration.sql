-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "ChannelAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OperatorRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('BOT_ACTIVE', 'WAITING_OPERATOR', 'OPERATOR_ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageAuthorType" AS ENUM ('CUSTOMER', 'BOT', 'OPERATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CatalogItemStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "PricingBasis" AS ENUM ('PER_PERSON', 'PER_NIGHT', 'PER_UNIT', 'TOTAL', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'LIMITED', 'SOLD_OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LeadScore" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "CrmSyncStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SYNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('OPEN', 'TAKEN', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "InboundEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('SYSTEM', 'CUSTOMER', 'OPERATOR', 'ADMIN');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_locale" VARCHAR(32) NOT NULL,
    "supported_locales" TEXT[],
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tashkent',
    "pack_key" VARCHAR(100) NOT NULL,
    "pack_version" VARCHAR(64) NOT NULL,
    "enabled_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retention_settings" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_connectors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_key" VARCHAR(100) NOT NULL,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'DISABLED',
    "config" JSONB NOT NULL DEFAULT '{}',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret_ref" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_type" VARCHAR(40) NOT NULL,
    "external_account_id" VARCHAR(200) NOT NULL,
    "status" "ChannelAccountStatus" NOT NULL DEFAULT 'DISABLED',
    "credential_ref" VARCHAR(500),
    "webhook_secret_ref" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "role" "OperatorRole" NOT NULL DEFAULT 'OPERATOR',
    "telegram_user_id" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "provider_user_id" VARCHAR(200) NOT NULL,
    "name" VARCHAR(200),
    "phone" VARCHAR(40),
    "language" VARCHAR(16),
    "script" VARCHAR(16),
    "consent_status" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consent_at" TIMESTAMPTZ(6),
    "marketing_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "provider_chat_id" VARCHAR(200) NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'BOT_ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "assigned_operator_id" UUID,
    "language" VARCHAR(16),
    "script" VARCHAR(16),
    "last_inbound_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "author_type" "MessageAuthorType" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "text" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "provider_chat_id" VARCHAR(200) NOT NULL,
    "provider_message_id" VARCHAR(200),
    "delivery_state" "DeliveryState" NOT NULL DEFAULT 'UNKNOWN',
    "send_idempotency_key" VARCHAR(200),
    "detected_language" VARCHAR(16),
    "detected_script" VARCHAR(16),
    "language_confidence" DECIMAL(4,3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "slots" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_system" VARCHAR(100) NOT NULL,
    "source_entity_id" VARCHAR(200) NOT NULL,
    "item_type" VARCHAR(100) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "normalized_title" VARCHAR(600) NOT NULL,
    "normalizer_version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{"fields":{}}',
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "source_hash" VARCHAR(128) NOT NULL,
    "status" "CatalogItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "source_system" VARCHAR(100) NOT NULL,
    "source_entity_id" VARCHAR(200) NOT NULL,
    "price" DECIMAL(20,6),
    "currency" CHAR(3),
    "pricing_basis" "PricingBasis" NOT NULL DEFAULT 'UNSPECIFIED',
    "taxes_included" BOOLEAN,
    "fees_included" BOOLEAN,
    "availability_status" "AvailabilityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "seats_left" INTEGER,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "valid_from" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "attributes" JSONB NOT NULL DEFAULT '{"fields":{}}',
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "source_hash" VARCHAR(128) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_aliases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "normalized_value" VARCHAR(600) NOT NULL,
    "normalizer_version" INTEGER NOT NULL DEFAULT 1,
    "locale" VARCHAR(32) NOT NULL,
    "script" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "pricing_basis" "PricingBasis" NOT NULL,
    "breakdown" JSONB NOT NULL,
    "source_system" VARCHAR(100) NOT NULL,
    "source_entity_id" VARCHAR(200) NOT NULL,
    "retrieved_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "snapshot" JSONB NOT NULL,
    "shown_in_message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "score" "LeadScore" NOT NULL DEFAULT 'COLD',
    "reason_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "crm_sync_status" "CrmSyncStatus" NOT NULL DEFAULT 'PENDING',
    "crm_lead_id" VARCHAR(200),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(100),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handovers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reason_code" VARCHAR(100) NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'OPEN',
    "summary" JSONB NOT NULL,
    "assigned_operator_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taken_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "confirmed_summary_hash" VARCHAR(128),
    "confirmed_at" TIMESTAMPTZ(6),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "crm_booking_id" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "provider_event_id" VARCHAR(200) NOT NULL,
    "redacted_payload" JSONB NOT NULL,
    "status" "InboundEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" VARCHAR(200),
    "action" VARCHAR(120) NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" VARCHAR(200) NOT NULL,
    "safe_input_summary" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" VARCHAR(200),
    "correlation_id" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- Custom checks are kept in SQL because Prisma Schema Language cannot express them.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_version_positive_check" CHECK ("version" > 0);

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sequence_positive_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "messages_language_confidence_range_check"
    CHECK ("language_confidence" IS NULL OR "language_confidence" BETWEEN 0 AND 1);

ALTER TABLE "conversation_slots"
  ADD CONSTRAINT "conversation_slots_version_positive_check" CHECK ("version" > 0);

ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_normalizer_version_positive_check"
    CHECK ("normalizer_version" > 0);

ALTER TABLE "catalog_aliases"
  ADD CONSTRAINT "catalog_aliases_normalizer_version_positive_check"
    CHECK ("normalizer_version" > 0);

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_price_nonnegative_check"
    CHECK ("price" IS NULL OR "price" >= 0),
  ADD CONSTRAINT "offers_price_currency_pair_check"
    CHECK (("price" IS NULL) = ("currency" IS NULL)),
  -- ISO 4217 List One membership, mirrored by packages/shared/src/currency-codes.ts.
  ADD CONSTRAINT "offers_currency_iso4217_check"
    CHECK ("currency" IS NULL OR "currency" IN (
      'AED','AFN','ALL','AMD','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BHD','BIF','BMD','BND','BOB','BOV','BRL','BSD','BTN','BWP','BYN','BZD',
      'CAD','CDF','CHE','CHF','CHW','CLF','CLP','CNY','COP','COU','CRC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP',
      'GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR',
      'KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN',
      'MXV','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD',
      'SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX',
      'USD','USN','UYI','UYU','UYW','UZS','VED','VES','VND','VUV','WST','XAD','XAF','XAG','XAU','XBA','XBB','XBC','XBD','XCD','XCG','XDR','XOF','XPD',
      'XPF','XPT','XSU','XTS','XUA','XXX','YER','ZAR','ZMW','ZWG'
    )),
  ADD CONSTRAINT "offers_seats_left_nonnegative_check"
    CHECK ("seats_left" IS NULL OR "seats_left" >= 0),
  ADD CONSTRAINT "offers_validity_window_check"
    CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" > "valid_from"),
  ADD CONSTRAINT "offers_schedule_window_check"
    CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" >= "starts_at");

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_amount_nonnegative_check" CHECK ("amount" >= 0),
  -- ISO 4217 List One membership, mirrored by packages/shared/src/currency-codes.ts.
  ADD CONSTRAINT "quotes_currency_iso4217_check" CHECK ("currency" IN (
      'AED','AFN','ALL','AMD','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BHD','BIF','BMD','BND','BOB','BOV','BRL','BSD','BTN','BWP','BYN','BZD',
      'CAD','CDF','CHE','CHF','CHW','CLF','CLP','CNY','COP','COU','CRC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP',
      'GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR',
      'KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN',
      'MXV','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD',
      'SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX',
      'USD','USN','UYI','UYU','UYW','UZS','VED','VES','VND','VUV','WST','XAD','XAF','XAG','XAU','XBA','XBB','XBC','XBD','XCD','XCG','XDR','XOF','XPD',
      'XPF','XPT','XSU','XTS','XUA','XXX','YER','ZAR','ZMW','ZWG'
  )),
  ADD CONSTRAINT "quotes_valid_until_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "retrieved_at");

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_attempts_nonnegative_check" CHECK ("attempts" >= 0);

ALTER TABLE "handovers"
  ADD CONSTRAINT "handovers_version_positive_check" CHECK ("version" > 0);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempts_nonnegative_check" CHECK ("attempts" >= 0);

-- Provider message IDs can repeat across chats, but not within the same chat.
CREATE UNIQUE INDEX "messages_inbound_provider_key_key"
  ON "messages" ("channel_account_id", "provider_chat_id", "provider_message_id")
  WHERE "direction" = 'INBOUND' AND "provider_message_id" IS NOT NULL;

-- Only one side-effect idempotency key may be persisted for a tenant.
CREATE UNIQUE INDEX "messages_tenant_send_idempotency_key_key"
  ON "messages" ("tenant_id", "send_idempotency_key")
  WHERE "send_idempotency_key" IS NOT NULL;

-- Reopened handovers retain history while only one may be active per conversation.
CREATE UNIQUE INDEX "handovers_one_open_per_conversation_key"
  ON "handovers" ("tenant_id", "conversation_id")
  WHERE "status" IN ('OPEN', 'TAKEN');

-- Audit records are append-only even for direct SQL clients.
CREATE FUNCTION "reject_audit_event_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_audit_event_mutation"();

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenant_connectors_tenant_id_status_idx" ON "tenant_connectors"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_connectors_tenant_id_id_key" ON "tenant_connectors"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_connectors_tenant_id_connector_key_key" ON "tenant_connectors"("tenant_id", "connector_key");

-- CreateIndex
CREATE INDEX "channel_accounts_tenant_id_status_idx" ON "channel_accounts"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_tenant_id_id_key" ON "channel_accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_channel_type_external_account_id_key" ON "channel_accounts"("channel_type", "external_account_id");

-- CreateIndex
CREATE INDEX "operators_tenant_id_is_active_idx" ON "operators"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "operators_tenant_id_id_key" ON "operators"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "operators_tenant_id_telegram_user_id_key" ON "operators"("tenant_id", "telegram_user_id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_phone_idx" ON "contacts"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_id_key" ON "contacts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_channel_account_id_provider_user_id_key" ON "contacts"("tenant_id", "channel_account_id", "provider_user_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_state_updated_at_idx" ON "conversations"("tenant_id", "state", "updated_at");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_contact_id_idx" ON "conversations"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_assigned_operator_id_idx" ON "conversations"("tenant_id", "assigned_operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_id_key" ON "conversations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_channel_account_id_provider_chat_id_key" ON "conversations"("tenant_id", "channel_account_id", "provider_chat_id");

-- CreateIndex
CREATE INDEX "messages_tenant_id_conversation_id_created_at_idx" ON "messages"("tenant_id", "conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_tenant_id_channel_account_id_provider_message_id_idx" ON "messages"("tenant_id", "channel_account_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "messages_tenant_id_send_idempotency_key_idx" ON "messages"("tenant_id", "send_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_id_key" ON "messages"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_conversation_id_sequence_key" ON "messages"("tenant_id", "conversation_id", "sequence");

-- CreateIndex
CREATE INDEX "conversation_slots_tenant_id_conversation_id_idx" ON "conversation_slots"("tenant_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_slots_tenant_id_id_key" ON "conversation_slots"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_slots_tenant_id_conversation_id_version_key" ON "conversation_slots"("tenant_id", "conversation_id", "version");

-- CreateIndex
CREATE INDEX "catalog_items_tenant_id_status_normalized_title_idx" ON "catalog_items"("tenant_id", "status", "normalized_title");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_tenant_id_id_key" ON "catalog_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_tenant_id_source_system_source_entity_id_key" ON "catalog_items"("tenant_id", "source_system", "source_entity_id");

-- CreateIndex
CREATE INDEX "offers_tenant_id_item_id_availability_status_idx" ON "offers"("tenant_id", "item_id", "availability_status");

-- CreateIndex
CREATE INDEX "offers_tenant_id_valid_until_idx" ON "offers"("tenant_id", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "offers_tenant_id_id_key" ON "offers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_tenant_id_source_system_source_entity_id_key" ON "offers"("tenant_id", "source_system", "source_entity_id");

-- CreateIndex
CREATE INDEX "catalog_aliases_tenant_id_normalized_value_idx" ON "catalog_aliases"("tenant_id", "normalized_value");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_aliases_tenant_id_id_key" ON "catalog_aliases"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_aliases_tenant_id_item_id_normalized_value_locale_s_key" ON "catalog_aliases"("tenant_id", "item_id", "normalized_value", "locale", "script");

-- CreateIndex
CREATE INDEX "quotes_tenant_id_conversation_id_created_at_idx" ON "quotes"("tenant_id", "conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_tenant_id_valid_until_idx" ON "quotes"("tenant_id", "valid_until");

-- CreateIndex
CREATE INDEX "quotes_tenant_id_offer_id_idx" ON "quotes"("tenant_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenant_id_id_key" ON "quotes"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_status_score_idx" ON "leads"("tenant_id", "status", "score");

-- CreateIndex
CREATE INDEX "leads_tenant_id_crm_sync_status_updated_at_idx" ON "leads"("tenant_id", "crm_sync_status", "updated_at");

-- CreateIndex
CREATE INDEX "leads_tenant_id_contact_id_idx" ON "leads"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_conversation_id_idx" ON "leads"("tenant_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenant_id_id_key" ON "leads"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenant_id_idempotency_key_key" ON "leads"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "handovers_tenant_id_status_opened_at_idx" ON "handovers"("tenant_id", "status", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "handovers_tenant_id_id_key" ON "handovers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "bookings_tenant_id_status_created_at_idx" ON "bookings"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "bookings_tenant_id_offer_id_idx" ON "bookings"("tenant_id", "offer_id");

-- CreateIndex
CREATE INDEX "bookings_tenant_id_contact_id_idx" ON "bookings"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_tenant_id_id_key" ON "bookings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_tenant_id_idempotency_key_key" ON "bookings"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inbound_events_tenant_id_status_received_at_idx" ON "inbound_events"("tenant_id", "status", "received_at");

-- CreateIndex
CREATE INDEX "inbound_events_tenant_id_expires_at_idx" ON "inbound_events"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_tenant_id_id_key" ON "inbound_events"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_tenant_id_channel_account_id_provider_event__key" ON "inbound_events"("tenant_id", "channel_account_id", "provider_event_id");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_status_available_at_idx" ON "outbox_events"("tenant_id", "status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_aggregate_type_aggregate_id_idx" ON "outbox_events"("tenant_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_id_key" ON "outbox_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_idx" ON "audit_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_entity_type_entity_id_idx" ON "audit_events"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_tenant_id_id_key" ON "audit_events"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "tenant_connectors" ADD CONSTRAINT "tenant_connectors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operators" ADD CONSTRAINT "operators_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_assigned_operator_id_fkey" FOREIGN KEY ("tenant_id", "assigned_operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_slots" ADD CONSTRAINT "conversation_slots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_slots" ADD CONSTRAINT "conversation_slots_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "catalog_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_aliases" ADD CONSTRAINT "catalog_aliases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_aliases" ADD CONSTRAINT "catalog_aliases_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "catalog_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_offer_id_fkey" FOREIGN KEY ("tenant_id", "offer_id") REFERENCES "offers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_shown_in_message_id_fkey" FOREIGN KEY ("tenant_id", "shown_in_message_id") REFERENCES "messages"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_tenant_id_assigned_operator_id_fkey" FOREIGN KEY ("tenant_id", "assigned_operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_offer_id_fkey" FOREIGN KEY ("tenant_id", "offer_id") REFERENCES "offers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
