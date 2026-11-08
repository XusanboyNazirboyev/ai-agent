-- ADR 043: public Instagram comments answered in private (additive).
-- CreateEnum
CREATE TYPE "InstagramCommentStatus" AS ENUM ('RECEIVED', 'SKIPPED', 'ANSWERED', 'FAILED');

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'COMMENT';

-- CreateTable
CREATE TABLE "instagram_comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "comment_id" VARCHAR(100) NOT NULL,
    "media_id" VARCHAR(100),
    "media_product_type" VARCHAR(50),
    "status" "InstagramCommentStatus" NOT NULL DEFAULT 'RECEIVED',
    "private_reply_message_id" UUID,
    "public_reply_id" VARCHAR(100),
    "error_code" VARCHAR(100),
    "commented_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "instagram_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_comments_tenant_id_channel_account_id_status_crea_idx" ON "instagram_comments"("tenant_id", "channel_account_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_comments_tenant_id_id_key" ON "instagram_comments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_comments_tenant_id_channel_account_id_comment_id_key" ON "instagram_comments"("tenant_id", "channel_account_id", "comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_comments_tenant_id_message_id_key" ON "instagram_comments"("tenant_id", "message_id");

-- AddForeignKey
ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_tenant_id_channel_account_id_fkey" FOREIGN KEY ("tenant_id", "channel_account_id") REFERENCES "channel_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

