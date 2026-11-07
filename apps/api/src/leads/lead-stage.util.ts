import type { Prisma } from '../generated/prisma/client.js';

type Tx = Pick<Prisma.TransactionClient, 'leadStage'>;

export const DEFAULT_LEAD_STAGES = [
  { code: 'NEW', position: 0 },
  { code: 'HOT', position: 1 },
  { code: 'WARM', position: 2 },
  { code: 'COLD', position: 3 },
] as const;

export async function ensureLeadStages(
  tx: Tx,
  tenantId: string,
): Promise<string> {
  await tx.leadStage.createMany({
    data: DEFAULT_LEAD_STAGES.map(({ code, position }) => ({
      tenantId,
      code,
      position,
    })),
    skipDuplicates: true,
  });
  const first = await tx.leadStage.findUnique({
    where: { tenantId_code: { tenantId, code: 'NEW' } },
    select: { id: true },
  });
  if (!first) throw new Error('Default lead stage creation failed');
  return first.id;
}
