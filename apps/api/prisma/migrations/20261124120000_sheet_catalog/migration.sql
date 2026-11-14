-- ADR 064: a price list uploaded as a spreadsheet, served by the `spreadsheet`
-- connector. Additive: three new tenant-scoped tables, nothing else changes.
CREATE TABLE "sheet_catalogs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "source_filename" VARCHAR(200),
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "freshness_days" INTEGER NOT NULL DEFAULT 3,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "accepted_count" INTEGER NOT NULL,
    "rejected_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sheet_catalogs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sheet_catalog_items" (
    "tenant_id" UUID NOT NULL,
    "catalog_id" UUID NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "normalized_title" VARCHAR(600) NOT NULL,
    "item_type" VARCHAR(100) NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "sheet_catalog_items_pkey" PRIMARY KEY ("tenant_id","catalog_id","key")
);

CREATE TABLE "sheet_catalog_offers" (
    "tenant_id" UUID NOT NULL,
    "catalog_id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "item_key" VARCHAR(32) NOT NULL,
    "price" DECIMAL(20,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "availability" VARCHAR(16) NOT NULL,
    "seats_left" INTEGER,
    "starts_on" DATE,
    "ends_on" DATE,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "line" INTEGER NOT NULL,

    CONSTRAINT "sheet_catalog_offers_pkey" PRIMARY KEY ("tenant_id","catalog_id","key")
);

CREATE UNIQUE INDEX "sheet_catalogs_tenant_id_id_key" ON "sheet_catalogs"("tenant_id", "id");
CREATE UNIQUE INDEX "sheet_catalogs_tenant_id_key" ON "sheet_catalogs"("tenant_id");
CREATE INDEX "sheet_catalog_items_tenant_id_catalog_id_normalized_title_idx" ON "sheet_catalog_items"("tenant_id", "catalog_id", "normalized_title");
CREATE INDEX "sheet_catalog_offers_tenant_id_catalog_id_item_key_idx" ON "sheet_catalog_offers"("tenant_id", "catalog_id", "item_key");

ALTER TABLE "sheet_catalogs" ADD CONSTRAINT "sheet_catalogs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sheet_catalog_items" ADD CONSTRAINT "sheet_catalog_items_tenant_id_catalog_id_fkey" FOREIGN KEY ("tenant_id", "catalog_id") REFERENCES "sheet_catalogs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sheet_catalog_offers" ADD CONSTRAINT "sheet_catalog_offers_tenant_id_catalog_id_fkey" FOREIGN KEY ("tenant_id", "catalog_id") REFERENCES "sheet_catalogs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
