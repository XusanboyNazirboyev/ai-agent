-- Add a retry-safe key for outbox operations; nullable until Phase 2 writers exist.
ALTER TABLE "outbox_events"
  ADD COLUMN "idempotency_key" VARCHAR(200);

CREATE UNIQUE INDEX "outbox_events_tenant_id_idempotency_key_key"
  ON "outbox_events"("tenant_id", "idempotency_key");
