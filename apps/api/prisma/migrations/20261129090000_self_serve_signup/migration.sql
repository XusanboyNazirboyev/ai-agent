-- ADR 080: self-serve signup confirmed through the platform Telegram bot.
-- Platform-level tables (no tenant yet, no tenant_id, no RLS): only the
-- privileged connection touches them. Additive.

CREATE TYPE "SignupStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'REFUSED');

CREATE TABLE "pending_signups" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "binding_hash" VARCHAR(64) NOT NULL,
    "business_name" VARCHAR(120) NOT NULL,
    "person_name" VARCHAR(80) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SignupStatus" NOT NULL DEFAULT 'PENDING',
    "telegram_user_id" VARCHAR(32),
    "telegram_chat_id" VARCHAR(32),
    "phone" VARCHAR(32),
    "created_tenant_id" UUID,
    "refusal_reason" VARCHAR(40),
    "last_update_id" BIGINT,
    "signed_in_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "pending_signups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_signups_token_hash_key" ON "pending_signups"("token_hash");
CREATE INDEX "pending_signups_expires_at_idx" ON "pending_signups"("expires_at");
CREATE INDEX "pending_signups_telegram_user_id_status_idx" ON "pending_signups"("telegram_user_id", "status");

ALTER TABLE "pending_signups" ADD CONSTRAINT "pending_signups_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "trial_claims" (
    "id" UUID NOT NULL,
    "telegram_user_id" VARCHAR(32) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "claimed_tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trial_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trial_claims_telegram_user_id_key" ON "trial_claims"("telegram_user_id");
CREATE UNIQUE INDEX "trial_claims_phone_key" ON "trial_claims"("phone");
