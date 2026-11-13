import { Injectable, Logger } from '@nestjs/common';
import type {
  ConnectorRole,
  TenantConnector,
} from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  CAPABILITY_METHODS,
  type ConnectorCapabilities,
  type CrmConnector,
} from './interfaces/crm-connector.js';
import { TenantConnectorLoader } from './sync/tenant-connector-loader.js';

export type ConnectorCapabilityName = keyof ConnectorCapabilities;

export const CONNECTOR_ROLES: readonly ConnectorRole[] = [
  'CATALOG',
  'LEAD_SINK',
  'ACTIONS',
];

/** The capability a role needs when the caller does not name one (ADR 059). */
export function defaultCapability(
  role: ConnectorRole,
): ConnectorCapabilityName | undefined {
  if (role === 'CATALOG') return 'search';
  if (role === 'LEAD_SINK') return 'createLead';
  return undefined;
}

/** Search was only ever checked by its flag; write operations also by method. */
export function connectorHasCapability(
  connector: CrmConnector,
  capability: ConnectorCapabilityName,
): boolean {
  if (!connector.capabilities[capability]) return false;
  if (capability === 'search') return true;
  return typeof connector[CAPABILITY_METHODS[capability]] === 'function';
}

export type RoleResolution =
  | { kind: 'BOUND'; row: TenantConnector; connector: CrmConnector }
  | { kind: 'UNAVAILABLE'; row: TenantConnector; errorName: string }
  | {
      kind: 'UNBOUND';
      candidates: Array<{ row: TenantConnector; connector: CrmConnector }>;
    };

/**
 * One place that decides which connector serves a role of a tenant (ADR 059).
 * A bound role uses exactly that connector and never falls back; an unbound
 * role uses the only capable ACTIVE connector, or none when several could.
 */
@Injectable()
export class ConnectorSelector {
  private readonly logger = new Logger(ConnectorSelector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
  ) {}

  async select(
    tenantId: string,
    role: ConnectorRole,
    needed?: ConnectorCapabilityName,
  ): Promise<CrmConnector | undefined> {
    const resolution = await this.resolve(tenantId, role, needed);
    if (resolution.kind === 'BOUND') return resolution.connector;
    if (resolution.kind === 'UNAVAILABLE') {
      this.logger.warn(
        JSON.stringify({
          event: 'connector.bound_unavailable',
          tenant: tenantId,
          role,
          connector: resolution.row.connectorKey,
          name: resolution.errorName,
        }),
      );
      return undefined;
    }
    if (resolution.candidates.length === 1)
      return resolution.candidates[0]!.connector;
    if (resolution.candidates.length > 1)
      this.logger.warn(
        JSON.stringify({
          event: 'connector.ambiguous',
          tenant: tenantId,
          role,
          candidates: resolution.candidates.map((c) => c.row.connectorKey),
        }),
      );
    return undefined;
  }

  /** The decision without logging; also feeds the status API and backfill. */
  async resolve(
    tenantId: string,
    role: ConnectorRole,
    needed?: ConnectorCapabilityName,
  ): Promise<RoleResolution> {
    const capability = needed ?? defaultCapability(role) ?? 'createLead';
    const binding = await this.prisma.tenantConnectorRole.findFirst({
      where: { tenantId, role },
      include: { connector: true },
    });
    if (binding) {
      const row = binding.connector;
      if (row.status !== 'ACTIVE')
        return { kind: 'UNAVAILABLE', row, errorName: 'ConnectorNotActive' };
      try {
        const connector = await this.loader.create(row);
        if (!connectorHasCapability(connector, capability))
          return {
            kind: 'UNAVAILABLE',
            row,
            errorName: 'ConnectorCapabilityMissing',
          };
        return { kind: 'BOUND', row, connector };
      } catch (error: unknown) {
        return {
          kind: 'UNAVAILABLE',
          row,
          errorName: (error as Error).name,
        };
      }
    }
    const rows = await this.prisma.tenantConnector.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    const candidates: Array<{ row: TenantConnector; connector: CrmConnector }> =
      [];
    for (const row of rows) {
      try {
        const connector = await this.loader.create(row);
        if (connectorHasCapability(connector, capability))
          candidates.push({ row, connector });
      } catch {
        // An unusable connector cannot serve the role; it is not a candidate.
      }
    }
    return { kind: 'UNBOUND', candidates };
  }
}
