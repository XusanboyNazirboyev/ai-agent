-- ADR 052 slice C: audit and undo record of person merges.
CREATE TABLE "person_merges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "merged_id" UUID NOT NULL,
    "contact_ids" UUID[],
    "by_operator_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMPTZ(6),
    "undone_by_operator_id" UUID,

    CONSTRAINT "person_merges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "person_merges_tenant_id_survivor_id_created_at_idx" ON "person_merges"("tenant_id", "survivor_id", "created_at");

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_tenant_id_survivor_id_fkey" FOREIGN KEY ("tenant_id", "survivor_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_tenant_id_merged_id_fkey" FOREIGN KEY ("tenant_id", "merged_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_tenant_id_by_operator_id_fkey" FOREIGN KEY ("tenant_id", "by_operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_tenant_id_undone_by_operator_id_fkey" FOREIGN KEY ("tenant_id", "undone_by_operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ADR 050: tenant-isolation RLS for person_merges (same style as 20261118090000).
ALTER TABLE "person_merges" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON "person_merges";
DROP POLICY IF EXISTS tenant_isolation_insert ON "person_merges";
DROP POLICY IF EXISTS tenant_isolation_update ON "person_merges";
DROP POLICY IF EXISTS tenant_isolation_delete ON "person_merges";
CREATE POLICY tenant_isolation_select ON "person_merges"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "person_merges"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "person_merges"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "person_merges"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
