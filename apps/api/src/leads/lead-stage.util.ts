import type { Prisma } from '../generated/prisma/client.js';

type Tx = Pick<
  Prisma.TransactionClient,
  'leadStage' | 'pipeline' | '$executeRaw'
>;

/**
 * ADR 058 decision 2: the default funnel of a pipeline that has no stages yet.
 * The labels are i18n keys of the coded names; tenants may rename, add or
 * remove them (WON/LOST of the default pipeline stay protected).
 */
export const DEFAULT_LEAD_STAGES = [
  { code: 'NEW', position: 0, kind: 'OPEN' },
  { code: 'CONTACTED', position: 1, kind: 'OPEN' },
  { code: 'QUALIFIED', position: 2, kind: 'OPEN' },
  { code: 'PROPOSAL', position: 3, kind: 'OPEN' },
  { code: 'NEGOTIATION', position: 4, kind: 'OPEN' },
  { code: 'WON', position: 5, kind: 'WON' },
  { code: 'LOST', position: 6, kind: 'LOST' },
] as const;

/**
 * Creates the default funnel for a pipeline with no stages (existing
 * pipelines are never touched: the old coded NEW/HOT/WARM/COLD stay valid) and
 * returns the id of the pipeline's first stage (`NEW` when present).
 */
export async function ensureCodedStages(
  tx: Pick<Tx, 'leadStage'>,
  tenantId: string,
  pipelineId: string,
): Promise<string> {
  const existing = await tx.leadStage.count({
    where: { tenantId, pipelineId },
  });
  if (existing === 0) {
    await tx.leadStage.createMany({
      data: DEFAULT_LEAD_STAGES.map(({ code, position, kind }) => ({
        tenantId,
        pipelineId,
        code,
        position,
        kind,
      })),
      skipDuplicates: true,
    });
  }
  const first =
    (await tx.leadStage.findFirst({
      where: { tenantId, pipelineId, code: 'NEW' },
      select: { id: true },
    })) ??
    (await tx.leadStage.findFirst({
      where: { tenantId, pipelineId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }));
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
    await tx.$executeRaw`INSERT INTO "pipelines" ("id", "tenant_id", "name", "position", "is_default", "ai_staging")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, NULL, 0, true, 'AUTO')
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
