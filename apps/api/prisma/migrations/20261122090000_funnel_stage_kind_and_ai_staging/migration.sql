-- ADR 058 S1: stage kind, agent staging state, per-pipeline AI staging switch.
-- Additive only. Defaults keep today's behaviour: existing stages are OPEN,
-- existing leads are AGENT-staged with no suggestion, existing pipelines are
-- OFF. New pipelines get AUTO from application code, not from a table default.

CREATE TYPE "LeadStageKind" AS ENUM ('OPEN', 'WON', 'LOST');
CREATE TYPE "LeadStageSetBy" AS ENUM ('AGENT', 'OPERATOR');
CREATE TYPE "PipelineAiStaging" AS ENUM ('OFF', 'SUGGEST', 'AUTO');

ALTER TABLE "lead_stages" ADD COLUMN "kind" "LeadStageKind" NOT NULL DEFAULT 'OPEN';

ALTER TABLE "pipelines" ADD COLUMN "ai_staging" "PipelineAiStaging" NOT NULL DEFAULT 'OFF';

ALTER TABLE "leads" ADD COLUMN "stage_set_by" "LeadStageSetBy" NOT NULL DEFAULT 'AGENT';
ALTER TABLE "leads" ADD COLUMN "stage_set_at" TIMESTAMPTZ(6);
ALTER TABLE "leads" ADD COLUMN "suggested_stage_id" UUID;
ALTER TABLE "leads" ADD COLUMN "suggested_reason_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_suggested_stage_id_fkey" FOREIGN KEY ("tenant_id", "suggested_stage_id") REFERENCES "lead_stages"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
