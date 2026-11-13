-- ADR 062: archiving a lead (reversible) before deleting it for good.
-- Additive: one nullable column and an index; existing rows stay active.
ALTER TABLE "leads" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
CREATE INDEX "leads_tenant_id_archived_at_idx" ON "leads"("tenant_id", "archived_at");
