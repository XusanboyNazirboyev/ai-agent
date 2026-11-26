-- The Inbox learns when an outbound message is delivered or fails, not only
-- when it is created: before this, an operator reply on a slow channel kept
-- showing "unknown" until something else refreshed the conversation.
-- Additive: a new function and trigger; ids only, never message text.
CREATE FUNCTION inbox_event_message_delivery() RETURNS trigger AS $$
BEGIN
  INSERT INTO "inbox_events" ("tenant_id", "type", "conversation_id")
  VALUES (NEW."tenant_id", 'conversation.updated', NEW."conversation_id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "messages_delivery_inbox_event"
  AFTER UPDATE OF "delivery_state" ON "messages"
  FOR EACH ROW
  WHEN (NEW."delivery_state" IS DISTINCT FROM OLD."delivery_state"
        AND NEW."delivery_state" IN ('SENT', 'FAILED'))
  EXECUTE FUNCTION inbox_event_message_delivery();
