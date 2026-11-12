-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('PERSON', 'LEAD');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT');

-- AlterTable
ALTER TABLE "persons" ADD COLUMN "custom_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "custom_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "person_merges" ADD COLUMN "carried" JSONB;

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "color" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_tags" (
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_tags_pkey" PRIMARY KEY ("tenant_id","person_id","tag_id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("tenant_id","lead_id","tag_id")
);

-- CreateTable
CREATE TABLE "custom_field_defs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_id_key" ON "tags"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "tags_tenant_id_archived_at_idx" ON "tags"("tenant_id", "archived_at");

-- Active tag names are unique per tenant, case-insensitively (ADR 053).
CREATE UNIQUE INDEX "tags_tenant_id_lower_name_active_key" ON "tags"("tenant_id", lower("name")) WHERE "archived_at" IS NULL;

-- CreateIndex
CREATE INDEX "person_tags_tenant_id_tag_id_idx" ON "person_tags"("tenant_id", "tag_id");

-- CreateIndex
CREATE INDEX "lead_tags_tenant_id_tag_id_idx" ON "lead_tags"("tenant_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_defs_tenant_id_id_key" ON "custom_field_defs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_defs_tenant_id_entity_key_key" ON "custom_field_defs"("tenant_id", "entity", "key");

-- CreateIndex
CREATE INDEX "custom_field_defs_tenant_id_entity_archived_at_position_idx" ON "custom_field_defs"("tenant_id", "entity", "archived_at", "position");

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_tenant_id_tag_id_fkey" FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "tags"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tenant_id_tag_id_fkey" FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "tags"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ADR 050: tenant-isolation RLS for tags/custom fields.
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "tags";
DROP POLICY IF EXISTS tenant_isolation_insert ON "tags";
DROP POLICY IF EXISTS tenant_isolation_update ON "tags";
DROP POLICY IF EXISTS tenant_isolation_delete ON "tags";
CREATE POLICY tenant_isolation_select ON "tags"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "tags"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "tags"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "tags"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "person_tags" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "person_tags";
DROP POLICY IF EXISTS tenant_isolation_insert ON "person_tags";
DROP POLICY IF EXISTS tenant_isolation_update ON "person_tags";
DROP POLICY IF EXISTS tenant_isolation_delete ON "person_tags";
CREATE POLICY tenant_isolation_select ON "person_tags"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "person_tags"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "person_tags"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "person_tags"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "lead_tags" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "lead_tags";
DROP POLICY IF EXISTS tenant_isolation_insert ON "lead_tags";
DROP POLICY IF EXISTS tenant_isolation_update ON "lead_tags";
DROP POLICY IF EXISTS tenant_isolation_delete ON "lead_tags";
CREATE POLICY tenant_isolation_select ON "lead_tags"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "lead_tags"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "lead_tags"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "lead_tags"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "custom_field_defs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "custom_field_defs";
DROP POLICY IF EXISTS tenant_isolation_insert ON "custom_field_defs";
DROP POLICY IF EXISTS tenant_isolation_update ON "custom_field_defs";
DROP POLICY IF EXISTS tenant_isolation_delete ON "custom_field_defs";
CREATE POLICY tenant_isolation_select ON "custom_field_defs"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "custom_field_defs"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "custom_field_defs"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "custom_field_defs"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
