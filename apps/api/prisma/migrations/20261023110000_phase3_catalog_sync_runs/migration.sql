-- Phase 3: catalog synchronisation run history (additive).

-- CreateEnum
CREATE TYPE "CatalogSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED');

-- CreateTable
CREATE TABLE "catalog_sync_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tenant_connector_id" UUID NOT NULL,
    "status" "CatalogSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "source_system" VARCHAR(100),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "items_upserted" INTEGER NOT NULL DEFAULT 0,
    "items_unchanged" INTEGER NOT NULL DEFAULT 0,
    "items_deactivated" INTEGER NOT NULL DEFAULT 0,
    "offers_seen" INTEGER NOT NULL DEFAULT 0,
    "offers_upserted" INTEGER NOT NULL DEFAULT 0,
    "offers_unchanged" INTEGER NOT NULL DEFAULT 0,
    "offers_deactivated" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(100),
    "error_category" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_sync_runs_tenant_id_tenant_connector_id_started_at_idx" ON "catalog_sync_runs"("tenant_id", "tenant_connector_id", "started_at");

-- CreateIndex
CREATE INDEX "catalog_sync_runs_status_heartbeat_at_idx" ON "catalog_sync_runs"("status", "heartbeat_at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_sync_runs_tenant_id_id_key" ON "catalog_sync_runs"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "catalog_sync_runs" ADD CONSTRAINT "catalog_sync_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_sync_runs" ADD CONSTRAINT "catalog_sync_runs_tenant_id_tenant_connector_id_fkey" FOREIGN KEY ("tenant_id", "tenant_connector_id") REFERENCES "tenant_connectors"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Handwritten invariants (not expressible in Prisma).
ALTER TABLE "catalog_sync_runs"
  ADD CONSTRAINT "catalog_sync_runs_counts_nonnegative_check" CHECK (
    "items_seen" >= 0 AND "items_upserted" >= 0 AND "items_unchanged" >= 0
    AND "items_deactivated" >= 0 AND "offers_seen" >= 0
    AND "offers_upserted" >= 0 AND "offers_unchanged" >= 0
    AND "offers_deactivated" >= 0
  ),
  ADD CONSTRAINT "catalog_sync_runs_finished_check"
    CHECK (("status" = 'RUNNING') = ("finished_at" IS NULL)),
  ADD CONSTRAINT "catalog_sync_runs_error_code_check"
    CHECK (("status" IN ('FAILED', 'BLOCKED')) = ("error_code" IS NOT NULL));

-- At most one running sync per tenant connector: overlapping runs are
-- rejected by the database, not only by queue deduplication.
CREATE UNIQUE INDEX "catalog_sync_runs_one_running_per_connector_key"
  ON "catalog_sync_runs"("tenant_id", "tenant_connector_id")
  WHERE "status" = 'RUNNING';
