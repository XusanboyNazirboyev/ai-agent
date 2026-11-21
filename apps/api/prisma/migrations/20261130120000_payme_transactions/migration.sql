-- ADR 084: Payme Merchant API transactions of subscription payments.
ALTER TYPE "PaymentProvider" ADD VALUE 'PAYME';

CREATE TABLE "payme_transactions" (
    "id" VARCHAR(24) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "payme_time" BIGINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "state" INTEGER NOT NULL,
    "reason" INTEGER,
    "create_time" BIGINT NOT NULL,
    "perform_time" BIGINT NOT NULL DEFAULT 0,
    "cancel_time" BIGINT NOT NULL DEFAULT 0,
    "entitlement_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payme_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payme_transactions_payment_id_key" ON "payme_transactions"("payment_id");
CREATE INDEX "payme_transactions_tenant_id_payme_time_idx" ON "payme_transactions"("tenant_id", "payme_time");

ALTER TABLE "payme_transactions" ADD CONSTRAINT "payme_transactions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payme_transactions" ADD CONSTRAINT "payme_transactions_tenant_id_payment_id_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "subscription_payments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payme_transactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON "payme_transactions"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "payme_transactions"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "payme_transactions"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "payme_transactions"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
