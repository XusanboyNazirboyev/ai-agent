import {
  parseTenantConnectorConfig,
  type GenericRestConnectorConfig,
  type PaginationConfig,
  type RestEndpointKey,
} from '@agentcore/shared';
import type { ConnectorCapabilities } from '../interfaces/crm-connector.js';
import { ConnectorConfigurationError } from '../interfaces/errors.js';

/**
 * Runtime helpers for GenericRestConnector configuration. The schema itself
 * is the shared tenant connector contract (`@agentcore/shared`
 * connector-config), so the API, the registry and a future admin UI validate
 * exactly the same shape.
 */
export {
  ENDPOINT_PLACEHOLDERS,
  FieldMappingsSchema,
  GenericRestConnectorConfigSchema,
  JsonPathSchema,
  PaginationConfigSchema,
  REST_ENDPOINT_KEYS,
  RestAuthSchema,
  RestEndpointConfigSchema,
  type FieldMappings,
  type GenericRestConnectorConfig,
  type PaginationConfig,
  type RequestField,
  type RestAuth,
  type RestEndpointConfig,
  type RestEndpointKey,
} from '@agentcore/shared';

const FORBIDDEN_PATH_SEGMENTS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/** Default pagination applied when an endpoint does not configure pagination. */
export const DefaultPagination: PaginationConfig = {
  strategy: 'none',
  limitParam: 'limit',
  offsetParam: 'offset',
  pageSize: 50,
  cursorParam: 'cursor',
  cursorPath: 'nextCursor',
  maxPages: 20,
};

/**
 * Maps the endpoint that satisfies each advertised capability.
 *
 * A capability is advertised only when the endpoint behind its contract
 * method (see `CAPABILITY_METHODS`) is configured. `getItem` and `getOffers`
 * are auxiliary catalog reads: they work when their endpoint is configured
 * and otherwise fail with CONNECTOR_CAPABILITY_UNSUPPORTED, but they never
 * advertise `search` on their own.
 */
export const CAPABILITY_ENDPOINT: Readonly<
  Partial<Record<keyof ConnectorCapabilities, RestEndpointKey>>
> = {
  sync: 'listItems',
  search: 'searchItems',
  liveQuote: 'getQuote',
  availability: 'checkAvailability',
  createLead: 'createLead',
  updateLead: 'updateLead',
  createBooking: 'createBooking',
};

/** Derives connector capabilities from the configured endpoints. */
export function deriveCapabilities(
  endpoints: GenericRestConnectorConfig['endpoints'],
): ConnectorCapabilities {
  const has = (capability: keyof ConnectorCapabilities): boolean => {
    const key = CAPABILITY_ENDPOINT[capability];
    return key !== undefined && endpoints[key] !== undefined;
  };
  return {
    sync: has('sync'),
    search: has('search'),
    liveQuote: has('liveQuote'),
    availability: has('availability'),
    createLead: has('createLead'),
    updateLead: has('updateLead'),
    createBooking: has('createBooking'),
    // Inbound change webhooks are not implemented for generic REST.
    webhooks: false,
  };
}

/**
 * Parses tenant configuration. Failures become a ConnectorConfigurationError
 * listing field paths and reasons only, never the submitted values (which may
 * include secrets pasted into the wrong field).
 */
export function parseGenericRestConnectorConfig(
  input: unknown,
): GenericRestConnectorConfig {
  const result = parseTenantConnectorConfig('generic-rest', input);
  if (result.success) return result.data as GenericRestConnectorConfig;
  throw new ConnectorConfigurationError({
    message: `Invalid generic REST connector configuration: ${result.issues.join('; ')}`,
    code: 'CONNECTOR_INVALID_CONFIG',
  });
}

/**
 * Resolve a value from a dot-path in a JSON object.
 *
 * Only own properties are followed (never the prototype chain), and numeric
 * segments index into arrays. `$` returns the object itself.
 */
export function getByPath(object: unknown, path: string): unknown {
  if (object == null || typeof path !== 'string' || path.length === 0) {
    return undefined;
  }
  if (path === '$') return object;
  let current: unknown = object;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (
      FORBIDDEN_PATH_SEGMENTS.has(segment) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
