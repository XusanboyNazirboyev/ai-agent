-- ADR 032: encrypted per-connector secrets (e.g. a Bitrix24 incoming-webhook URL). Additive only.

-- CreateTable
CREATE TABLE "connector_secrets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tenant_connector_id" UUID NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "key_id" VARCHAR(40) NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "connector_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_secrets_tenant_id_tenant_connector_id_purpose_key" ON "connector_secrets"("tenant_id", "tenant_connector_id", "purpose");

-- AddForeignKey
ALTER TABLE "connector_secrets" ADD CONSTRAINT "connector_secrets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_secrets" ADD CONSTRAINT "connector_secrets_tenant_id_tenant_connector_id_fkey" FOREIGN KEY ("tenant_id", "tenant_connector_id") REFERENCES "tenant_connectors"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
