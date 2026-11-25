-- ADR 091: a turn the bot could not answer (NO_DATA) is listed for the
-- owner until they answer it with a FAQ entry or dismiss it. Additive.
ALTER TABLE "agent_turns" ADD COLUMN "gap_resolution" VARCHAR(16);
ALTER TABLE "agent_turns" ADD COLUMN "gap_resolved_at" TIMESTAMPTZ(6);
