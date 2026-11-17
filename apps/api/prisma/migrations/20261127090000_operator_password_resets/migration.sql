-- ADR 047 amendment 2026-11-17: one-time password reset links (additive).
CREATE TABLE "operator_password_resets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_by_platform_admin_id" UUID,
    "created_by_operator_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_password_resets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_password_resets_token_hash_key" ON "operator_password_resets"("token_hash");

CREATE INDEX "operator_password_resets_tenant_id_operator_id_idx" ON "operator_password_resets"("tenant_id", "operator_id");

ALTER TABLE "operator_password_resets" ADD CONSTRAINT "operator_password_resets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
