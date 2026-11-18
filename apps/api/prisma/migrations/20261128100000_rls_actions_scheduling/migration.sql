-- RLS plan S9, actions and scheduling domain (ADR 050): tenant isolation policies.
-- Additive; ENABLE, not FORCE: no effect for the owner role (staging
-- today, and the privileged handle).

ALTER TABLE "action_proposals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "action_proposals";
DROP POLICY IF EXISTS tenant_isolation_insert ON "action_proposals";
DROP POLICY IF EXISTS tenant_isolation_update ON "action_proposals";
DROP POLICY IF EXISTS tenant_isolation_delete ON "action_proposals";
CREATE POLICY tenant_isolation_select ON "action_proposals"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "action_proposals"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "action_proposals"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "action_proposals"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "appointments";
DROP POLICY IF EXISTS tenant_isolation_insert ON "appointments";
DROP POLICY IF EXISTS tenant_isolation_update ON "appointments";
DROP POLICY IF EXISTS tenant_isolation_delete ON "appointments";
CREATE POLICY tenant_isolation_select ON "appointments"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "appointments"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "appointments"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "appointments"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "availability_exceptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "availability_exceptions";
DROP POLICY IF EXISTS tenant_isolation_insert ON "availability_exceptions";
DROP POLICY IF EXISTS tenant_isolation_update ON "availability_exceptions";
DROP POLICY IF EXISTS tenant_isolation_delete ON "availability_exceptions";
CREATE POLICY tenant_isolation_select ON "availability_exceptions"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "availability_exceptions"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "availability_exceptions"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "availability_exceptions"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "availability_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "availability_rules";
DROP POLICY IF EXISTS tenant_isolation_insert ON "availability_rules";
DROP POLICY IF EXISTS tenant_isolation_update ON "availability_rules";
DROP POLICY IF EXISTS tenant_isolation_delete ON "availability_rules";
CREATE POLICY tenant_isolation_select ON "availability_rules"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "availability_rules"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "availability_rules"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "availability_rules"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "bookings";
DROP POLICY IF EXISTS tenant_isolation_insert ON "bookings";
DROP POLICY IF EXISTS tenant_isolation_update ON "bookings";
DROP POLICY IF EXISTS tenant_isolation_delete ON "bookings";
CREATE POLICY tenant_isolation_select ON "bookings"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "bookings"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "bookings"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "bookings"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "service_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "service_types";
DROP POLICY IF EXISTS tenant_isolation_insert ON "service_types";
DROP POLICY IF EXISTS tenant_isolation_update ON "service_types";
DROP POLICY IF EXISTS tenant_isolation_delete ON "service_types";
CREATE POLICY tenant_isolation_select ON "service_types"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "service_types"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "service_types"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "service_types"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "staff_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "staff_members";
DROP POLICY IF EXISTS tenant_isolation_insert ON "staff_members";
DROP POLICY IF EXISTS tenant_isolation_update ON "staff_members";
DROP POLICY IF EXISTS tenant_isolation_delete ON "staff_members";
CREATE POLICY tenant_isolation_select ON "staff_members"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "staff_members"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "staff_members"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "staff_members"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
