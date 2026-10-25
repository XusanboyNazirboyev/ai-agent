-- ADR 028: shown name of a connected channel account. Additive only.
ALTER TABLE "channel_accounts" ADD COLUMN "display_name" VARCHAR(200);
