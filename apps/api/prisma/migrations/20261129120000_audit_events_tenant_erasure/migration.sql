-- ADR 047 amendment (tenant delete, fixed 2026-11-19): audit_events stays
-- append-only, except that the rows of the tenant being erased may be deleted
-- inside the erasure transaction, which sets the transaction-local setting
-- agentcore.erasing_tenant to that tenant's id. UPDATE is always refused.
CREATE OR REPLACE FUNCTION "reject_audit_event_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD."tenant_id" IS NOT NULL
     AND OLD."tenant_id"::text = current_setting('agentcore.erasing_tenant', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
