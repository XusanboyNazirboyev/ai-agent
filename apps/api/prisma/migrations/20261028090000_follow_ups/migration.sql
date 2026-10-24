-- Phase 6: follow-up ledger (additive).

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_tenant_id_id_key" ON "follow_ups"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_tenant_id_conversation_id_ordinal_key" ON "follow_ups"("tenant_id", "conversation_id", "ordinal");

-- CreateIndex
CREATE INDEX "follow_ups_tenant_id_created_at_idx" ON "follow_ups"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_ordinal_positive_check" CHECK ("ordinal" >= 1);
