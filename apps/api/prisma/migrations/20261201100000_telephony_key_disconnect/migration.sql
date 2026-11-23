-- ADR 085: disconnecting OnlinePBX deletes the sealed API key and keeps the calls.
-- AlterTable
ALTER TABLE "telephony_accounts" ALTER COLUMN "api_key_key_id" DROP NOT NULL,
ALTER COLUMN "api_key_nonce" DROP NOT NULL,
ALTER COLUMN "api_key_cipher" DROP NOT NULL;

