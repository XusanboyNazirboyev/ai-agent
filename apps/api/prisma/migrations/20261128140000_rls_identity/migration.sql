-- RLS plan S9, identity (ADR 050): tenant isolation policies. Sign-in, sessions, second factors, invite and reset tokens and API tokens are looked up across tenants on the privileged handle (plan S5); platform-admin MFA challenges have no tenant and are only touched there.
-- Additive; ENABLE, not FORCE: no effect for the owner role (staging
-- today, and the privileged handle).

ALTER TABLE "mfa_challenges" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "mfa_challenges";
DROP POLICY IF EXISTS tenant_isolation_insert ON "mfa_challenges";
DROP POLICY IF EXISTS tenant_isolation_update ON "mfa_challenges";
DROP POLICY IF EXISTS tenant_isolation_delete ON "mfa_challenges";
CREATE POLICY tenant_isolation_select ON "mfa_challenges"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "mfa_challenges"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "mfa_challenges"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "mfa_challenges"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "operator_api_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "operator_api_tokens";
DROP POLICY IF EXISTS tenant_isolation_insert ON "operator_api_tokens";
DROP POLICY IF EXISTS tenant_isolation_update ON "operator_api_tokens";
DROP POLICY IF EXISTS tenant_isolation_delete ON "operator_api_tokens";
CREATE POLICY tenant_isolation_select ON "operator_api_tokens"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "operator_api_tokens"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "operator_api_tokens"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "operator_api_tokens"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "operator_credentials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "operator_credentials";
DROP POLICY IF EXISTS tenant_isolation_insert ON "operator_credentials";
DROP POLICY IF EXISTS tenant_isolation_update ON "operator_credentials";
DROP POLICY IF EXISTS tenant_isolation_delete ON "operator_credentials";
CREATE POLICY tenant_isolation_select ON "operator_credentials"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "operator_credentials"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "operator_credentials"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "operator_credentials"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "operator_invites" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "operator_invites";
DROP POLICY IF EXISTS tenant_isolation_insert ON "operator_invites";
DROP POLICY IF EXISTS tenant_isolation_update ON "operator_invites";
DROP POLICY IF EXISTS tenant_isolation_delete ON "operator_invites";
CREATE POLICY tenant_isolation_select ON "operator_invites"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "operator_invites"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "operator_invites"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "operator_invites"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "operator_password_resets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "operator_password_resets";
DROP POLICY IF EXISTS tenant_isolation_insert ON "operator_password_resets";
DROP POLICY IF EXISTS tenant_isolation_update ON "operator_password_resets";
DROP POLICY IF EXISTS tenant_isolation_delete ON "operator_password_resets";
CREATE POLICY tenant_isolation_select ON "operator_password_resets"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "operator_password_resets"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "operator_password_resets"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "operator_password_resets"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "operator_sessions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "operator_sessions";
DROP POLICY IF EXISTS tenant_isolation_insert ON "operator_sessions";
DROP POLICY IF EXISTS tenant_isolation_update ON "operator_sessions";
DROP POLICY IF EXISTS tenant_isolation_delete ON "operator_sessions";
CREATE POLICY tenant_isolation_select ON "operator_sessions"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "operator_sessions"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "operator_sessions"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "operator_sessions"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "operators" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "operators";
DROP POLICY IF EXISTS tenant_isolation_insert ON "operators";
DROP POLICY IF EXISTS tenant_isolation_update ON "operators";
DROP POLICY IF EXISTS tenant_isolation_delete ON "operators";
CREATE POLICY tenant_isolation_select ON "operators"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "operators"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "operators"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "operators"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
