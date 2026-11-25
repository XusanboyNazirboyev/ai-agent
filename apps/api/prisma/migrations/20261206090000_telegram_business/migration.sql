-- ADR 092: a Telegram Business connection of the platform bot, kept on the
-- owner's channel account (`business:<telegram user id>`). Additive.
ALTER TABLE "channel_accounts" ADD COLUMN "business_connection_id" VARCHAR(200);
CREATE UNIQUE INDEX "channel_accounts_business_connection_id_key" ON "channel_accounts"("business_connection_id");
