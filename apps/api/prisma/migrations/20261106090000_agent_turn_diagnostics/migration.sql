-- ADR 029: blocked-draft diagnostics on agent turns. Additive only.
ALTER TABLE "agent_turns" ADD COLUMN "diagnostics" JSONB,
ADD COLUMN "diagnostics_expires_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "agent_turns_diagnostics_expires_at_idx" ON "agent_turns"("diagnostics_expires_at");
