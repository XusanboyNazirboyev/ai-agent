-- RLS plan S9, channels and outbox domain (ADR 050): tenant isolation policies.
-- Additive; ENABLE, not FORCE: no effect for the owner role (staging
-- today, and the privileged handle).

ALTER TABLE "channel_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "channel_accounts";
DROP POLICY IF EXISTS tenant_isolation_insert ON "channel_accounts";
DROP POLICY IF EXISTS tenant_isolation_update ON "channel_accounts";
DROP POLICY IF EXISTS tenant_isolation_delete ON "channel_accounts";
CREATE POLICY tenant_isolation_select ON "channel_accounts"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "channel_accounts"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "channel_accounts"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "channel_accounts"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "channel_secrets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "channel_secrets";
DROP POLICY IF EXISTS tenant_isolation_insert ON "channel_secrets";
DROP POLICY IF EXISTS tenant_isolation_update ON "channel_secrets";
DROP POLICY IF EXISTS tenant_isolation_delete ON "channel_secrets";
CREATE POLICY tenant_isolation_select ON "channel_secrets"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "channel_secrets"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "channel_secrets"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "channel_secrets"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inbound_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "inbound_events";
DROP POLICY IF EXISTS tenant_isolation_insert ON "inbound_events";
DROP POLICY IF EXISTS tenant_isolation_update ON "inbound_events";
DROP POLICY IF EXISTS tenant_isolation_delete ON "inbound_events";
CREATE POLICY tenant_isolation_select ON "inbound_events"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "inbound_events"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "inbound_events"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "inbound_events"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inbox_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "inbox_events";
DROP POLICY IF EXISTS tenant_isolation_insert ON "inbox_events";
DROP POLICY IF EXISTS tenant_isolation_update ON "inbox_events";
DROP POLICY IF EXISTS tenant_isolation_delete ON "inbox_events";
CREATE POLICY tenant_isolation_select ON "inbox_events"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "inbox_events"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "inbox_events"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "inbox_events"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "instagram_comments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "instagram_comments";
DROP POLICY IF EXISTS tenant_isolation_insert ON "instagram_comments";
DROP POLICY IF EXISTS tenant_isolation_update ON "instagram_comments";
DROP POLICY IF EXISTS tenant_isolation_delete ON "instagram_comments";
CREATE POLICY tenant_isolation_select ON "instagram_comments"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "instagram_comments"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "instagram_comments"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "instagram_comments"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "outbox_events";
DROP POLICY IF EXISTS tenant_isolation_insert ON "outbox_events";
DROP POLICY IF EXISTS tenant_isolation_update ON "outbox_events";
DROP POLICY IF EXISTS tenant_isolation_delete ON "outbox_events";
CREATE POLICY tenant_isolation_select ON "outbox_events"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "outbox_events"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "outbox_events"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "outbox_events"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
