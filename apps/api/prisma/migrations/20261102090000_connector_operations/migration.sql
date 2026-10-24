-- ADR 023: durable record of one logical external write (idempotency key,
-- lease, typed outcome). Additive only.

-- CreateEnum
CREATE TYPE "ConnectorOperationStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'RESOLVED_SUCCEEDED', 'RESOLVED_FAILED');

-- CreateTable
CREATE TABLE "connector_operations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "subject_type" VARCHAR(40) NOT NULL,
    "subject_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "status" "ConnectorOperationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attempt_mode" VARCHAR(10),
    "last_execution" VARCHAR(20),
    "lease_token" VARCHAR(64),
    "lease_expires_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),
    "external_id" VARCHAR(200),
    "last_error_code" VARCHAR(100),
    "resolved_by" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "connector_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_operations_idempotency_key_key" ON "connector_operations"("idempotency_key");

-- CreateIndex
CREATE INDEX "connector_operations_status_next_attempt_at_idx" ON "connector_operations"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "connector_operations_status_lease_expires_at_idx" ON "connector_operations"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "connector_operations_tenant_id_id_key" ON "connector_operations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_operations_tenant_id_kind_subject_type_subject_id_key" ON "connector_operations"("tenant_id", "kind", "subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "connector_operations" ADD CONSTRAINT "connector_operations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten invariants.
ALTER TABLE "connector_operations"
  ADD CONSTRAINT "connector_operations_attempt_mode_check"
    CHECK ("attempt_mode" IS NULL OR "attempt_mode" IN ('native', 'lookup', 'none')),
  ADD CONSTRAINT "connector_operations_last_execution_check"
    CHECK ("last_execution" IS NULL OR "last_execution" IN ('NOT_EXECUTED', 'UNCERTAIN')),
  ADD CONSTRAINT "connector_operations_success_evidence_check"
    CHECK ("status" NOT IN ('SUCCEEDED', 'RESOLVED_SUCCEEDED') OR "external_id" IS NOT NULL),
  ADD CONSTRAINT "connector_operations_lease_check"
    CHECK ("status" <> 'IN_FLIGHT' OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL));
