import type { PrismaClient } from '../../../generated/prisma/client.js';

export interface DemoLead {
  readonly id: string;
  readonly tenantId: string;
  readonly contactId: string;
}

/**
 * The newest lead of the tenant the demo's own simulated conversation
 * created (scripts/bitrix24-demo.ts). Scoped by tenant, never by time
 * alone, so another run's or another session's lead is never picked up.
 */
export async function findDemoLead(
  db: Pick<PrismaClient, 'lead'>,
  tenantId: string | undefined,
): Promise<DemoLead | undefined> {
  if (!tenantId) return undefined;
  const lead = await db.lead.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, tenantId: true, contactId: true },
  });
  return lead ?? undefined;
}
