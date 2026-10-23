-- Marks channel accounts that receive only fake/seed data (additive).

-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN     "is_test_account" BOOLEAN NOT NULL DEFAULT false;

