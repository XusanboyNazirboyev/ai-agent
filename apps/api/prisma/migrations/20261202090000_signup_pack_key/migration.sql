-- Owner 2026-11-23: the signup form asks the business type; the tenant gets that Domain Pack
-- instead of always the first registered one. Nullable: signups started before this keep working.
-- AlterTable
ALTER TABLE "pending_signups" ADD COLUMN "pack_key" VARCHAR(100);
