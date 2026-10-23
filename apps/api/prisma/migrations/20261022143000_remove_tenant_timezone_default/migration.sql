-- Require an explicit tenant timezone; the product-wide default is still open.
ALTER TABLE "tenants" ALTER COLUMN "timezone" DROP DEFAULT;
