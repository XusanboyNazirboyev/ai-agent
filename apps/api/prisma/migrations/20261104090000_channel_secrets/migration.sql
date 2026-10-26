-- ADR 028: encrypted per-account channel secrets. Additive only.

-- CreateTable
CREATE TABLE "channel_secrets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "key_id" VARCHAR(40) NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_secrets_tenant_id_channel_account_id_purpose_key" ON "channel_secrets"("tenant_id", "channel_account_id", "purpose");

-- AddForeignKey
ALTER TABLE "channel_secrets" ADD CONSTRAINT "channel_secrets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_secrets" ADD CONSTRAINT "channel_secrets_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
