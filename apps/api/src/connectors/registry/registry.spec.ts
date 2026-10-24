import { describe, expect, it, vi } from 'vitest';
import { OutboundUrlPolicy } from '../generic-rest/ssrf-protection.js';
import type {
  ConnectorCapabilities,
  CrmConnector,
} from '../interfaces/crm-connector.js';
import { nullSecretResolver } from '../interfaces/secret-resolver.js';
import { ConnectorRegistry } from './connector-registry.js';
import {
  genericRestConnectorRegistration,
  mockConnectorRegistration,
} from './registrations.js';
import { EnvSecretResolver } from './secret-resolver.js';

const none: ConnectorCapabilities = {
  sync: false,
  search: false,
  liveQuote: false,
  availability: false,
  createLead: false,
  updateLead: false,
  createBooking: false,
  webhooks: false,
};

const tenantA = { tenantId: 'tenant-a', connectorKey: 'mock' };

describe('ConnectorRegistry', () => {
  it('creates registered connectors and reuses unchanged instances', () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    registry.register(mockConnectorRegistration());

    const first = registry.create(tenantA, { sourceSystem: 'mock-education' });
    const second = registry.create(tenantA, { sourceSystem: 'mock-education' });
    const otherTenant = registry.create(
      { ...tenantA, tenantId: 'tenant-b' },
      { sourceSystem: 'mock-education' },
    );

    expect(second).toBe(first);
    expect(otherTenant).not.toBe(first);
  });

  it('replaces and shuts down an instance whose configuration changed', async () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    registry.register(mockConnectorRegistration());
    const first = registry.create(tenantA, { sourceSystem: 'mock-education' });
    const shutdown = vi.spyOn(first, 'shutdown');

    const replaced = registry.create(tenantA, { sourceSystem: 'mock-tourism' });
    await Promise.resolve();

    expect(replaced).not.toBe(first);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('rejects unknown connectors and invalid configuration', () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    registry.register(mockConnectorRegistration());
    expect(() =>
      registry.create({ tenantId: 'tenant-a', connectorKey: 'unknown' }, {}),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_NOT_REGISTERED' }));
    expect(() =>
      registry.create(tenantA, { sourceSystem: 'Bad Name' }),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_INVALID_CONFIG' }));
  });

  it('rejects a connector advertising an unimplemented capability', () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    registry.register({
      key: 'broken',
      capabilities: { ...none, search: true },
      factory: (context): CrmConnector => ({
        connectorKey: context.connectorKey,
        context,
        capabilities: { ...none, search: true },
      }),
    });
    expect(() =>
      registry.create({ tenantId: 'tenant-a', connectorKey: 'broken' }, {}),
    ).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_CAPABILITY_MISMATCH' }),
    );
  });

  it('rejects lookup idempotency without a lookup method, and unknown modes', () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    for (const [key, mode] of [
      ['no-lookup', 'lookup'],
      ['odd-mode', 'exactly-once'],
    ] as const) {
      registry.register({
        key,
        capabilities: { ...none, createLead: true },
        factory: (context): CrmConnector =>
          ({
            connectorKey: context.connectorKey,
            context,
            capabilities: { ...none, createLead: true },
            createLead: async () => ({ crmLeadId: 'x' }),
            writeIdempotency: mode,
          }) as unknown as CrmConnector,
      });
      expect(() =>
        registry.create({ tenantId: 'tenant-a', connectorKey: key }, {}),
      ).toThrow(
        expect.objectContaining({ code: 'CONNECTOR_CAPABILITY_MISMATCH' }),
      );
    }
  });

  it('rejects a connector advertising beyond its registration', () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    registry.register({
      key: 'overreaching',
      capabilities: none,
      factory: (context): CrmConnector => ({
        connectorKey: context.connectorKey,
        context,
        capabilities: { ...none, createLead: true },
        createLead: async () => ({ crmLeadId: 'x' }),
      }),
    });
    expect(() =>
      registry.create(
        { tenantId: 'tenant-a', connectorKey: 'overreaching' },
        {},
      ),
    ).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_CAPABILITY_MISMATCH' }),
    );
  });

  it('passes the deployment outbound policy to generic REST connectors', () => {
    const registry = new ConnectorRegistry(nullSecretResolver);
    registry.register(
      genericRestConnectorRegistration({
        outboundUrlPolicy: OutboundUrlPolicy.STRICT,
      }),
    );
    expect(() =>
      registry.create(
        { tenantId: 'tenant-a', connectorKey: 'generic-rest' },
        { baseUrl: 'http://localhost:8080' },
      ),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }));
  });
});

describe('EnvSecretResolver', () => {
  const resolver = new EnvSecretResolver({
    CONNECTOR_SECRET_CRM_TOKEN: 'connector-value',
    CONNECTOR_SECRET_EMPTY: '',
    POSTGRES_PASSWORD: 'platform-value',
    TELEGRAM_BOT_TOKEN: 'platform-bot-token',
  });

  it('resolves only references inside the connector namespace', () => {
    expect(resolver.resolve('env:CONNECTOR_SECRET_CRM_TOKEN')).toBe(
      'connector-value',
    );
    for (const ref of [
      'env:POSTGRES_PASSWORD',
      'env:TELEGRAM_BOT_TOKEN',
      'POSTGRES_PASSWORD',
      'CONNECTOR_SECRET_CRM_TOKEN',
      'vault:CONNECTOR_SECRET_CRM_TOKEN',
      'env:CONNECTOR_SECRET_EMPTY',
      'env:CONNECTOR_SECRET_MISSING',
      undefined,
    ]) {
      expect(resolver.resolve(ref)).toBeUndefined();
    }
  });
});

describe('createConnectorRegistry', () => {
  it('registers the mock connector outside production only', async () => {
    const { createConnectorRegistry } = await import('../connectors.module.js');
    const development = createConnectorRegistry({
      NODE_ENV: 'development',
      CONNECTOR_OUTBOUND_POLICY: 'strict',
    });
    const production = createConnectorRegistry({
      NODE_ENV: 'production',
      CONNECTOR_OUTBOUND_POLICY: 'strict',
    });
    expect(development.has('mock')).toBe(true);
    expect(production.has('mock')).toBe(false);
    expect(production.has('generic-rest')).toBe(true);
  });

  it('applies the permissive policy only when the deployment selects it', async () => {
    const { createConnectorRegistry } = await import('../connectors.module.js');
    const config = { baseUrl: 'http://localhost:8080' };
    const context = { tenantId: 'tenant-a', connectorKey: 'generic-rest' };
    expect(() =>
      createConnectorRegistry({
        NODE_ENV: 'development',
        CONNECTOR_OUTBOUND_POLICY: 'strict',
      }).create(context, config),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }));
    expect(() =>
      createConnectorRegistry({
        NODE_ENV: 'development',
        CONNECTOR_OUTBOUND_POLICY: 'permissive',
      }).create(context, config),
    ).not.toThrow();
  });
});
