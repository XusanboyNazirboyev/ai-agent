-- ADR 082: Click Shop API transactions of subscription payments.
-- CreateEnum
CREATE TYPE "ClickTransactionState" AS ENUM ('PREPARED', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "click_transactions" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "click_trans_id" BIGINT NOT NULL,
    "click_paydoc_id" BIGINT,
    "state" "ClickTransactionState" NOT NULL DEFAULT 'PREPARED',
    "prepared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "click_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "click_transactions_click_trans_id_key" ON "click_transactions"("click_trans_id");
CREATE INDEX "click_transactions_tenant_id_payment_id_idx" ON "click_transactions"("tenant_id", "payment_id");

-- AddForeignKey
ALTER TABLE "click_transactions" ADD CONSTRAINT "click_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "click_transactions" ADD CONSTRAINT "click_transactions_tenant_id_payment_id_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "subscription_payments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security (ADR 050), same four policies as every tenant table.
ALTER TABLE "click_transactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON "click_transactions"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "click_transactions"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "click_transactions"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "click_transactions"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
