-- Owner 2026-11-24: "contact us" requests from the public sales page.
-- Platform level (no tenant, no tenant_id, no RLS): only the privileged
-- connection touches it. Additive.

CREATE TABLE "sales_inquiries" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "company" VARCHAR(120),
    "message" VARCHAR(500),
    "locale" VARCHAR(10),
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_inquiries_created_at_idx" ON "sales_inquiries"("created_at");
