import type { Prisma } from '../generated/prisma/client.js';

type Tx = Pick<
  Prisma.TransactionClient,
  'leadStage' | 'pipeline' | '$executeRaw'
>;

export const DEFAULT_LEAD_STAGES = [
  { code: 'NEW', position: 0 },
  { code: 'HOT', position: 1 },
  { code: 'WARM', position: 2 },
  { code: 'COLD', position: 3 },
] as const;

/**
 * Makes sure a pipeline has the four coded stages (missing ones are appended
 * after the existing ones) and returns the id of its `NEW` stage.
 */
export async function ensureCodedStages(
  tx: Pick<Tx, 'leadStage'>,
  tenantId: string,
  pipelineId: string,
): Promise<string> {
  const existing = await tx.leadStage.findMany({
    where: { tenantId, pipelineId },
    select: { id: true, code: true, position: true },
  });
  const have = new Set(existing.map((stage) => stage.code));
  const missing = DEFAULT_LEAD_STAGES.filter(({ code }) => !have.has(code));
  if (missing.length > 0) {
    const next =
      existing.length === 0
        ? 0
        : Math.max(...existing.map((stage) => stage.position)) + 1;
    await tx.leadStage.createMany({
      data: missing.map(({ code }, index) => ({
        tenantId,
        pipelineId,
        code,
        position: next + index,
      })),
      skipDuplicates: true,
    });
  }
  const first = await tx.leadStage.findFirst({
    where: { tenantId, pipelineId, code: 'NEW' },
    select: { id: true },
  });
  if (!first) throw new Error('Default lead stage creation failed');
  return first.id;
}

/**
 * Ensures the tenant's default pipeline (ADR 057; exactly one active default,
 * enforced by a partial unique index) and its coded stages. Returns both ids.
 */
export async function ensureDefaultPipeline(
  tx: Tx,
  tenantId: string,
): Promise<{ pipelineId: string; firstStageId: string }> {
  const find = (): Promise<{ id: string } | null> =>
    tx.pipeline.findFirst({
      where: { tenantId, isDefault: true, archivedAt: null },
      select: { id: true },
    });
  let pipeline = await find();
  if (!pipeline) {
    await tx.$executeRaw`INSERT INTO "pipelines" ("id", "tenant_id", "name", "position", "is_default")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, NULL, 0, true)
      ON CONFLICT ("tenant_id") WHERE "is_default" AND "archived_at" IS NULL DO NOTHING`;
    pipeline = await find();
  }
  if (!pipeline) throw new Error('Default pipeline creation failed');
  const firstStageId = await ensureCodedStages(tx, tenantId, pipeline.id);
  return { pipelineId: pipeline.id, firstStageId };
}

/** Ensures the default pipeline and its stages; returns the first stage id. */
export async function ensureLeadStages(
  tx: Tx,
  tenantId: string,
): Promise<string> {
  return (await ensureDefaultPipeline(tx, tenantId)).firstStageId;
}
