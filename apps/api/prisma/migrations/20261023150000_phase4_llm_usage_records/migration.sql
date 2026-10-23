-- Phase 4: per-request LLM usage ledger for cost accounting (additive).

-- CreateTable
CREATE TABLE "llm_usage_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID,
    "turn_key" VARCHAR(200) NOT NULL,
    "call_index" INTEGER NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,
    "tier" VARCHAR(10) NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "response_id" VARCHAR(200) NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL,
    "cache_write_5m_tokens" INTEGER NOT NULL,
    "cache_write_1h_tokens" INTEGER NOT NULL,
    "reasoning_tokens" INTEGER,
    "cost_nano_usd" BIGINT NOT NULL,
    "reserved_nano_usd" BIGINT NOT NULL,
    "pricing_version" VARCHAR(64) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "outcome" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_usage_records_tenant_id_conversation_id_idx" ON "llm_usage_records"("tenant_id", "conversation_id");

-- CreateIndex
CREATE INDEX "llm_usage_records_tenant_id_created_at_idx" ON "llm_usage_records"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "llm_usage_records_tenant_id_id_key" ON "llm_usage_records"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_usage_records_tenant_id_provider_response_id_key" ON "llm_usage_records"("tenant_id", "provider", "response_id");

-- AddForeignKey
ALTER TABLE "llm_usage_records" ADD CONSTRAINT "llm_usage_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Handwritten invariants (not expressible in Prisma).
ALTER TABLE "llm_usage_records"
  ADD CONSTRAINT "llm_usage_records_tokens_nonnegative_check" CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0
    AND "cache_write_5m_tokens" >= 0 AND "cache_write_1h_tokens" >= 0
    AND ("reasoning_tokens" IS NULL OR "reasoning_tokens" >= 0)
  ),
  ADD CONSTRAINT "llm_usage_records_cost_nonnegative_check"
    CHECK ("cost_nano_usd" >= 0 AND "reserved_nano_usd" >= 0),
  ADD CONSTRAINT "llm_usage_records_attempts_positive_check" CHECK ("attempts" >= 1),
  ADD CONSTRAINT "llm_usage_records_call_index_nonnegative_check" CHECK ("call_index" >= 0);
