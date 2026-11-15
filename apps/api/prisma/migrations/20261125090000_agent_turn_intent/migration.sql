-- What the customer asked for in a turn (the pack intent, e.g. "price"); no
-- customer text (ADR 063 S1, the smallest step). Additive and nullable:
-- older turns simply have none.
ALTER TABLE "agent_turns" ADD COLUMN "intent" VARCHAR(40);
