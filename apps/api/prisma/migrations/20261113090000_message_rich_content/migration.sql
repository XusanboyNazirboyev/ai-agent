-- ADR 044: Instagram carousel spec on the bot reply.
ALTER TABLE "messages" ADD COLUMN "rich_content" JSONB;
