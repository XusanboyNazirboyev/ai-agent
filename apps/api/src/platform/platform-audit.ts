import type { Prisma } from '../generated/prisma/client.js';

export type AuditSummary = Record<string, string | number | boolean | null>;

/** One platform audit row per console write (ADR 047 §2). */
export async function recordPlatformAudit(
  db: Pick<Prisma.TransactionClient, 'platformAuditEvent'>,
  entry: {
    readonly actorAdminId: string | null;
    readonly action: string;
    readonly tenantId?: string | null;
    readonly entityType: string;
    readonly entityId: string;
    readonly summary?: AuditSummary;
  },
): Promise<void> {
  await db.platformAuditEvent.create({
    data: {
      actorAdminId: entry.actorAdminId,
      action: entry.action,
      tenantId: entry.tenantId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      safeSummary: entry.summary ?? {},
    },
  });
}
