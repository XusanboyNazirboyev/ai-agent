-- Operator command API credentials (additive; only token hashes are stored).

-- CreateTable
CREATE TABLE "operator_api_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "operator_api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_api_tokens_token_hash_key" ON "operator_api_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "operator_api_tokens_tenant_id_id_key" ON "operator_api_tokens"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "operator_api_tokens_tenant_id_operator_id_idx" ON "operator_api_tokens"("tenant_id", "operator_id");

-- AddForeignKey
ALTER TABLE "operator_api_tokens" ADD CONSTRAINT "operator_api_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_api_tokens" ADD CONSTRAINT "operator_api_tokens_tenant_id_operator_id_fkey" FOREIGN KEY ("tenant_id", "operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
