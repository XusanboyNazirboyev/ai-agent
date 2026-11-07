CREATE TABLE "lead_stages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(40),
    "name" VARCHAR(80),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_stages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_stages_tenant_id_id_key"
    ON "lead_stages"("tenant_id", "id");
CREATE UNIQUE INDEX "lead_stages_tenant_id_code_key"
    ON "lead_stages"("tenant_id", "code");
CREATE INDEX "lead_stages_tenant_id_position_idx"
    ON "lead_stages"("tenant_id", "position");

ALTER TABLE "lead_stages"
    ADD CONSTRAINT "lead_stages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "leads"
    ADD COLUMN "pipeline_stage_id" UUID;

INSERT INTO "lead_stages" ("id", "tenant_id", "code", "position", "updated_at")
SELECT gen_random_uuid(), tenant."id", stage."code", stage."position", CURRENT_TIMESTAMP
FROM "tenants" AS tenant
CROSS JOIN (
    VALUES ('NEW', 0), ('HOT', 1), ('WARM', 2), ('COLD', 3)
) AS stage("code", "position");

UPDATE "leads" AS lead
SET "pipeline_stage_id" = stage."id"
FROM "lead_stages" AS stage
WHERE stage."tenant_id" = lead."tenant_id"
  AND stage."code" = lead."score"::TEXT;

ALTER TABLE "leads"
    ADD CONSTRAINT "leads_tenant_id_pipeline_stage_id_fkey"
    FOREIGN KEY ("tenant_id", "pipeline_stage_id")
    REFERENCES "lead_stages"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "leads_tenant_id_pipeline_stage_id_created_at_idx"
    ON "leads"("tenant_id", "pipeline_stage_id", "created_at");
