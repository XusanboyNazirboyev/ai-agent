-- Tags on conversations (roadmap P1.8, ADR 071). Additive. The same tag
-- dictionary as people and leads (ADR 053).
CREATE TABLE "conversation_tags" (
  "tenant_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_tags_pkey" PRIMARY KEY ("tenant_id","conversation_id","tag_id")
);
CREATE INDEX "conversation_tags_tenant_id_tag_id_idx" ON "conversation_tags"("tenant_id", "tag_id");
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_tenant_id_tag_id_fkey" FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "tags"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation policies (ADR 050) for this table and the two tables added
-- on 2026-11-25 without them. ENABLE, not FORCE: no effect for the owner role.
ALTER TABLE "conversation_tags" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "conversation_tags";
DROP POLICY IF EXISTS tenant_isolation_insert ON "conversation_tags";
DROP POLICY IF EXISTS tenant_isolation_update ON "conversation_tags";
DROP POLICY IF EXISTS tenant_isolation_delete ON "conversation_tags";
CREATE POLICY tenant_isolation_select ON "conversation_tags"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "conversation_tags"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "conversation_tags"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "conversation_tags"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "lead_tasks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "lead_tasks";
DROP POLICY IF EXISTS tenant_isolation_insert ON "lead_tasks";
DROP POLICY IF EXISTS tenant_isolation_update ON "lead_tasks";
DROP POLICY IF EXISTS tenant_isolation_delete ON "lead_tasks";
CREATE POLICY tenant_isolation_select ON "lead_tasks"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "lead_tasks"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "lead_tasks"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "lead_tasks"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "canned_responses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "canned_responses";
DROP POLICY IF EXISTS tenant_isolation_insert ON "canned_responses";
DROP POLICY IF EXISTS tenant_isolation_update ON "canned_responses";
DROP POLICY IF EXISTS tenant_isolation_delete ON "canned_responses";
CREATE POLICY tenant_isolation_select ON "canned_responses"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "canned_responses"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "canned_responses"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "canned_responses"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
