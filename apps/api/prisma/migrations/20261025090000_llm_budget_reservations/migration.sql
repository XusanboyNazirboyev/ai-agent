-- Atomic tenant-month LLM budget reservations (additive, ADR 014).

-- CreateTable
CREATE TABLE "llm_budget_reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID,
    "base_invocation_id" VARCHAR(200) NOT NULL,
    "invocation_id" VARCHAR(210) NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "reserved_nano_usd" BIGINT NOT NULL,
    "reserved_tokens" BIGINT NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "llm_budget_reservations_tenant_id_invocation_id_key" ON "llm_budget_reservations"("tenant_id", "invocation_id");

-- CreateIndex
CREATE INDEX "llm_budget_reservations_tenant_id_period_start_state_idx" ON "llm_budget_reservations"("tenant_id", "period_start", "state");

-- CreateIndex
CREATE INDEX "llm_budget_reservations_tenant_id_conversation_id_state_idx" ON "llm_budget_reservations"("tenant_id", "conversation_id", "state");

-- CreateIndex
CREATE INDEX "llm_budget_reservations_tenant_id_base_invocation_id_idx" ON "llm_budget_reservations"("tenant_id", "base_invocation_id");

-- AddForeignKey
ALTER TABLE "llm_budget_reservations" ADD CONSTRAINT "llm_budget_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten invariants (not expressible in Prisma).
ALTER TABLE "llm_budget_reservations"
  ADD CONSTRAINT "llm_budget_reservations_state_check"
    CHECK ("state" IN ('RESERVED', 'UNKNOWN', 'SETTLED', 'RELEASED')),
  ADD CONSTRAINT "llm_budget_reservations_amounts_nonnegative_check"
    CHECK ("reserved_nano_usd" >= 0 AND "reserved_tokens" >= 0);
