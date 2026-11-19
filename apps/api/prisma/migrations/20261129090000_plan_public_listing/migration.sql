-- ADR 080: plans shown on the public sales page. Additive; platform table (no tenant_id, no RLS).
ALTER TABLE "subscription_plans" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription_plans" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
