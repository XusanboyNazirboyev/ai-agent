-- ADR 050 / P0.7: enable RLS on six highest-risk tenant tables (defence in depth).
-- Additive: policies restrict access when app.tenant_id is set; table owner still
-- bypasses RLS unless FORCE is applied and role is tightened (ops follow-up).

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "handovers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON "contacts";
DROP POLICY IF EXISTS tenant_isolation_insert ON "contacts";
DROP POLICY IF EXISTS tenant_isolation_update ON "contacts";
DROP POLICY IF EXISTS tenant_isolation_delete ON "contacts";
CREATE POLICY tenant_isolation_select ON "contacts"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "contacts"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "contacts"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "contacts"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_select ON "conversations";
DROP POLICY IF EXISTS tenant_isolation_insert ON "conversations";
DROP POLICY IF EXISTS tenant_isolation_update ON "conversations";
DROP POLICY IF EXISTS tenant_isolation_delete ON "conversations";
CREATE POLICY tenant_isolation_select ON "conversations"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "conversations"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "conversations"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "conversations"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_select ON "messages";
DROP POLICY IF EXISTS tenant_isolation_insert ON "messages";
DROP POLICY IF EXISTS tenant_isolation_update ON "messages";
DROP POLICY IF EXISTS tenant_isolation_delete ON "messages";
CREATE POLICY tenant_isolation_select ON "messages"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "messages"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "messages"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "messages"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_select ON "leads";
DROP POLICY IF EXISTS tenant_isolation_insert ON "leads";
DROP POLICY IF EXISTS tenant_isolation_update ON "leads";
DROP POLICY IF EXISTS tenant_isolation_delete ON "leads";
CREATE POLICY tenant_isolation_select ON "leads"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "leads"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "leads"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "leads"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_select ON "handovers";
DROP POLICY IF EXISTS tenant_isolation_insert ON "handovers";
DROP POLICY IF EXISTS tenant_isolation_update ON "handovers";
DROP POLICY IF EXISTS tenant_isolation_delete ON "handovers";
CREATE POLICY tenant_isolation_select ON "handovers"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "handovers"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "handovers"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "handovers"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_select ON "knowledge_chunks";
DROP POLICY IF EXISTS tenant_isolation_insert ON "knowledge_chunks";
DROP POLICY IF EXISTS tenant_isolation_update ON "knowledge_chunks";
DROP POLICY IF EXISTS tenant_isolation_delete ON "knowledge_chunks";
CREATE POLICY tenant_isolation_select ON "knowledge_chunks"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "knowledge_chunks"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "knowledge_chunks"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "knowledge_chunks"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
