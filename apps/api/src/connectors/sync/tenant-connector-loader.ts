import { Injectable, Optional } from '@nestjs/common';
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
import {
  ConnectorSecretStore,
  isConnectorSecretPurpose,
} from '../../secrets/connector-secret-store.js';
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
    @Optional() private readonly secrets?: ConnectorSecretStore,
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

  async create(row: TenantConnector): Promise<CrmConnector> {
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

    const stored = await this.storedSecrets(row);
    const connector = this.registry.create(
      { tenantId: row.tenantId, connectorKey: row.connectorKey },
      row.config as Record<string, unknown>,
      stored,
    );
    assertStoredCapabilities(row, connector.capabilities);
    return connector;
  }

  /**
   * `store:<purpose>` references in the row's config (ADR 032) resolve to the
   * row's own encrypted secret. Without a store, or for an unknown purpose,
   * nothing is resolved and the connector fails closed as for a missing env
   * secret.
   */
  private async storedSecrets(row: TenantConnector): Promise<{
    storedSecrets?: ReadonlyMap<string, string>;
    secretVersion?: string;
  }> {
    const refs = storeReferences(row.config);
    if (refs.length === 0 || !this.secrets?.configured) return {};
    const values = new Map<string, string>();
    const versions: string[] = [];
    for (const ref of refs) {
      const purpose = ref.slice('store:'.length);
      if (!isConnectorSecretPurpose(purpose)) continue;
      const secret = await this.secrets.read(
        { tenantId: row.tenantId, tenantConnectorId: row.id },
        purpose,
      );
      if (!secret) continue;
      values.set(ref, secret.value);
      versions.push(`${purpose}:${secret.version}`);
    }
    return { storedSecrets: values, secretVersion: versions.join(',') };
  }
}

const STORE_REF = /^store:[a-z0-9_]{1,40}$/u;

/** Every `store:` reference anywhere in a connector config. */
export function storeReferences(config: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (STORE_REF.test(value)) found.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(walk);
  };
  walk(config);
  return [...found].sort();
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
