-- RLS plan S9, agent domain (ADR 050): tenant isolation policies on the
-- agent's own tables. Additive; ENABLE, not FORCE: no effect for the owner
-- role (staging today, and the privileged handle).

ALTER TABLE "agent_turns" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "agent_turns";
DROP POLICY IF EXISTS tenant_isolation_insert ON "agent_turns";
DROP POLICY IF EXISTS tenant_isolation_update ON "agent_turns";
DROP POLICY IF EXISTS tenant_isolation_delete ON "agent_turns";
CREATE POLICY tenant_isolation_select ON "agent_turns"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "agent_turns"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "agent_turns"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "agent_turns"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "conversation_slots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "conversation_slots";
DROP POLICY IF EXISTS tenant_isolation_insert ON "conversation_slots";
DROP POLICY IF EXISTS tenant_isolation_update ON "conversation_slots";
DROP POLICY IF EXISTS tenant_isolation_delete ON "conversation_slots";
CREATE POLICY tenant_isolation_select ON "conversation_slots"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "conversation_slots"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "conversation_slots"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "conversation_slots"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "shown_offers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "shown_offers";
DROP POLICY IF EXISTS tenant_isolation_insert ON "shown_offers";
DROP POLICY IF EXISTS tenant_isolation_update ON "shown_offers";
DROP POLICY IF EXISTS tenant_isolation_delete ON "shown_offers";
CREATE POLICY tenant_isolation_select ON "shown_offers"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "shown_offers"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "shown_offers"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "shown_offers"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "quotes";
DROP POLICY IF EXISTS tenant_isolation_insert ON "quotes";
DROP POLICY IF EXISTS tenant_isolation_update ON "quotes";
DROP POLICY IF EXISTS tenant_isolation_delete ON "quotes";
CREATE POLICY tenant_isolation_select ON "quotes"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "quotes"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "quotes"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "quotes"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "internal_notes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "internal_notes";
DROP POLICY IF EXISTS tenant_isolation_insert ON "internal_notes";
DROP POLICY IF EXISTS tenant_isolation_update ON "internal_notes";
DROP POLICY IF EXISTS tenant_isolation_delete ON "internal_notes";
CREATE POLICY tenant_isolation_select ON "internal_notes"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "internal_notes"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "internal_notes"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "internal_notes"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "follow_ups" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "follow_ups";
DROP POLICY IF EXISTS tenant_isolation_insert ON "follow_ups";
DROP POLICY IF EXISTS tenant_isolation_update ON "follow_ups";
DROP POLICY IF EXISTS tenant_isolation_delete ON "follow_ups";
CREATE POLICY tenant_isolation_select ON "follow_ups"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "follow_ups"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "follow_ups"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "follow_ups"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "llm_usage_records" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "llm_usage_records";
DROP POLICY IF EXISTS tenant_isolation_insert ON "llm_usage_records";
DROP POLICY IF EXISTS tenant_isolation_update ON "llm_usage_records";
DROP POLICY IF EXISTS tenant_isolation_delete ON "llm_usage_records";
CREATE POLICY tenant_isolation_select ON "llm_usage_records"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "llm_usage_records"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "llm_usage_records"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "llm_usage_records"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "llm_budget_reservations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "llm_budget_reservations";
DROP POLICY IF EXISTS tenant_isolation_insert ON "llm_budget_reservations";
DROP POLICY IF EXISTS tenant_isolation_update ON "llm_budget_reservations";
DROP POLICY IF EXISTS tenant_isolation_delete ON "llm_budget_reservations";
CREATE POLICY tenant_isolation_select ON "llm_budget_reservations"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "llm_budget_reservations"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "llm_budget_reservations"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "llm_budget_reservations"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
