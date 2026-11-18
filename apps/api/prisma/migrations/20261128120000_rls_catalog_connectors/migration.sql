-- RLS plan S9, catalog, connectors and knowledge domain (ADR 050): tenant isolation policies.
-- Additive; ENABLE, not FORCE: no effect for the owner role (staging
-- today, and the privileged handle).

ALTER TABLE "catalog_aliases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "catalog_aliases";
DROP POLICY IF EXISTS tenant_isolation_insert ON "catalog_aliases";
DROP POLICY IF EXISTS tenant_isolation_update ON "catalog_aliases";
DROP POLICY IF EXISTS tenant_isolation_delete ON "catalog_aliases";
CREATE POLICY tenant_isolation_select ON "catalog_aliases"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "catalog_aliases"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "catalog_aliases"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "catalog_aliases"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalog_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "catalog_items";
DROP POLICY IF EXISTS tenant_isolation_insert ON "catalog_items";
DROP POLICY IF EXISTS tenant_isolation_update ON "catalog_items";
DROP POLICY IF EXISTS tenant_isolation_delete ON "catalog_items";
CREATE POLICY tenant_isolation_select ON "catalog_items"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "catalog_items"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "catalog_items"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "catalog_items"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalog_sync_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "catalog_sync_runs";
DROP POLICY IF EXISTS tenant_isolation_insert ON "catalog_sync_runs";
DROP POLICY IF EXISTS tenant_isolation_update ON "catalog_sync_runs";
DROP POLICY IF EXISTS tenant_isolation_delete ON "catalog_sync_runs";
CREATE POLICY tenant_isolation_select ON "catalog_sync_runs"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "catalog_sync_runs"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "catalog_sync_runs"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "catalog_sync_runs"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "connector_operations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "connector_operations";
DROP POLICY IF EXISTS tenant_isolation_insert ON "connector_operations";
DROP POLICY IF EXISTS tenant_isolation_update ON "connector_operations";
DROP POLICY IF EXISTS tenant_isolation_delete ON "connector_operations";
CREATE POLICY tenant_isolation_select ON "connector_operations"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "connector_operations"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "connector_operations"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "connector_operations"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "connector_secrets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "connector_secrets";
DROP POLICY IF EXISTS tenant_isolation_insert ON "connector_secrets";
DROP POLICY IF EXISTS tenant_isolation_update ON "connector_secrets";
DROP POLICY IF EXISTS tenant_isolation_delete ON "connector_secrets";
CREATE POLICY tenant_isolation_select ON "connector_secrets"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "connector_secrets"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "connector_secrets"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "connector_secrets"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "knowledge_documents";
DROP POLICY IF EXISTS tenant_isolation_insert ON "knowledge_documents";
DROP POLICY IF EXISTS tenant_isolation_update ON "knowledge_documents";
DROP POLICY IF EXISTS tenant_isolation_delete ON "knowledge_documents";
CREATE POLICY tenant_isolation_select ON "knowledge_documents"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "knowledge_documents"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "knowledge_documents"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "knowledge_documents"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "offers";
DROP POLICY IF EXISTS tenant_isolation_insert ON "offers";
DROP POLICY IF EXISTS tenant_isolation_update ON "offers";
DROP POLICY IF EXISTS tenant_isolation_delete ON "offers";
CREATE POLICY tenant_isolation_select ON "offers"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "offers"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "offers"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "offers"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sheet_catalog_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "sheet_catalog_items";
DROP POLICY IF EXISTS tenant_isolation_insert ON "sheet_catalog_items";
DROP POLICY IF EXISTS tenant_isolation_update ON "sheet_catalog_items";
DROP POLICY IF EXISTS tenant_isolation_delete ON "sheet_catalog_items";
CREATE POLICY tenant_isolation_select ON "sheet_catalog_items"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "sheet_catalog_items"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "sheet_catalog_items"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "sheet_catalog_items"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sheet_catalog_offers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "sheet_catalog_offers";
DROP POLICY IF EXISTS tenant_isolation_insert ON "sheet_catalog_offers";
DROP POLICY IF EXISTS tenant_isolation_update ON "sheet_catalog_offers";
DROP POLICY IF EXISTS tenant_isolation_delete ON "sheet_catalog_offers";
CREATE POLICY tenant_isolation_select ON "sheet_catalog_offers"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "sheet_catalog_offers"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "sheet_catalog_offers"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "sheet_catalog_offers"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sheet_catalogs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "sheet_catalogs";
DROP POLICY IF EXISTS tenant_isolation_insert ON "sheet_catalogs";
DROP POLICY IF EXISTS tenant_isolation_update ON "sheet_catalogs";
DROP POLICY IF EXISTS tenant_isolation_delete ON "sheet_catalogs";
CREATE POLICY tenant_isolation_select ON "sheet_catalogs"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "sheet_catalogs"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "sheet_catalogs"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "sheet_catalogs"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_connectors" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "tenant_connectors";
DROP POLICY IF EXISTS tenant_isolation_insert ON "tenant_connectors";
DROP POLICY IF EXISTS tenant_isolation_update ON "tenant_connectors";
DROP POLICY IF EXISTS tenant_isolation_delete ON "tenant_connectors";
CREATE POLICY tenant_isolation_select ON "tenant_connectors"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "tenant_connectors"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "tenant_connectors"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "tenant_connectors"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
