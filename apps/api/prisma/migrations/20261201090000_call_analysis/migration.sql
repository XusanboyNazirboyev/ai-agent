-- ADR 085: call analysis for OnlinePBX recordings (telephony account + calls).
-- CreateEnum
CREATE TYPE "TelephonyProvider" AS ENUM ('ONLINEPBX');

-- CreateEnum
CREATE TYPE "CallRecordingStatus" AS ENUM ('PENDING', 'ANALYSED', 'SKIPPED_LIMIT', 'FAILED');

-- CreateTable
CREATE TABLE "telephony_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "api_key_key_id" VARCHAR(40) NOT NULL,
    "api_key_nonce" BYTEA NOT NULL,
    "api_key_cipher" BYTEA NOT NULL,
    "polled_until" TIMESTAMPTZ(6),
    "last_error" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "telephony_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_recordings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "telephony_account_id" UUID NOT NULL,
    "provider_call_id" VARCHAR(100) NOT NULL,
    "direction" VARCHAR(20) NOT NULL,
    "customer_phone" VARCHAR(40),
    "internal_number" VARCHAR(40),
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6) NOT NULL,
    "talk_seconds" INTEGER NOT NULL,
    "status" "CallRecordingStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" VARCHAR(200),
    "audio_key" VARCHAR(300),
    "audio_delete_after" TIMESTAMPTZ(6),
    "transcript" JSONB,
    "summary" TEXT,
    "next_step" TEXT,
    "analysed_at" TIMESTAMPTZ(6),
    "contact_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telephony_accounts_tenant_id_id_key" ON "telephony_accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_accounts_tenant_id_provider_key" ON "telephony_accounts"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "call_recordings_tenant_id_contact_id_started_at_idx" ON "call_recordings"("tenant_id", "contact_id", "started_at");

-- CreateIndex
CREATE INDEX "call_recordings_tenant_id_started_at_idx" ON "call_recordings"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "call_recordings_tenant_id_status_idx" ON "call_recordings"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "call_recordings_tenant_id_telephony_account_id_provider_cal_key" ON "call_recordings"("tenant_id", "telephony_account_id", "provider_call_id");

-- AddForeignKey
ALTER TABLE "telephony_accounts" ADD CONSTRAINT "telephony_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_tenant_id_telephony_account_id_fkey" FOREIGN KEY ("tenant_id", "telephony_account_id") REFERENCES "telephony_accounts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Row level security (ADR 050), same four policies as every tenant table.
ALTER TABLE "telephony_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON "telephony_accounts"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "telephony_accounts"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "telephony_accounts"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "telephony_accounts"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Row level security (ADR 050), same four policies as every tenant table.
ALTER TABLE "call_recordings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON "call_recordings"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "call_recordings"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "call_recordings"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "call_recordings"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
