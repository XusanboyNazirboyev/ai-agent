-- ADR 024: customer-confirmed business-action proposals. Additive only.

-- CreateEnum
CREATE TYPE "ActionProposalStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'DECLINED', 'SUPERSEDED', 'EXPIRED', 'CANCELLED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "action_key" VARCHAR(41) NOT NULL,
    "operation" VARCHAR(40) NOT NULL,
    "pack_ref" VARCHAR(100) NOT NULL,
    "payload" JSONB,
    "digest" VARCHAR(64) NOT NULL,
    "status" "ActionProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "proposed_turn_key" VARCHAR(200) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "outcome_at" TIMESTAMPTZ(6),
    "external_id" VARCHAR(200),
    "error_code" VARCHAR(100),
    "payload_cleared_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_proposals_tenant_id_conversation_id_status_idx" ON "action_proposals"("tenant_id", "conversation_id", "status");

-- CreateIndex
CREATE INDEX "action_proposals_status_expires_at_idx" ON "action_proposals"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_tenant_id_id_key" ON "action_proposals"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten invariants: at most one open proposal per conversation; one
-- proposal per proposing turn; success needs evidence.
CREATE UNIQUE INDEX "action_proposals_one_open_per_conversation"
  ON "action_proposals"("tenant_id", "conversation_id") WHERE "status" = 'PROPOSED';
CREATE UNIQUE INDEX "action_proposals_proposed_turn_key_key"
  ON "action_proposals"("tenant_id", "proposed_turn_key");
ALTER TABLE "action_proposals"
  ADD CONSTRAINT "action_proposals_success_evidence_check"
    CHECK ("status" <> 'SUCCEEDED' OR "external_id" IS NOT NULL);
