-- Owner 2026-11-24: Instagram comment auto-replies, per account, off until an owner turns them on.
-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN "comment_replies" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "comment_keywords" VARCHAR(60)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(60)[];
