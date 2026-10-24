import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectorCapabilities,
  ConnectorContext,
  ConnectorFactory,
  CrmConnector,
} from '../interfaces/crm-connector.js';
import { CAPABILITY_METHODS } from '../interfaces/crm-connector.js';
import {
  ConnectorCapabilityError,
  ConnectorConfigurationError,
} from '../interfaces/errors.js';
import type { SecretResolver } from '../interfaces/secret-resolver.js';
import { stableStringify } from '../stable-json.js';

export interface ConnectorRegistration {
  readonly key: string;
  readonly factory: ConnectorFactory;
  /** The most a connector of this kind may advertise. */
  readonly capabilities: ConnectorCapabilities;
}

interface CachedConnector {
  readonly fingerprint: string;
  readonly connector: CrmConnector;
}

/**
 * Registry of connector implementations keyed by connector key.
 *
 * Creates a connector instance from validated tenant configuration, verifies
 * the instance's advertised capabilities against both its implementation and
 * its registration, and fails clearly when a connector is unknown. Instances
 * are cached per tenant+connector key (bounded by the number of configured
 * tenant connectors) and replaced when their configuration changes, so a
 * config update never keeps serving stale settings.
 */
export class ConnectorRegistry {
  private readonly logger = new Logger(ConnectorRegistry.name);
  private readonly registrations = new Map<string, ConnectorRegistration>();
  private readonly instances = new Map<string, CachedConnector>();
  private readonly secretResolver: SecretResolver;

  constructor(secretResolver: SecretResolver) {
    this.secretResolver = secretResolver;
  }

  register(registration: ConnectorRegistration): void {
    if (this.registrations.has(registration.key)) {
      throw new Error(`Connector '${registration.key}' is already registered`);
    }
    this.registrations.set(registration.key, registration);
    this.logger.log(
      JSON.stringify({
        event: 'connector.registered',
        connector: registration.key,
        capabilities: registration.capabilities,
      }),
    );
  }

  has(key: string): boolean {
    return this.registrations.has(key);
  }

  getDeclaredCapabilities(key: string): ConnectorCapabilities | undefined {
    return this.registrations.get(key)?.capabilities;
  }

  /**
   * Create (or reuse) a connector for a tenant. Validates that the connector is
   * registered and that its advertised capabilities are implemented and
   * within its registration.
   */
  create(
    context: ConnectorContext,
    config: Record<string, unknown>,
    options: { resolveSecret?: SecretResolver } = {},
  ): CrmConnector {
    if (!context.tenantId || !context.connectorKey) {
      throw new ConnectorConfigurationError({
        message: 'Connector context requires tenantId and connectorKey',
      });
    }
    const instanceKey = `${context.tenantId}:${context.connectorKey}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify(config))
      .digest('hex');
    const existing = this.instances.get(instanceKey);
    if (existing?.fingerprint === fingerprint) return existing.connector;

    const registration = this.registrations.get(context.connectorKey);
    if (!registration) {
      throw new ConnectorConfigurationError({
        message: `Connector '${context.connectorKey}' is not registered`,
        code: 'CONNECTOR_NOT_REGISTERED',
        source: context.connectorKey,
      });
    }

    const connector = registration.factory(context, config, {
      resolveSecret: options.resolveSecret ?? this.secretResolver,
    });
    this.verifyCapabilities(connector, registration);

    if (existing) this.retire(existing.connector);
    this.instances.set(instanceKey, { fingerprint, connector });
    return connector;
  }

  /** Drops a cached instance (e.g. after its tenant connector was disabled). */
  async invalidate(tenantId: string, connectorKey: string): Promise<void> {
    const instanceKey = `${tenantId}:${connectorKey}`;
    const existing = this.instances.get(instanceKey);
    if (!existing) return;
    this.instances.delete(instanceKey);
    await this.shutdownConnector(existing.connector);
  }

  private retire(connector: CrmConnector): void {
    void this.shutdownConnector(connector);
  }

  private async shutdownConnector(connector: CrmConnector): Promise<void> {
    try {
      await connector.shutdown?.();
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'connector.shutdown_failed',
          connector: connector.connectorKey,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }

  private verifyCapabilities(
    connector: CrmConnector,
    registration: ConnectorRegistration,
  ): void {
    const key = registration.key;
    for (const capability of Object.keys(CAPABILITY_METHODS) as Array<
      keyof ConnectorCapabilities
    >) {
      const advertised = connector.capabilities?.[capability];
      if (typeof advertised !== 'boolean') {
        throw new ConnectorCapabilityError({
          message: `Connector '${key}' must declare capability '${capability}' as a boolean`,
          code: 'CONNECTOR_CAPABILITY_MISMATCH',
          source: key,
        });
      }
      if (!advertised) continue;
      const method = CAPABILITY_METHODS[capability];
      if (typeof connector[method] !== 'function') {
        throw new ConnectorCapabilityError({
          message: `Connector '${key}' advertises capability '${capability}' but does not implement '${String(method)}'`,
          code: 'CONNECTOR_CAPABILITY_MISMATCH',
          source: key,
        });
      }
      if (!registration.capabilities[capability]) {
        throw new ConnectorCapabilityError({
          message: `Connector '${key}' advertises capability '${capability}' beyond its registration`,
          code: 'CONNECTOR_CAPABILITY_MISMATCH',
          source: key,
        });
      }
    }
    const idempotency = connector.writeIdempotency ?? 'none';
    if (!['native', 'lookup', 'none'].includes(idempotency)) {
      throw new ConnectorCapabilityError({
        message: `Connector '${key}' declares an unknown write idempotency mode`,
        code: 'CONNECTOR_CAPABILITY_MISMATCH',
        source: key,
      });
    }
    if (
      idempotency === 'lookup' &&
      typeof connector.findLeadByIdempotencyKey !== 'function'
    ) {
      throw new ConnectorCapabilityError({
        message: `Connector '${key}' declares lookup idempotency but does not implement 'findLeadByIdempotencyKey'`,
        code: 'CONNECTOR_CAPABILITY_MISMATCH',
        source: key,
      });
    }
  }

  async shutdownAll(): Promise<void> {
    const connectors = Array.from(this.instances.values());
    this.instances.clear();
    await Promise.all(
      connectors.map(({ connector }) => this.shutdownConnector(connector)),
    );
  }
}
