-- ADR 059: explicit connector roles (one connector per tenant and role).

-- CreateEnum
CREATE TYPE "ConnectorRole" AS ENUM ('CATALOG', 'LEAD_SINK', 'ACTIONS');

-- CreateTable
CREATE TABLE "tenant_connector_roles" (
    "tenant_id" UUID NOT NULL,
    "role" "ConnectorRole" NOT NULL,
    "tenant_connector_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_connector_roles_pkey" PRIMARY KEY ("tenant_id","role")
);

-- CreateIndex
CREATE INDEX "tenant_connector_roles_tenant_id_tenant_connector_id_idx" ON "tenant_connector_roles"("tenant_id", "tenant_connector_id");

-- AddForeignKey
ALTER TABLE "tenant_connector_roles" ADD CONSTRAINT "tenant_connector_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_connector_roles" ADD CONSTRAINT "tenant_connector_roles_tenant_id_tenant_connector_id_fkey" FOREIGN KEY ("tenant_id", "tenant_connector_id") REFERENCES "tenant_connectors"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ADR 050: tenant-isolation RLS.
ALTER TABLE "tenant_connector_roles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "tenant_connector_roles";
DROP POLICY IF EXISTS tenant_isolation_insert ON "tenant_connector_roles";
DROP POLICY IF EXISTS tenant_isolation_update ON "tenant_connector_roles";
DROP POLICY IF EXISTS tenant_isolation_delete ON "tenant_connector_roles";
CREATE POLICY tenant_isolation_select ON "tenant_connector_roles"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_insert ON "tenant_connector_roles"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_update ON "tenant_connector_roles"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_delete ON "tenant_connector_roles"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
