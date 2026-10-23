-- Phase 5: operator handover, leads, offers shown (additive, ADR 018).

-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN "operator_chat_id" VARCHAR(200);

-- AlterTable
ALTER TABLE "handovers"
  ADD COLUMN "operator_chat_id" VARCHAR(200),
  ADD COLUMN "operator_message_id" VARCHAR(100),
  ADD COLUMN "notified_at" TIMESTAMPTZ(6),
  ADD COLUMN "notification_error_code" VARCHAR(100),
  ADD COLUMN "sla_due_at" TIMESTAMPTZ(6),
  ADD COLUMN "sla_alerted_at" TIMESTAMPTZ(6),
  ADD COLUMN "customer_notice_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "leads"
  ADD COLUMN "requirements" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "agent_turns"
  ADD COLUMN "shown_fact_ids" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "asked_slot" VARCHAR(100),
  ADD COLUMN "slots_filled" INTEGER,
  ADD COLUMN "text_fingerprint" VARCHAR(64);

-- CreateTable
CREATE TABLE "internal_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shown_offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "offer_ref" VARCHAR(300) NOT NULL,
    "offer_id" UUID,
    "facts" JSONB NOT NULL,
    "quote_recorded" BOOLEAN NOT NULL DEFAULT false,
    "quote_skip_reason" VARCHAR(100),
    "shown_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shown_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "handovers_tenant_id_operator_chat_id_operator_message_id_key" ON "handovers"("tenant_id", "operator_chat_id", "operator_message_id");

-- CreateIndex
CREATE INDEX "handovers_status_sla_due_at_idx" ON "handovers"("status", "sla_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenant_id_shown_in_message_id_offer_id_key" ON "quotes"("tenant_id", "shown_in_message_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "internal_notes_tenant_id_id_key" ON "internal_notes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "internal_notes_tenant_id_idempotency_key_key" ON "internal_notes"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "internal_notes_tenant_id_conversation_id_created_at_idx" ON "internal_notes"("tenant_id", "conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shown_offers_tenant_id_id_key" ON "shown_offers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shown_offers_tenant_id_message_id_offer_ref_key" ON "shown_offers"("tenant_id", "message_id", "offer_ref");

-- CreateIndex
CREATE INDEX "shown_offers_tenant_id_conversation_id_shown_at_idx" ON "shown_offers"("tenant_id", "conversation_id", "shown_at");

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shown_offers" ADD CONSTRAINT "shown_offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shown_offers" ADD CONSTRAINT "shown_offers_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten invariants (not expressible in Prisma).
-- An operator command (action + idempotency key) is recorded once per tenant.
CREATE UNIQUE INDEX "audit_events_tenant_action_idempotency_key"
  ON "audit_events"("tenant_id", "action", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
