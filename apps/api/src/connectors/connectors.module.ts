import { Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OutboundUrlPolicy } from './generic-rest/ssrf-protection.js';
import type { SecretResolver } from './interfaces/secret-resolver.js';
import { ConnectorRegistry } from './registry/connector-registry.js';
import {
  bitrix24ConnectorRegistration,
  genericRestConnectorRegistration,
  mockConnectorRegistration,
} from './registry/registrations.js';
import { EnvSecretResolver } from './registry/secret-resolver.js';
import { CatalogSyncQueueRuntime } from './sync/catalog-sync.queue.js';
import { CatalogSyncService } from './sync/catalog-sync.service.js';
import { CatalogSyncStore } from './sync/catalog-sync.store.js';
import { TenantConnectorLoader } from './sync/tenant-connector-loader.js';

export function createConnectorRegistry(
  environment: Pick<AppEnvironment, 'NODE_ENV' | 'CONNECTOR_OUTBOUND_POLICY'>,
  secretResolver: SecretResolver = new EnvSecretResolver(),
): ConnectorRegistry {
  const registry = new ConnectorRegistry(secretResolver);
  registry.register(
    genericRestConnectorRegistration({
      outboundUrlPolicy:
        environment.CONNECTOR_OUTBOUND_POLICY === 'permissive'
          ? OutboundUrlPolicy.PERMISSIVE
          : OutboundUrlPolicy.STRICT,
    }),
  );
  registry.register(bitrix24ConnectorRegistration());
  // The mock serves fictional catalog data and prices; it must never be
  // selectable for real customers.
  if (environment.NODE_ENV !== 'production') {
    registry.register(mockConnectorRegistration());
  }
  return registry;
}

@Module({
  imports: [PersistenceModule],
  providers: [
    CatalogSyncStore,
    TenantConnectorLoader,
    CatalogSyncService,
    CatalogSyncQueueRuntime,
    {
      provide: ConnectorRegistry,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
      ): ConnectorRegistry =>
        createConnectorRegistry({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          CONNECTOR_OUTBOUND_POLICY: config.get('CONNECTOR_OUTBOUND_POLICY', {
            infer: true,
          }),
        }),
    },
  ],
  exports: [
    ConnectorRegistry,
    CatalogSyncQueueRuntime,
    CatalogSyncStore,
    TenantConnectorLoader,
  ],
})
export class ConnectorsModule implements OnModuleDestroy {
  constructor(private readonly registry: ConnectorRegistry) {}

  async onModuleDestroy(): Promise<void> {
    await this.registry.shutdownAll();
  }
}
