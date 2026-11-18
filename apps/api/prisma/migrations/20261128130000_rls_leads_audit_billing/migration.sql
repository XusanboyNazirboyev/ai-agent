-- RLS plan S9, lead stages, audit, billing and platform audit (ADR 050): tenant isolation policies. Platform audit rows without a tenant are read and written on the privileged handle only.
-- Additive; ENABLE, not FORCE: no effect for the owner role (staging
-- today, and the privileged handle).

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "audit_events";
DROP POLICY IF EXISTS tenant_isolation_insert ON "audit_events";
DROP POLICY IF EXISTS tenant_isolation_update ON "audit_events";
DROP POLICY IF EXISTS tenant_isolation_delete ON "audit_events";
CREATE POLICY tenant_isolation_select ON "audit_events"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "audit_events"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "audit_events"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "audit_events"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "lead_stages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "lead_stages";
DROP POLICY IF EXISTS tenant_isolation_insert ON "lead_stages";
DROP POLICY IF EXISTS tenant_isolation_update ON "lead_stages";
DROP POLICY IF EXISTS tenant_isolation_delete ON "lead_stages";
CREATE POLICY tenant_isolation_select ON "lead_stages"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "lead_stages"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "lead_stages"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "lead_stages"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "platform_audit_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "platform_audit_events";
DROP POLICY IF EXISTS tenant_isolation_insert ON "platform_audit_events";
DROP POLICY IF EXISTS tenant_isolation_update ON "platform_audit_events";
DROP POLICY IF EXISTS tenant_isolation_delete ON "platform_audit_events";
CREATE POLICY tenant_isolation_select ON "platform_audit_events"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "platform_audit_events"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "platform_audit_events"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "platform_audit_events"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "subscription_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "subscription_payments";
DROP POLICY IF EXISTS tenant_isolation_insert ON "subscription_payments";
DROP POLICY IF EXISTS tenant_isolation_update ON "subscription_payments";
DROP POLICY IF EXISTS tenant_isolation_delete ON "subscription_payments";
CREATE POLICY tenant_isolation_select ON "subscription_payments"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "subscription_payments"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "subscription_payments"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "subscription_payments"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "tenant_subscriptions";
DROP POLICY IF EXISTS tenant_isolation_insert ON "tenant_subscriptions";
DROP POLICY IF EXISTS tenant_isolation_update ON "tenant_subscriptions";
DROP POLICY IF EXISTS tenant_isolation_delete ON "tenant_subscriptions";
CREATE POLICY tenant_isolation_select ON "tenant_subscriptions"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "tenant_subscriptions"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "tenant_subscriptions"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "tenant_subscriptions"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
