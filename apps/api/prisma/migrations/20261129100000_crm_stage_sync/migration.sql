-- ADR 079: stage sync from the connected CRM. Additive.
CREATE TABLE "crm_stage_syncs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tenant_connector_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cursor_at" TIMESTAMPTZ(6),
    "last_run_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(100),
    "lease_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "crm_stage_syncs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_stage_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tenant_connector_id" UUID NOT NULL,
    "external_stage_id" VARCHAR(100) NOT NULL,
    "external_stage_name" VARCHAR(200) NOT NULL,
    "lead_stage_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "crm_stage_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_stage_syncs_tenant_id_tenant_connector_id_key" ON "crm_stage_syncs"("tenant_id", "tenant_connector_id");
CREATE INDEX "crm_stage_syncs_enabled_lease_until_idx" ON "crm_stage_syncs"("enabled", "lease_until");
CREATE UNIQUE INDEX "crm_stage_mappings_tenant_id_tenant_connector_id_external_s_key" ON "crm_stage_mappings"("tenant_id", "tenant_connector_id", "external_stage_id");
CREATE INDEX "crm_stage_mappings_tenant_id_lead_stage_id_idx" ON "crm_stage_mappings"("tenant_id", "lead_stage_id");

ALTER TABLE "crm_stage_syncs" ADD CONSTRAINT "crm_stage_syncs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_syncs" ADD CONSTRAINT "crm_stage_syncs_tenant_id_tenant_connector_id_fkey" FOREIGN KEY ("tenant_id", "tenant_connector_id") REFERENCES "tenant_connectors"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_mappings" ADD CONSTRAINT "crm_stage_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_mappings" ADD CONSTRAINT "crm_stage_mappings_tenant_id_tenant_connector_id_fkey" FOREIGN KEY ("tenant_id", "tenant_connector_id") REFERENCES "tenant_connectors"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_mappings" ADD CONSTRAINT "crm_stage_mappings_tenant_id_lead_stage_id_fkey" FOREIGN KEY ("tenant_id", "lead_stage_id") REFERENCES "lead_stages"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_stage_syncs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "crm_stage_syncs";
DROP POLICY IF EXISTS tenant_isolation_insert ON "crm_stage_syncs";
DROP POLICY IF EXISTS tenant_isolation_update ON "crm_stage_syncs";
DROP POLICY IF EXISTS tenant_isolation_delete ON "crm_stage_syncs";
CREATE POLICY tenant_isolation_select ON "crm_stage_syncs"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "crm_stage_syncs"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "crm_stage_syncs"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "crm_stage_syncs"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "crm_stage_mappings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "crm_stage_mappings";
DROP POLICY IF EXISTS tenant_isolation_insert ON "crm_stage_mappings";
DROP POLICY IF EXISTS tenant_isolation_update ON "crm_stage_mappings";
DROP POLICY IF EXISTS tenant_isolation_delete ON "crm_stage_mappings";
CREATE POLICY tenant_isolation_select ON "crm_stage_mappings"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "crm_stage_mappings"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "crm_stage_mappings"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "crm_stage_mappings"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
