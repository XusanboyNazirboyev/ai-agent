-- An operator-set lead score survives automatic rescoring (ADR 037). Additive only.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "score_set_by_operator" BOOLEAN NOT NULL DEFAULT false;
