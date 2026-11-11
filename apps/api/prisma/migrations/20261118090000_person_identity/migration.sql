-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "person_id" UUID;

-- CreateTable
CREATE TABLE "persons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "display_name" VARCHAR(200),
    "primary_phone" VARCHAR(40),
    "merged_into_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "persons_tenant_id_primary_phone_idx" ON "persons"("tenant_id", "primary_phone");

-- CreateIndex
CREATE INDEX "persons_tenant_id_merged_into_id_idx" ON "persons"("tenant_id", "merged_into_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_tenant_id_id_key" ON "persons"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_person_id_idx" ON "contacts"("tenant_id", "person_id");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_merged_into_id_fkey" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ADR 052 slice A: set-based, idempotent backfill. Every contact without a
-- person gets its own person (1:1). primary_phone stays NULL on purpose
-- (phone normalisation comes in a later slice). An erased contact (name
-- already NULL) gets an already-deleted person.
WITH pending AS (
  SELECT id, tenant_id, name, deleted_at, gen_random_uuid() AS new_person_id
  FROM "contacts"
  WHERE person_id IS NULL
), created AS (
  INSERT INTO "persons" (id, tenant_id, display_name, deleted_at, created_at, updated_at)
  SELECT new_person_id, tenant_id, name, deleted_at, now(), now() FROM pending
  RETURNING id
)
UPDATE "contacts" c
SET person_id = pending.new_person_id
FROM pending
WHERE c.id = pending.id;

-- ADR 050: tenant-isolation RLS for persons (same style as 20261117090000).
ALTER TABLE "persons" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON "persons";
DROP POLICY IF EXISTS tenant_isolation_insert ON "persons";
DROP POLICY IF EXISTS tenant_isolation_update ON "persons";
DROP POLICY IF EXISTS tenant_isolation_delete ON "persons";
CREATE POLICY tenant_isolation_select ON "persons"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "persons"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "persons"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "persons"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
