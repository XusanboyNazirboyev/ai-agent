import { GenericRestConnector } from './generic-rest/generic-rest-connector.js';
import { RestHttpClient } from './generic-rest/http-client.js';
import { MockConnector } from './mock/mock-connector.js';
import { allFixtures } from './mock/mock-fixtures.js';
import { EnvSecretResolver } from './registry/secret-resolver.js';
import { describeConnectorConformance } from './testing/conformance.js';
import {
  FICTIONAL_CRM_TOKEN,
  fictionalCrmConfig,
  startFictionalCrm,
} from './testing/fictional-crm.js';

function mockSubject(sourceSystem: string): () => Promise<{
  connector: MockConnector;
}> {
  return async () => ({
    connector: new MockConnector(
      { tenantId: 'tenant-conformance', connectorKey: 'mock' },
      { sourceSystem, items: allFixtures(sourceSystem) },
    ),
  });
}

describeConnectorConformance({
  name: 'MockConnector (fictional education catalog)',
  setup: mockSubject('mock-education'),
  samples: {
    searchTitle: 'IELTS',
    itemId: 'mock-education:edu-ielts-001',
    offerId: 'mock-education:offer:ielts-group-weekday',
    missingItemId: 'mock-education:missing',
    missingOfferId: 'mock-education:offer:missing',
  },
});

describeConnectorConformance({
  name: 'MockConnector (fictional tourism catalog)',
  setup: mockSubject('mock-tourism'),
  samples: {
    searchTitle: 'Antalya',
    itemId: 'mock-tourism:tour-antalya-001',
    offerId: 'mock-tourism:offer:antalya-departure-2026-06-15',
    missingItemId: 'mock-tourism:missing',
    missingOfferId: 'mock-tourism:offer:missing',
  },
});

async function genericRestSubject(
  configure: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ connector: GenericRestConnector; close: () => Promise<void> }> {
  const crm = await startFictionalCrm();
  const connector = new GenericRestConnector(
    { tenantId: 'tenant-conformance', connectorKey: 'generic-rest' },
    configure(fictionalCrmConfig(crm.port)),
    {
      httpClient: new RestHttpClient({
        resolve: async (): Promise<
          Array<{ address: string; family: number }>
        > => [{ address: '127.0.0.1', family: 4 }],
        exemptLoopbackAddresses: ['127.0.0.1'],
      }),
      resolveSecret: new EnvSecretResolver({
        CONNECTOR_SECRET_FICTIONAL_CRM: FICTIONAL_CRM_TOKEN,
      }),
    },
  );
  return { connector, close: () => crm.close() };
}

describeConnectorConformance({
  name: 'GenericRestConnector (fictional CRM, all endpoints)',
  setup: () => genericRestSubject((config) => config),
  samples: {
    searchTitle: 'Alpha',
    itemId: 'generic-rest:course-a',
    offerId: 'generic-rest:offer:group-a1',
    missingItemId: 'generic-rest:course-zz',
    missingOfferId: 'generic-rest:offer:group-zz',
  },
});

describeConnectorConformance({
  name: 'GenericRestConnector (fictional CRM, read-only catalog)',
  setup: () =>
    genericRestSubject((config) => {
      const endpoints = config.endpoints as Record<string, unknown>;
      return {
        ...config,
        endpoints: {
          listItems: endpoints.listItems,
          getItem: endpoints.getItem,
        },
      };
    }),
  samples: {
    itemId: 'generic-rest:course-b',
    missingItemId: 'generic-rest:course-zz',
  },
});
