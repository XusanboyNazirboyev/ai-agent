-- Track bounded sender retries and a safe diagnostic code without storing provider error text.
ALTER TABLE "messages"
  ADD COLUMN "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "delivery_error_code" VARCHAR(100);

CREATE INDEX "inbound_events_tenant_id_channel_account_id_received_at_idx"
  ON "inbound_events"("tenant_id", "channel_account_id", "received_at");

CREATE INDEX "inbound_events_pending_conversation_idx"
  ON "inbound_events"(
    "tenant_id",
    "channel_account_id",
    ("redacted_payload"->>'conversationId'),
    "received_at"
  )
  WHERE "status" = 'RECEIVED';

CREATE INDEX "inbound_events_processed_conversation_idx"
  ON "inbound_events"(
    "tenant_id",
    "channel_account_id",
    ("redacted_payload"->>'conversationId'),
    "processed_at" DESC
  )
  WHERE "status" = 'PROCESSED';
