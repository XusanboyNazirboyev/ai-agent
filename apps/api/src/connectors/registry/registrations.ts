import { MockConnectorConfigSchema } from '@agentcore/shared';
import { Bitrix24Connector } from '../bitrix24/bitrix24-connector.js';
import { GenericRestConnector } from '../generic-rest/generic-rest-connector.js';
import { OutboundUrlPolicy } from '../generic-rest/ssrf-protection.js';
import { ConnectorConfigurationError } from '../interfaces/errors.js';
import { MockConnector } from '../mock/mock-connector.js';
import { allFixtures } from '../mock/mock-fixtures.js';
import type { ConnectorRegistration } from './connector-registry.js';

export const MOCK_CONNECTOR_KEY = 'mock';
export const GENERIC_REST_CONNECTOR_KEY = 'generic-rest';
export const BITRIX24_CONNECTOR_KEY = 'bitrix24';

/** Fictional in-memory catalog for development, demos and tests. */
export function mockConnectorRegistration(): ConnectorRegistration {
  return {
    key: MOCK_CONNECTOR_KEY,
    capabilities: {
      sync: true,
      search: true,
      liveQuote: true,
      availability: true,
      createLead: true,
      updateLead: true,
      createBooking: true,
      webhooks: true,
    },
    factory: (context, config): MockConnector => {
      const parsed = MockConnectorConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ConnectorConfigurationError({
          message: 'Invalid mock connector configuration',
          code: 'CONNECTOR_INVALID_CONFIG',
          source: context.connectorKey,
        });
      }
      return new MockConnector(context, {
        ...parsed.data,
        items: allFixtures(parsed.data.sourceSystem),
      });
    },
  };
}

/**
 * Generic REST connector. The outbound policy is a deployment setting passed
 * by code (validated environment), never read from tenant configuration.
 */
export function genericRestConnectorRegistration(options: {
  readonly outboundUrlPolicy: OutboundUrlPolicy;
}): ConnectorRegistration {
  return {
    key: GENERIC_REST_CONNECTOR_KEY,
    capabilities: {
      sync: true,
      search: true,
      liveQuote: true,
      availability: true,
      createLead: true,
      updateLead: true,
      createBooking: true,
      webhooks: false,
    },
    factory: (context, config, dependencies) =>
      new GenericRestConnector(context, config, {
        resolveSecret: dependencies.resolveSecret,
        outboundUrlPolicy: options.outboundUrlPolicy,
      }),
  };
}

/**
 * Bitrix24 cloud as a lead sink through an inbound webhook: lead creation
 * only (docs/connectors/bitrix24/CONNECTOR_PLAN.md).
 */
export function bitrix24ConnectorRegistration(): ConnectorRegistration {
  return {
    key: BITRIX24_CONNECTOR_KEY,
    capabilities: {
      sync: false,
      search: false,
      liveQuote: false,
      availability: false,
      createLead: true,
      updateLead: false,
      createBooking: false,
      webhooks: false,
    },
    factory: (context, config, dependencies) =>
      new Bitrix24Connector(context, config, {
        resolveSecret: dependencies.resolveSecret,
      }),
  };
}
