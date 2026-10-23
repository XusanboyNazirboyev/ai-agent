import { Injectable } from '@nestjs/common';
import { parseTenantConnectorConfig } from '@agentcore/shared';
import type { TenantConnector } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import {
  CAPABILITY_METHODS,
  type ConnectorCapabilities,
  type CrmConnector,
} from '../interfaces/crm-connector.js';
import {
  ConnectorCapabilityError,
  ConnectorConfigurationError,
} from '../interfaces/errors.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';

/**
 * Builds connector instances from stored tenant connector rows.
 *
 * Connection settings come only from the validated `tenant_connectors` row
 * (never from conversation input), are checked against the shared connector
 * contract, and must agree with any capabilities recorded on the row.
 */
@Injectable()
export class TenantConnectorLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
  ) {}

  findActive(
    tenantId: string,
    tenantConnectorId: string,
  ): Promise<TenantConnector | null> {
    return this.prisma.tenantConnector.findFirst({
      where: { id: tenantConnectorId, tenantId, status: 'ACTIVE' },
    });
  }

  listActive(): Promise<TenantConnector[]> {
    return this.prisma.tenantConnector.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    });
  }

  create(row: TenantConnector): CrmConnector {
    const parsed = parseTenantConnectorConfig(row.connectorKey, row.config);
    if (!parsed.success) {
      throw new ConnectorConfigurationError({
        message: `Invalid configuration for connector '${row.connectorKey}': ${parsed.issues.join('; ')}`,
        code: 'CONNECTOR_INVALID_CONFIG',
        source: row.connectorKey,
      });
    }
    if (row.secretRef !== null) {
      // Credential references belong in the validated `auth` block; a second,
      // unvalidated location would let them bypass the secret namespace.
      throw new ConnectorConfigurationError({
        message: `Connector '${row.connectorKey}' must reference secrets in config.auth, not secret_ref`,
        code: 'CONNECTOR_SECRET_REF_UNSUPPORTED',
        source: row.connectorKey,
      });
    }

    const connector = this.registry.create(
      { tenantId: row.tenantId, connectorKey: row.connectorKey },
      row.config as Record<string, unknown>,
    );
    assertStoredCapabilities(row, connector.capabilities);
    return connector;
  }
}

/**
 * A row may record the capabilities an operator expects; they must match what
 * the connector actually advertises, so neither side can silently drift.
 */
export function assertStoredCapabilities(
  row: Pick<TenantConnector, 'capabilities' | 'connectorKey'>,
  capabilities: ConnectorCapabilities,
): void {
  if (row.capabilities.length === 0) return;
  const advertised = (
    Object.keys(CAPABILITY_METHODS) as Array<keyof ConnectorCapabilities>
  )
    .filter((capability) => capabilities[capability])
    .sort();
  const stored = [...new Set(row.capabilities)].sort();
  if (stored.join(',') !== advertised.join(',')) {
    throw new ConnectorCapabilityError({
      message: `Connector '${row.connectorKey}' stored capabilities [${stored.join(', ')}] differ from advertised [${advertised.join(', ')}]`,
      code: 'CONNECTOR_CAPABILITY_MISMATCH',
      source: row.connectorKey,
    });
  }
}
