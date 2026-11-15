-- Quick replies a workspace writes for its operators (roadmap P1.8, ADR 070). Additive.
CREATE TABLE "canned_responses" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "title" VARCHAR(80) NOT NULL,
  "text" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "canned_responses_tenant_id_id_key" ON "canned_responses"("tenant_id", "id");
CREATE INDEX "canned_responses_tenant_id_position_idx" ON "canned_responses"("tenant_id", "position");
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
