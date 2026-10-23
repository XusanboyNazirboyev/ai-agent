-- Usage records whose token counts were estimated by the adapter (additive).

-- AlterTable
ALTER TABLE "llm_usage_records" ADD COLUMN     "usage_estimated" BOOLEAN NOT NULL DEFAULT false;

