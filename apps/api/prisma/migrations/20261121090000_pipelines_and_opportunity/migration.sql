-- ADR 057: multiple pipelines and the lead as an opportunity (P1.3).
-- Expand, idempotent set-based backfill, switch. Additive: no data is dropped.

-- CreateTable
CREATE TABLE "pipelines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80),
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pipelines_tenant_id_id_key" ON "pipelines"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "pipelines_tenant_id_archived_at_position_idx" ON "pipelines"("tenant_id", "archived_at", "position");

-- Exactly one active default pipeline per tenant (ADR 057, SQL only).
CREATE UNIQUE INDEX "pipelines_one_active_default_key" ON "pipelines"("tenant_id") WHERE "is_default" AND "archived_at" IS NULL;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL-1 (idempotent): one default pipeline per tenant that has none.
INSERT INTO "pipelines" ("id", "tenant_id", "name", "position", "is_default")
SELECT gen_random_uuid(), t."id", NULL, 0, true
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "pipelines" p
  WHERE p."tenant_id" = t."id" AND p."is_default" AND p."archived_at" IS NULL
);

-- lead_stages: pipeline_id, archived_at
ALTER TABLE "lead_stages" ADD COLUMN IF NOT EXISTS "pipeline_id" UUID;
ALTER TABLE "lead_stages" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6);

-- BACKFILL-2 (idempotent): every stage joins its tenant's default pipeline.
UPDATE "lead_stages" s
SET "pipeline_id" = p."id"
FROM "pipelines" p
WHERE s."pipeline_id" IS NULL
  AND p."tenant_id" = s."tenant_id" AND p."is_default" AND p."archived_at" IS NULL;

ALTER TABLE "lead_stages" ALTER COLUMN "pipeline_id" SET NOT NULL;

-- Swap the unique: (tenant_id, code) becomes (tenant_id, pipeline_id, code).
DROP INDEX IF EXISTS "lead_stages_tenant_id_code_key";
DROP INDEX IF EXISTS "lead_stages_tenant_id_position_idx";
CREATE UNIQUE INDEX "lead_stages_tenant_id_pipeline_id_id_key" ON "lead_stages"("tenant_id", "pipeline_id", "id");
CREATE UNIQUE INDEX "lead_stages_tenant_id_pipeline_id_code_key" ON "lead_stages"("tenant_id", "pipeline_id", "code");
CREATE INDEX "lead_stages_tenant_id_pipeline_id_position_idx" ON "lead_stages"("tenant_id", "pipeline_id", "position");

ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_tenant_id_pipeline_id_fkey" FOREIGN KEY ("tenant_id", "pipeline_id") REFERENCES "pipelines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- leads: pipeline and opportunity columns
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "pipeline_id" UUID;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "owner_operator_id" UUID;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(14,2);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "currency" CHAR(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source" VARCHAR(60);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "expected_close_date" DATE;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lost_reason" VARCHAR(200);

-- BACKFILL-3 (idempotent): a lead joins its stage's pipeline, else the default pipeline.
UPDATE "leads" l
SET "pipeline_id" = s."pipeline_id"
FROM "lead_stages" s
WHERE l."pipeline_id" IS NULL
  AND l."pipeline_stage_id" IS NOT NULL
  AND s."tenant_id" = l."tenant_id" AND s."id" = l."pipeline_stage_id";

UPDATE "leads" l
SET "pipeline_id" = p."id"
FROM "pipelines" p
WHERE l."pipeline_id" IS NULL
  AND p."tenant_id" = l."tenant_id" AND p."is_default" AND p."archived_at" IS NULL;

ALTER TABLE "leads" ALTER COLUMN "pipeline_id" SET NOT NULL;
ALTER TABLE "leads" ALTER COLUMN "pipeline_id" SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid;

-- A lead without pipeline_id takes its stage's pipeline or the tenant's default one.
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
      SELECT p."id" INTO NEW."pipeline_id" FROM "pipelines" p
      WHERE p."tenant_id" = NEW."tenant_id" AND p."is_default" AND p."archived_at" IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "leads_fill_pipeline_trg" ON "leads";
CREATE TRIGGER "leads_fill_pipeline_trg" BEFORE INSERT ON "leads"
FOR EACH ROW EXECUTE FUNCTION "leads_fill_pipeline"();

-- Switch the stage FK to the composite one that includes the pipeline.
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_tenant_id_pipeline_stage_id_fkey";
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_pipeline_id_fkey" FOREIGN KEY ("tenant_id", "pipeline_id") REFERENCES "pipelines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_pipeline_id_pipeline_stage_id_fkey" FOREIGN KEY ("tenant_id", "pipeline_id", "pipeline_stage_id") REFERENCES "lead_stages"("tenant_id", "pipeline_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_owner_operator_id_fkey" FOREIGN KEY ("tenant_id", "owner_operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- amount and currency are set together or not at all.
ALTER TABLE "leads" ADD CONSTRAINT "leads_amount_currency_pair_chk" CHECK (("amount" IS NULL) = ("currency" IS NULL));

CREATE INDEX "leads_tenant_id_pipeline_id_created_at_idx" ON "leads"("tenant_id", "pipeline_id", "created_at");
CREATE INDEX "leads_tenant_id_owner_operator_id_idx" ON "leads"("tenant_id", "owner_operator_id");

-- ADR 050: tenant-isolation RLS for pipelines (keep this block last: the RLS
-- integration test re-applies everything from the next line on).
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "pipelines";
DROP POLICY IF EXISTS tenant_isolation_insert ON "pipelines";
DROP POLICY IF EXISTS tenant_isolation_update ON "pipelines";
DROP POLICY IF EXISTS tenant_isolation_delete ON "pipelines";
CREATE POLICY tenant_isolation_select ON "pipelines"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "pipelines"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "pipelines"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "pipelines"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
