import type { ConnectorRole } from '../generated/prisma/client.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { CONNECTOR_ROLES, ConnectorSelector } from './connector-selector.js';
import type { TenantConnectorLoader } from './sync/tenant-connector-loader.js';

export type BackfillAction = 'ALREADY_BOUND' | 'BIND' | 'NO_CANDIDATE';

export interface BackfillEntry {
  tenantId: string;
  role: ConnectorRole;
  action: BackfillAction;
  /** The connector the old "oldest capable ACTIVE" rule picks (BIND only). */
  connectorKey: string | null;
  /** Every capable ACTIVE connector, oldest first; more than one = ambiguous. */
  candidates: string[];
  ambiguous: boolean;
}

/**
 * ADR 059 decision 4: bind, per tenant and role, the connector the old rule
 * would pick. Dry run by default; keys and ids only, never configuration.
 * Roles that are already bound are left alone, so a second run changes nothing.
 */
export async function backfillConnectorRoles(options: {
  prisma: PrismaService;
  loader: TenantConnectorLoader;
  apply: boolean;
  tenantIds?: readonly string[];
}): Promise<BackfillEntry[]> {
  const { prisma, loader, apply } = options;
  const selector = new ConnectorSelector(prisma, loader);
  const tenants = await prisma.tenantConnector.findMany({
    where: {
      status: 'ACTIVE',
      ...(options.tenantIds
        ? { tenantId: { in: [...options.tenantIds] } }
        : {}),
    },
    distinct: ['tenantId'],
    orderBy: { tenantId: 'asc' },
    select: { tenantId: true },
  });
  const report: BackfillEntry[] = [];
  for (const { tenantId } of tenants) {
    for (const role of CONNECTOR_ROLES) {
      const resolution = await selector.resolve(tenantId, role);
      if (resolution.kind !== 'UNBOUND') {
        report.push({
          tenantId,
          role,
          action: 'ALREADY_BOUND',
          connectorKey: resolution.row.connectorKey,
          candidates: [],
          ambiguous: false,
        });
        continue;
      }
      const candidates = resolution.candidates.map((c) => c.row.connectorKey);
      const first = resolution.candidates[0];
      if (!first) {
        report.push({
          tenantId,
          role,
          action: 'NO_CANDIDATE',
          connectorKey: null,
          candidates,
          ambiguous: false,
        });
        continue;
      }
      if (apply)
        await prisma.tenantConnectorRole.createMany({
          data: [{ tenantId, role, tenantConnectorId: first.row.id }],
          skipDuplicates: true,
        });
      report.push({
        tenantId,
        role,
        action: 'BIND',
        connectorKey: first.row.connectorKey,
        candidates,
        ambiguous: candidates.length > 1,
      });
    }
  }
  return report;
}
