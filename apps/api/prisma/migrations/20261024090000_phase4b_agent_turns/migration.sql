-- Phase 4B: agent mode per channel account, agent turn records, durable
-- handover idempotency and notification state (additive only).

-- CreateEnum
CREATE TYPE "AgentMode" AS ENUM ('OFF', 'SHADOW', 'LIVE');

-- CreateEnum
CREATE TYPE "AgentTurnStatus" AS ENUM ('COMPUTING', 'COMMITTED', 'DISCARDED', 'ABANDONED', 'FAILED');

-- CreateEnum
CREATE TYPE "HandoverNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN     "agent_mode" "AgentMode" NOT NULL DEFAULT 'OFF';

-- AlterTable
ALTER TABLE "handovers" ADD COLUMN     "idempotency_key" VARCHAR(200),
ADD COLUMN     "notification_status" "HandoverNotificationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "agent_turns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "mode" "AgentMode" NOT NULL,
    "status" "AgentTurnStatus" NOT NULL DEFAULT 'COMPUTING',
    "claim_token" VARCHAR(200) NOT NULL,
    "lease_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "answered_sequence" INTEGER NOT NULL,
    "conversation_version" INTEGER NOT NULL,
    "inbound_event_ids" TEXT[],
    "correlation_id" VARCHAR(100) NOT NULL,
    "outcome" VARCHAR(40),
    "handover_reason" VARCHAR(100),
    "discard_reason" VARCHAR(40),
    "failure_code" VARCHAR(100),
    "locale" VARCHAR(16),
    "provider" VARCHAR(40),
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "llm_calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_nano_usd" BIGINT NOT NULL DEFAULT 0,
    "actual_cost_nano_usd" BIGINT NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "guardrail" JSONB NOT NULL DEFAULT '{}',
    "facts" JSONB NOT NULL DEFAULT '[]',
    "draft_text" TEXT,
    "reply_message_id" UUID,
    "handover_id" UUID,
    "pricing_version" VARCHAR(64),
    "prompt_version" VARCHAR(64),
    "pack_ref" VARCHAR(170),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_turns_tenant_id_conversation_id_status_idx" ON "agent_turns"("tenant_id", "conversation_id", "status");

-- CreateIndex
CREATE INDEX "agent_turns_status_lease_expires_at_idx" ON "agent_turns"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_turns_tenant_id_id_key" ON "agent_turns"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_turns_tenant_id_idempotency_key_attempt_key" ON "agent_turns"("tenant_id", "idempotency_key", "attempt");

-- CreateIndex
CREATE INDEX "handovers_tenant_id_notification_status_idx" ON "handovers"("tenant_id", "notification_status");

-- CreateIndex
CREATE UNIQUE INDEX "handovers_tenant_id_idempotency_key_key" ON "handovers"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Handwritten invariants (not expressible in Prisma).

-- At most one in-flight turn per conversation, and at most one committed
-- answer per (conversation, answered inbound sequence).
CREATE UNIQUE INDEX "agent_turns_one_computing_per_conversation"
  ON "agent_turns"("tenant_id", "conversation_id") WHERE "status" = 'COMPUTING';
CREATE UNIQUE INDEX "agent_turns_one_committed_per_key"
  ON "agent_turns"("tenant_id", "idempotency_key") WHERE "status" = 'COMMITTED';

ALTER TABLE "agent_turns"
  ADD CONSTRAINT "agent_turns_attempt_positive_check" CHECK ("attempt" >= 1),
  ADD CONSTRAINT "agent_turns_counts_nonnegative_check" CHECK (
    "answered_sequence" >= 1 AND "llm_calls" >= 0 AND "input_tokens" >= 0
    AND "output_tokens" >= 0 AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
  ),
  ADD CONSTRAINT "agent_turns_cost_nonnegative_check"
    CHECK ("estimated_cost_nano_usd" >= 0 AND "actual_cost_nano_usd" >= 0),
  ADD CONSTRAINT "agent_turns_json_shapes_check" CHECK (
    jsonb_typeof("tool_calls") = 'array' AND jsonb_typeof("facts") = 'array'
    AND jsonb_typeof("guardrail") = 'object'
  );
