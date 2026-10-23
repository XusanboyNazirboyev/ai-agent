-- Phase 4B: inbound sequence visible when a turn was claimed (additive).

-- AlterTable
ALTER TABLE "agent_turns" ADD COLUMN     "seen_inbound_sequence" INTEGER NOT NULL DEFAULT 0;


ALTER TABLE "agent_turns"
  ADD CONSTRAINT "agent_turns_seen_sequence_check"
    CHECK ("seen_inbound_sequence" >= "answered_sequence");
