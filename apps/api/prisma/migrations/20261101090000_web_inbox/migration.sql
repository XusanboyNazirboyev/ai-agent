-- Phase 6A (ADR 020): operator web login, sessions and the inbox change feed.

-- CreateTable
CREATE TABLE "operator_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operator_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "csrf_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "conversation_id" UUID,
    "handover_id" UUID,
    "message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_credentials_operator_id_key" ON "operator_credentials"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_credentials_email_key" ON "operator_credentials"("email");

-- CreateIndex
CREATE UNIQUE INDEX "operator_credentials_tenant_id_id_key" ON "operator_credentials"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_sessions_token_hash_key" ON "operator_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "operator_sessions_tenant_id_id_key" ON "operator_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "operator_sessions_tenant_id_operator_id_idx" ON "operator_sessions"("tenant_id", "operator_id");

-- CreateIndex
CREATE INDEX "inbox_events_tenant_id_id_idx" ON "inbox_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inbox_events_created_at_idx" ON "inbox_events"("created_at");

-- AddForeignKey
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_tenant_id_operator_id_fkey" FOREIGN KEY ("tenant_id", "operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_tenant_id_operator_id_fkey" FOREIGN KEY ("tenant_id", "operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_events" ADD CONSTRAINT "inbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten: the email is stored lower-case so login lookups are exact.
ALTER TABLE "operator_credentials"
  ADD CONSTRAINT "operator_credentials_email_lower_check" CHECK ("email" = lower("email"));

-- Handwritten: change feed written by triggers, so every writer (webhook intake,
-- agent pipeline, operator commands, SLA scan) is covered, in the same
-- transaction as the change. Events carry ids only, never message text.
CREATE FUNCTION inbox_event_conversation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."assigned_operator_id" IS DISTINCT FROM OLD."assigned_operator_id" THEN
    INSERT INTO "inbox_events" ("tenant_id", "type", "conversation_id")
    VALUES (NEW."tenant_id", 'conversation.updated', NEW."id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "conversations_inbox_event"
  AFTER INSERT OR UPDATE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION inbox_event_conversation();

CREATE FUNCTION inbox_event_message() RETURNS trigger AS $$
BEGIN
  INSERT INTO "inbox_events" ("tenant_id", "type", "conversation_id", "message_id")
  VALUES (NEW."tenant_id", 'message.created', NEW."conversation_id", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "messages_inbox_event"
  AFTER INSERT ON "messages"
  FOR EACH ROW EXECUTE FUNCTION inbox_event_message();

CREATE FUNCTION inbox_event_handover() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "inbox_events" ("tenant_id", "type", "conversation_id", "handover_id")
    VALUES (NEW."tenant_id", 'handover.created', NEW."conversation_id", NEW."id");
  ELSIF NEW."sla_alerted_at" IS NOT NULL AND OLD."sla_alerted_at" IS NULL THEN
    INSERT INTO "inbox_events" ("tenant_id", "type", "conversation_id", "handover_id")
    VALUES (NEW."tenant_id", 'handover.sla_breached', NEW."conversation_id", NEW."id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "handovers_inbox_event"
  AFTER INSERT OR UPDATE ON "handovers"
  FOR EACH ROW EXECUTE FUNCTION inbox_event_handover();
