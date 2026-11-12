-- ADR 057: a lead inserted for a tenant that has no default pipeline yet
-- (a tenant created after the backfill) creates it on demand, so every lead
-- insert keeps working. Idempotent (CREATE OR REPLACE, ON CONFLICT DO NOTHING).
CREATE OR REPLACE FUNCTION "leads_fill_pipeline"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW."pipeline_id" IS NULL OR NEW."pipeline_id" = '00000000-0000-0000-0000-000000000000'::uuid THEN
    NEW."pipeline_id" := NULL;
    IF NEW."pipeline_stage_id" IS NOT NULL THEN
      SELECT s."pipeline_id" INTO NEW."pipeline_id" FROM "lead_stages" s
      WHERE s."tenant_id" = NEW."tenant_id" AND s."id" = NEW."pipeline_stage_id";
    END IF;
    IF NEW."pipeline_id" IS NULL THEN
      INSERT INTO "pipelines" ("id", "tenant_id", "name", "position", "is_default")
      VALUES (gen_random_uuid(), NEW."tenant_id", NULL, 0, true)
      ON CONFLICT ("tenant_id") WHERE "is_default" AND "archived_at" IS NULL DO NOTHING;
      SELECT p."id" INTO NEW."pipeline_id" FROM "pipelines" p
      WHERE p."tenant_id" = NEW."tenant_id" AND p."is_default" AND p."archived_at" IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
