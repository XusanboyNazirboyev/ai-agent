import { Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { ConnectorSelector } from './connector-selector.js';
import { OutboundUrlPolicy } from './generic-rest/ssrf-protection.js';
import type { SecretResolver } from './interfaces/secret-resolver.js';
import { ConnectorRegistry } from './registry/connector-registry.js';
import {
  bitrix24ConnectorRegistration,
  genericRestConnectorRegistration,
  mockConnectorRegistration,
  spreadsheetConnectorRegistration,
} from './registry/registrations.js';
import { EnvSecretResolver } from './registry/secret-resolver.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  SHEET_FETCH_OPTIONS,
  SheetCatalogService,
} from './spreadsheet/sheet-catalog.service.js';
import {
  PrismaSheetCatalogStore,
  type SheetCatalogReader,
} from './spreadsheet/sheet-catalog.store.js';
import { CatalogSyncQueueRuntime } from './sync/catalog-sync.queue.js';
import { CatalogSyncService } from './sync/catalog-sync.service.js';
import { CatalogSyncStore } from './sync/catalog-sync.store.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { TenantConnectorLoader } from './sync/tenant-connector-loader.js';

export function createConnectorRegistry(
  environment: Pick<AppEnvironment, 'NODE_ENV' | 'CONNECTOR_OUTBOUND_POLICY'> &
    Partial<Pick<AppEnvironment, 'CONNECTOR_DEMO_CATALOG'>>,
  secretResolver: SecretResolver = new EnvSecretResolver(),
  /** The uploaded price list (ADR 064); without it the `spreadsheet` connector is not offered. */
  sheetCatalog?: SheetCatalogReader,
): ConnectorRegistry {
  const registry = new ConnectorRegistry(secretResolver);
  if (sheetCatalog)
    registry.register(spreadsheetConnectorRegistration(sheetCatalog));
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
  // selectable for real customers. A staging server with test data only may
  // opt in explicitly (CONNECTOR_DEMO_CATALOG=on).
  if (
    environment.NODE_ENV !== 'production' ||
    environment.CONNECTOR_DEMO_CATALOG === 'on'
  ) {
    registry.register(mockConnectorRegistration());
  }
  if (
    environment.NODE_ENV === 'production' &&
    environment.CONNECTOR_DEMO_CATALOG === 'on'
  )
    new Logger('ConnectorRegistry').warn(
      JSON.stringify({
        event: 'connector.demo_catalog_enabled',
        note: 'fictional courses and prices are selectable; test data only',
      }),
    );
  return registry;
}

@Module({
  imports: [PersistenceModule, SecretsModule],
  providers: [
    CatalogSyncStore,
    TenantConnectorLoader,
    ConnectorSelector,
    CatalogSyncService,
    CatalogSyncQueueRuntime,
    {
      provide: SHEET_FETCH_OPTIONS,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
      ): { origin?: string } => {
        const origin = config.get('GOOGLE_SHEETS_TEST_BASE_URL', {
          infer: true,
        });
        return origin ? { origin } : {};
      },
    },
    SheetCatalogService,
    {
      provide: PrismaSheetCatalogStore,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): PrismaSheetCatalogStore =>
        new PrismaSheetCatalogStore(prisma),
    },
    {
      provide: ConnectorRegistry,
      inject: [ConfigService, PrismaSheetCatalogStore],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        sheetCatalog: PrismaSheetCatalogStore,
      ): ConnectorRegistry =>
        createConnectorRegistry(
          {
            NODE_ENV: config.get('NODE_ENV', { infer: true }),
            CONNECTOR_OUTBOUND_POLICY: config.get('CONNECTOR_OUTBOUND_POLICY', {
              infer: true,
            }),
            CONNECTOR_DEMO_CATALOG: config.get('CONNECTOR_DEMO_CATALOG', {
              infer: true,
            }),
          },
          undefined,
          sheetCatalog,
        ),
    },
  ],
  exports: [
    SheetCatalogService,
    PrismaSheetCatalogStore,
    ConnectorRegistry,
    CatalogSyncQueueRuntime,
    CatalogSyncStore,
    TenantConnectorLoader,
    ConnectorSelector,
  ],
})
export class ConnectorsModule implements OnModuleDestroy {
  constructor(private readonly registry: ConnectorRegistry) {}

  async onModuleDestroy(): Promise<void> {
    await this.registry.shutdownAll();
  }
}
