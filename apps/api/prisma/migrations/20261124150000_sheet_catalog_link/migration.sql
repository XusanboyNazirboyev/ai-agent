-- ADR 064 S3: a price list can come from a shared Google Sheets link and be
-- refreshed by the server. Additive: nullable or defaulted columns only.
ALTER TABLE "sheet_catalogs" ADD COLUMN "source_url" VARCHAR(500);
ALTER TABLE "sheet_catalogs" ADD COLUMN "auto_refresh" BOOLEAN NOT NULL DEFAULT false;
-- Header text of each mapped column at save time: a refresh whose headers moved is refused.
ALTER TABLE "sheet_catalogs" ADD COLUMN "mapped_headers" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "sheet_catalogs" ADD COLUMN "refresh_attempted_at" TIMESTAMPTZ(6);
ALTER TABLE "sheet_catalogs" ADD COLUMN "refresh_error" VARCHAR(40);
