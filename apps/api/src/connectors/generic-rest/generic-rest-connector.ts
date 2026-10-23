import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import {
  AvailabilitySchema,
  BookingInputSchema,
  CanonicalQuerySchema,
  CatalogItemSchema,
  LeadInputSchema,
  OfferSchema,
  QuoteSchema,
  type Availability,
  type AvailabilityStatus,
  type BookingInput,
  type CanonicalQuery,
  type CatalogItem,
  type LeadInput,
  type Offer,
  type PricingBasis,
  type Quote,
} from '../contracts/canonical.js';
import {
  ConnectorCapabilityError,
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorInvalidResponseError,
  ConnectorUnavailableError,
  isConnectorError,
  isRetryableConnectorError,
} from '../interfaces/errors.js';
import type {
  AvailabilityRequest,
  ConnectorCapabilities,
  ConnectorContext,
  CrmConnector,
  ListItemsParams,
  QuoteRequest,
} from '../interfaces/crm-connector.js';
import {
  nullSecretResolver,
  type SecretResolver,
} from '../interfaces/secret-resolver.js';
import {
  CircuitBreaker,
  CircuitBreakerError,
} from '../resilience/circuit-breaker.js';
import { retryWithBackoff } from '../resilience/retry.js';
import { RecordReader } from './field-mapping.js';
import {
  RestHttpClient,
  sendJson,
  type RestRequest,
  type RestResponse,
} from './http-client.js';
import {
  DefaultPagination,
  deriveCapabilities,
  getByPath,
  parseGenericRestConnectorConfig,
  type GenericRestConnectorConfig,
  type RestEndpointConfig,
  type RestEndpointKey,
} from './rest-config.js';
import { OutboundUrlPolicy, validateOutboundUrl } from './ssrf-protection.js';

const SOURCE_SYSTEM = /^[a-z0-9][a-z0-9-]{0,99}$/;
const DEFAULT_SEARCH_LIMIT = 50;
/** Writes are never retried here: a timeout may hide a committed write. */
const WRITE_OPERATIONS = new Set<RestEndpointKey>([
  'createLead',
  'updateLead',
  'createBooking',
]);

export interface GenericRestConnectorOptions {
  readonly httpClient?: RestHttpClient;
  readonly resolveSecret?: SecretResolver;
  readonly sourceSystem?: string;
  /** Deployment-level outbound policy; tenant configuration cannot set it. */
  readonly outboundUrlPolicy?: OutboundUrlPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/**
 * Configurable REST connector that adapts a supported CRM's REST API to the
 * canonical connector contract without any core code change per CRM.
 *
 * Capabilities are derived from the configured endpoints, and (per §5.2) each
 * contract method is *present* only when its endpoint is configured, so
 * consumers can gate on method presence and nothing is left as a stub that
 * pretends to exist. Every upstream record is mapped through explicit,
 * type-checked field mappings and validated against the canonical schema.
 */
export class GenericRestConnector implements CrmConnector {
  private readonly logger = new Logger(GenericRestConnector.name);
  readonly listItems?: (params?: ListItemsParams) => Promise<CatalogItem[]>;
  readonly searchItems?: (query: CanonicalQuery) => Promise<CatalogItem[]>;
  readonly getItem?: (id: string) => Promise<CatalogItem>;
  readonly getOffers?: (itemId: string) => Promise<Offer[]>;
  readonly checkAvailability?: (
    offerId: string,
    request: AvailabilityRequest,
  ) => Promise<Availability>;
  readonly getQuote?: (
    offerId: string,
    request: QuoteRequest,
  ) => Promise<Quote>;
  readonly createLead?: (input: LeadInput) => Promise<{ crmLeadId: string }>;
  readonly updateLead?: (
    crmLeadId: string,
    patch: Partial<LeadInput>,
  ) => Promise<void>;
  readonly createBooking?: (
    input: BookingInput,
  ) => Promise<{ bookingId: string }>;
  readonly connectorKey: string;
  readonly context: ConnectorContext;
  readonly capabilities: ConnectorCapabilities;
  readonly config: GenericRestConnectorConfig;
  private readonly httpClient: RestHttpClient;
  private readonly secrets: SecretResolver;
  private readonly breaker: CircuitBreaker;
  readonly sourceSystem: string;
  private readonly base: URL;
  private readonly basePath: string;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private initialized = false;

  constructor(
    context: ConnectorContext,
    config: unknown,
    options: GenericRestConnectorOptions = {},
  ) {
    this.context = context;
    this.connectorKey = context.connectorKey;
    this.config = parseGenericRestConnectorConfig(config);
    this.sourceSystem = options.sourceSystem ?? 'generic-rest';
    if (!SOURCE_SYSTEM.test(this.sourceSystem)) {
      throw new ConnectorConfigurationError({
        message: 'sourceSystem must be a lowercase identifier',
        source: this.connectorKey,
      });
    }

    const policy = options.outboundUrlPolicy ?? OutboundUrlPolicy.STRICT;
    // Fail at construction for a base URL the policy can never reach.
    validateOutboundUrl(this.config.baseUrl, {
      policy,
      source: this.connectorKey,
    });
    this.base = new URL(this.config.baseUrl);
    this.basePath = this.base.pathname.replace(/\/?$/, '/');

    this.httpClient =
      options.httpClient ??
      new RestHttpClient({
        defaultTimeoutMs: this.config.timeoutMs,
        policy,
        maxRedirects: this.config.maxRedirects,
        maxResponseBytes: this.config.maxResponseBytes,
      });
    this.secrets = options.resolveSecret ?? nullSecretResolver;
    this.sleep = options.sleep;

    // One breaker per tenant+connector instance keeps failure state isolated
    // between tenants. Only transient upstream failures count against it: a
    // 404 or a validation error proves the upstream is answering.
    this.breaker = new CircuitBreaker({
      name: `${context.tenantId}:${context.connectorKey}`,
      source: context.connectorKey,
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      recoveryIntervalMs: this.config.circuitBreaker.recoveryIntervalMs,
      halfOpenMaxAttempts: this.config.circuitBreaker.halfOpenMaxAttempts,
      isFailure: (error): boolean =>
        !isConnectorError(error) || error.retryable,
      now: options.now,
    });

    this.capabilities = deriveCapabilities(this.config.endpoints);

    const endpoints = this.config.endpoints;
    if (endpoints.listItems) this.listItems = this.listCatalog.bind(this);
    if (endpoints.searchItems) this.searchItems = this.searchCatalog.bind(this);
    if (endpoints.getItem) this.getItem = this.fetchItem.bind(this);
    if (endpoints.getOffers) this.getOffers = this.fetchOffers.bind(this);
    if (endpoints.checkAvailability) {
      this.checkAvailability = this.fetchAvailability.bind(this);
    }
    if (endpoints.getQuote) this.getQuote = this.fetchQuote.bind(this);
    if (endpoints.createLead) this.createLead = this.submitLead.bind(this);
    if (endpoints.updateLead) this.updateLead = this.patchLead.bind(this);
    if (endpoints.createBooking) {
      this.createBooking = this.submitBooking.bind(this);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.validateConfiguration();
    this.initialized = true;
    this.logger.log(
      JSON.stringify({
        event: 'connector.initialized',
        connector: this.connectorKey,
        tenant: this.context.tenantId,
        capabilities: this.capabilities,
      }),
    );
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  /** Verifies that every configured credential reference resolves. */
  async validateConfiguration(): Promise<void> {
    this.authHeaders();
  }

  private endpoint(
    key: RestEndpointKey,
    capability?: keyof ConnectorCapabilities,
  ): RestEndpointConfig {
    const endpoint = this.config.endpoints[key];
    if (!endpoint || (capability && !this.capabilities[capability])) {
      throw new ConnectorCapabilityError({
        message: `${key} is not supported by connector '${this.connectorKey}'`,
        code: 'CONNECTOR_CAPABILITY_UNSUPPORTED',
        source: this.connectorKey,
      });
    }
    return endpoint;
  }

  /** Rejects caller input; names fields only, never their values. */
  private invalidInput(what: string, fields: readonly string[] = []): never {
    throw new ConnectorError({
      message: `Invalid ${what} for connector '${this.connectorKey}'${
        fields.length > 0 ? `: ${fields.join(', ')}` : ''
      }`,
      code: 'CONNECTOR_INVALID_INPUT',
      category: ConnectorErrorCategory.VALIDATION,
      source: this.connectorKey,
    });
  }

  private input<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    return this.invalidInput(
      what,
      parsed.error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join('.') || '(root)'),
    );
  }

  private unsupportedFilter(filter: string): never {
    throw new ConnectorError({
      message: `Connector '${this.connectorKey}' cannot apply filter '${filter}'`,
      code: 'CONNECTOR_UNSUPPORTED_FILTER',
      category: ConnectorErrorCategory.VALIDATION,
      source: this.connectorKey,
    });
  }

  private canonical<T>(
    schema: z.ZodType<T>,
    value: unknown,
    entity: string,
  ): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new ConnectorInvalidResponseError({
      message: `Connector ${entity} does not satisfy the canonical contract`,
      code: 'CONNECTOR_INVALID_RECORD',
      source: this.connectorKey,
    });
  }

  /**
   * Executes one outbound operation with the configured resilience envelope:
   * circuit breaker per tenant+connector, bounded retry with backoff for
   * transient read failures only, and the HTTP client's own deadline (which
   * aborts the socket, unlike a promise race) plus SSRF/redirect checks.
   */
  private async request(
    operation: RestEndpointKey,
    request: Omit<RestRequest, 'timeoutMs' | 'headers'>,
  ): Promise<RestResponse> {
    const headers = this.authHeaders();
    const attempt = async (): Promise<RestResponse> => {
      try {
        return await this.breaker.execute(() =>
          sendJson(
            { ...request, headers, timeoutMs: this.config.timeoutMs },
            this.httpClient,
          ),
        );
      } catch (error: unknown) {
        if (error instanceof CircuitBreakerError) {
          throw new ConnectorUnavailableError({
            message: `Connector '${this.connectorKey}' circuit breaker is open for '${operation}'`,
            code: 'CONNECTOR_CIRCUIT_OPEN',
            source: this.connectorKey,
            retryable: true,
            cause: error,
          });
        }
        throw error;
      }
    };

    return retryWithBackoff(attempt, {
      attempts: WRITE_OPERATIONS.has(operation)
        ? 1
        : this.config.maxRetries + 1,
      baseMs: this.config.retryBaseMs,
      maxMs: this.config.retryMaxMs,
      jitter: true,
      sleep: this.sleep,
      // An open circuit fails fast; callers may retry later.
      isRetryable: (error) =>
        isRetryableConnectorError(error) &&
        (error as ConnectorError).code !== 'CONNECTOR_CIRCUIT_OPEN',
      onRetry: (attemptNumber, error) => {
        this.logger.warn(
          JSON.stringify({
            event: 'connector.retry',
            connector: this.connectorKey,
            tenant: this.context.tenantId,
            operation,
            attempt: attemptNumber,
            code: isConnectorError(error) ? error.code : 'UNKNOWN',
          }),
        );
      },
    });
  }

  private secret(secretRef: string): string {
    const value = this.secrets.resolve(secretRef);
    if (!value) {
      throw new ConnectorConfigurationError({
        message: `Secret reference ${secretRef} did not resolve for connector '${this.connectorKey}'`,
        code: 'CONNECTOR_SECRET_UNRESOLVED',
        source: this.connectorKey,
      });
    }
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\u0000]/.test(value)) {
      throw new ConnectorConfigurationError({
        message: `Secret reference ${secretRef} resolved to an invalid header value`,
        code: 'CONNECTOR_SECRET_INVALID',
        source: this.connectorKey,
      });
    }
    return value;
  }

  private authHeaders(): Record<string, string> {
    const { auth } = this.config;
    switch (auth.type) {
      case 'none':
        return {};
      case 'bearer':
        return { authorization: `Bearer ${this.secret(auth.secretRef)}` };
      case 'apiKey':
        return { [auth.headerName.toLowerCase()]: this.secret(auth.secretRef) };
      case 'basic': {
        const username = this.secret(auth.usernameRef);
        if (username.includes(':')) {
          throw new ConnectorConfigurationError({
            message: 'Basic auth username must not contain ":"',
            code: 'CONNECTOR_SECRET_INVALID',
            source: this.connectorKey,
          });
        }
        const password = this.secret(auth.passwordRef);
        return {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        };
      }
    }
  }

  /**
   * Builds an endpoint URL under the configured base. Path parameters are
   * URL-encoded, dot segments are rejected, and the result must stay under
   * the base origin and path, so an identifier can never address another
   * endpoint on the CRM host.
   */
  private buildUrl(
    endpoint: RestEndpointConfig,
    params: Readonly<Record<string, string>>,
    query: Readonly<Record<string, string>>,
  ): string {
    const path = endpoint.path.replace(
      /\{([A-Za-z]+)\}/g,
      (_match, name: string) => {
        const value = params[name];
        if (value === undefined || value === '.' || value === '..') {
          throw new ConnectorConfigurationError({
            message: `Missing or invalid path parameter {${name}}`,
            source: this.connectorKey,
          });
        }
        return encodeURIComponent(value);
      },
    );

    const url = new URL(this.base.href);
    url.pathname = `${this.basePath}${path.replace(/^\//, '')}`;
    if (
      url.origin !== this.base.origin ||
      !url.pathname.startsWith(this.basePath)
    ) {
      throw new ConnectorConfigurationError({
        message: 'Endpoint URL escapes the configured base URL',
        code: 'CONNECTOR_PATH_ESCAPE',
        source: this.connectorKey,
      });
    }
    for (const [name, value] of Object.entries({
      ...endpoint.query,
      ...query,
    })) {
      url.searchParams.set(name, value);
    }
    return url.href;
  }

  /**
   * Converts a canonical id (`<sourceSystem>:<id>` for items,
   * `<sourceSystem>:offer:<id>` for offers) back to the upstream id. A bare
   * id without ':' is accepted as-is; an id carrying another prefix is
   * rejected rather than guessed.
   */
  private toSourceId(id: string, kind: 'item' | 'offer'): string {
    const prefix =
      kind === 'item' ? `${this.sourceSystem}:` : `${this.sourceSystem}:offer:`;
    let sourceId: string | undefined;
    if (id.startsWith(prefix)) {
      sourceId = id.slice(prefix.length);
    } else if (!id.includes(':')) {
      sourceId = id;
    }
    if (
      sourceId === undefined ||
      sourceId.length === 0 ||
      sourceId.length > 200 ||
      (kind === 'item' && sourceId.startsWith('offer:')) ||
      sourceId === '.' ||
      sourceId === '..'
    ) {
      throw new ConnectorError({
        message: `Connector '${this.connectorKey}' does not recognise ${kind} id`,
        code: 'CONNECTOR_INVALID_ID',
        category: ConnectorErrorCategory.VALIDATION,
        source: this.connectorKey,
      });
    }
    return sourceId;
  }

  private itemId(sourceEntityId: string): string {
    return `${this.sourceSystem}:${sourceEntityId}`;
  }

  private readList(body: unknown, endpoint: RestEndpointConfig): unknown[] {
    const data = getByPath(body, endpoint.dataPath);
    if (!Array.isArray(data)) {
      throw new ConnectorInvalidResponseError({
        message: `Response at ${endpoint.dataPath} is not a list`,
        code: 'CONNECTOR_INVALID_LIST_SHAPE',
        source: this.connectorKey,
      });
    }
    return data;
  }

  private readRecord(
    body: unknown,
    endpoint: RestEndpointConfig,
    entity: string,
  ): unknown {
    const record =
      endpoint.itemPath !== undefined
        ? getByPath(body, endpoint.itemPath)
        : body;
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record)
    ) {
      throw new ConnectorInvalidResponseError({
        message: `Connector ${entity} response is not an object`,
        code: 'CONNECTOR_INVALID_RECORD_SHAPE',
        source: this.connectorKey,
      });
    }
    return record;
  }

  private mapItem(record: unknown): CatalogItem {
    const mapping = this.config.fieldMappings.item ?? {};
    const reader = new RecordReader(record, 'item', this.connectorKey);
    const sourceEntityId = reader.identifier(
      'sourceEntityId',
      mapping.sourceEntityId
        ? [mapping.sourceEntityId]
        : ['sourceEntityId', 'id'],
    );
    return this.canonical(
      CatalogItemSchema,
      compact({
        id: this.itemId(sourceEntityId),
        sourceSystem: this.sourceSystem,
        sourceEntityId,
        itemType: this.config.catalogItemType,
        title: reader.text('title', [mapping.title ?? 'title'], {
          required: true,
          max: 500,
        }),
        description: reader.text(
          'description',
          [mapping.description ?? 'description'],
          { max: 10_000 },
        ),
        attributes: reader.attributes(mapping.attributes),
      }),
      'item',
    );
  }

  private mapOffer(record: unknown, itemSourceId: string): Offer {
    const mapping = this.config.fieldMappings.offer ?? {};
    const reader = new RecordReader(record, 'offer', this.connectorKey);
    const sourceEntityId = reader.identifier(
      'sourceEntityId',
      mapping.sourceEntityId
        ? [mapping.sourceEntityId]
        : ['sourceEntityId', 'id'],
    );
    if (
      mapping.itemId &&
      reader.identifier('itemId', [mapping.itemId]) !== itemSourceId
    ) {
      throw new ConnectorInvalidResponseError({
        message: 'Connector offer belongs to a different item than requested',
        code: 'CONNECTOR_IDENTITY_MISMATCH',
        source: this.connectorKey,
      });
    }
    const price = reader.money(
      'price',
      [mapping.priceAmount ?? 'price.amount'],
      [mapping.priceCurrency ?? 'price.currency'],
    );
    return this.canonical(
      OfferSchema,
      compact({
        id: `${this.sourceSystem}:offer:${sourceEntityId}`,
        itemId: this.itemId(itemSourceId),
        sourceSystem: this.sourceSystem,
        sourceEntityId,
        price: price ?? null,
        currency: price?.currency,
        pricingBasis: reader.enumValue(
          'pricingBasis',
          [mapping.pricingBasis ?? 'pricingBasis'],
          mapPricingBasis,
          'UNSPECIFIED',
        ),
        taxesIncluded: reader.boolean('taxesIncluded', [
          mapping.taxesIncluded ?? 'taxesIncluded',
        ]),
        feesIncluded: reader.boolean('feesIncluded', [
          mapping.feesIncluded ?? 'feesIncluded',
        ]),
        availabilityStatus: reader.enumValue(
          'availabilityStatus',
          [mapping.availabilityStatus ?? 'availabilityStatus'],
          mapAvailabilityStatus,
          'UNKNOWN',
        ),
        seatsLeft: reader.nonNegativeInteger('seatsLeft', [
          mapping.seatsLeft ?? 'seatsLeft',
        ]),
        startsAt: reader.dateTime('startsAt', [mapping.startsAt ?? 'startsAt']),
        endsAt: reader.dateTime('endsAt', [mapping.endsAt ?? 'endsAt']),
        validFrom: reader.dateTime('validFrom', [
          mapping.validFrom ?? 'validFrom',
        ]),
        validUntil: reader.dateTime('validUntil', [
          mapping.validUntil ?? 'validUntil',
        ]),
        attributes: reader.attributes(mapping.attributes),
      }),
      'offer',
    );
  }

  /** Keeps the first occurrence of each source id (pages can overlap). */
  private dedupe<T extends { sourceEntityId: string }>(records: T[]): T[] {
    const seen = new Set<string>();
    return records.filter((record) => {
      if (seen.has(record.sourceEntityId)) return false;
      seen.add(record.sourceEntityId);
      return true;
    });
  }

  /**
   * Lists the catalog page by page. Either the full listing (or exactly
   * `limit` items) is returned, or an error is thrown: reaching `maxPages`
   * with more data pending raises CONNECTOR_PAGINATION_LIMIT_REACHED instead
   * of returning a silently truncated catalog that a sync could mistake for
   * the whole thing.
   */
  private async listCatalog(
    params: ListItemsParams = {},
  ): Promise<CatalogItem[]> {
    const endpoint = this.endpoint('listItems', 'sync');
    const limit = params.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      this.invalidInput('listItems parameters', ['limit']);
    }
    if (
      params.offset !== undefined &&
      (!Number.isSafeInteger(params.offset) || params.offset < 0)
    ) {
      this.invalidInput('listItems parameters', ['offset']);
    }
    if (params.itemType && params.itemType !== this.config.catalogItemType) {
      return [];
    }

    const pagination = endpoint.pagination ?? DefaultPagination;
    if (params.offset && pagination.strategy !== 'offset') {
      this.unsupportedFilter('offset');
    }

    const items: CatalogItem[] = [];
    // Pages can overlap when the upstream changes mid-listing; duplicates are
    // dropped as they arrive so they never count toward `limit`.
    const seenIds = new Set<string>();
    let offset = params.offset ?? 0;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const done = (): boolean => limit !== undefined && items.length >= limit;

    for (let page = 0; page < pagination.maxPages; page++) {
      const query: Record<string, string> = {};
      const remaining = limit === undefined ? undefined : limit - items.length;
      const pageLimit = Math.min(pagination.pageSize, remaining ?? Infinity);
      if (pagination.strategy === 'offset') {
        query[pagination.limitParam] = String(pageLimit);
        query[pagination.offsetParam] = String(offset);
      } else if (pagination.strategy === 'cursor') {
        query[pagination.limitParam] = String(pagination.pageSize);
        if (cursor !== undefined) query[pagination.cursorParam] = cursor;
      }

      const response = await this.request('listItems', {
        method: endpoint.method,
        url: this.buildUrl(endpoint, {}, query),
      });
      const records = this.readList(response.body, endpoint);
      for (const record of records) {
        if (done()) break;
        const item = this.mapItem(record);
        if (seenIds.has(item.sourceEntityId)) continue;
        seenIds.add(item.sourceEntityId);
        items.push(item);
      }

      if (pagination.strategy === 'none' || done()) return items;
      if (pagination.strategy === 'offset') {
        if (records.length < pageLimit) return items;
        offset += records.length;
        continue;
      }

      const next = getByPath(response.body, pagination.cursorPath);
      if (next === undefined || next === null || next === '') return items;
      if (typeof next !== 'string' && typeof next !== 'number') {
        throw new ConnectorInvalidResponseError({
          message: `Pagination cursor at ${pagination.cursorPath} is not a string`,
          code: 'CONNECTOR_INVALID_CURSOR',
          source: this.connectorKey,
        });
      }
      cursor = String(next);
      if (seenCursors.has(cursor)) {
        throw new ConnectorInvalidResponseError({
          message: 'Pagination cursor repeated; refusing to loop',
          code: 'CONNECTOR_PAGINATION_LOOP',
          source: this.connectorKey,
        });
      }
      seenCursors.add(cursor);
    }

    throw new ConnectorInvalidResponseError({
      message: `Listing exceeded maxPages (${pagination.maxPages}) for connector '${this.connectorKey}'`,
      code: 'CONNECTOR_PAGINATION_LIMIT_REACHED',
      source: this.connectorKey,
    });
  }

  private async searchCatalog(query: CanonicalQuery): Promise<CatalogItem[]> {
    const endpoint = this.endpoint('searchItems', 'search');
    const parsed = this.input(CanonicalQuerySchema, query, 'search query');
    if (parsed.itemType && parsed.itemType !== this.config.catalogItemType) {
      return [];
    }

    const searchParams = endpoint.searchParams ?? {};
    const pagination = endpoint.pagination ?? DefaultPagination;
    const limit = parsed.limit ?? DEFAULT_SEARCH_LIMIT;
    const params: Record<string, string> = {};
    if (parsed.title !== undefined) {
      if (!searchParams.title) this.unsupportedFilter('title');
      params[searchParams.title] = parsed.title;
    }
    for (const [name, value] of Object.entries(parsed.attributes ?? {})) {
      const param = searchParams.attributes?.[name];
      if (!param || !['string', 'number', 'boolean'].includes(typeof value)) {
        this.unsupportedFilter(`attributes.${name}`);
      }
      params[param] = String(value);
    }
    if (pagination.strategy !== 'none') {
      params[pagination.limitParam] = String(
        Math.min(limit, pagination.pageSize),
      );
    }
    if (parsed.offset) {
      if (pagination.strategy !== 'offset') this.unsupportedFilter('offset');
      params[pagination.offsetParam] = String(parsed.offset);
    }

    const response = await this.request('searchItems', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, {}, params),
    });
    const records = this.readList(response.body, endpoint).slice(0, limit);
    return this.dedupe(records.map((record) => this.mapItem(record)));
  }

  private async fetchItem(id: string): Promise<CatalogItem> {
    const endpoint = this.endpoint('getItem');
    const sourceEntityId = this.toSourceId(id, 'item');
    const response = await this.request('getItem', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, { sourceEntityId }, {}),
    });
    const item = this.mapItem(this.readRecord(response.body, endpoint, 'item'));
    if (item.sourceEntityId !== sourceEntityId) {
      throw new ConnectorInvalidResponseError({
        message: 'Connector returned a different item than requested',
        code: 'CONNECTOR_IDENTITY_MISMATCH',
        source: this.connectorKey,
      });
    }
    return item;
  }

  private async fetchOffers(itemId: string): Promise<Offer[]> {
    const endpoint = this.endpoint('getOffers');
    const itemSourceId = this.toSourceId(itemId, 'item');
    const response = await this.request('getOffers', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, { itemId: itemSourceId }, {}),
    });
    return this.dedupe(
      this.readList(response.body, endpoint).map((record) =>
        this.mapOffer(record, itemSourceId),
      ),
    );
  }

  /** Body for live reads: caller attributes < static config < identity. */
  private liveReadBody(
    endpoint: RestEndpointConfig,
    sourceOfferId: string,
    attributes: Record<string, unknown> | undefined,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> | undefined {
    if (endpoint.method === 'GET') {
      if (attributes && Object.keys(attributes).length > 0) {
        this.unsupportedFilter('attributes');
      }
      return undefined;
    }
    return {
      ...attributes,
      ...endpoint.body,
      ...extra,
      offerId: sourceOfferId,
    };
  }

  private assertRequestOffer(offerId: string, requestOfferId: string): void {
    if (requestOfferId !== offerId) {
      this.invalidInput('request', ['offerId']);
    }
  }

  private async fetchAvailability(
    offerId: string,
    request: AvailabilityRequest,
  ): Promise<Availability> {
    const endpoint = this.endpoint('checkAvailability', 'availability');
    this.assertRequestOffer(offerId, request.offerId);
    const sourceOfferId = this.toSourceId(offerId, 'offer');
    const response = await this.request('checkAvailability', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, { offerId: sourceOfferId }, {}),
      body: this.liveReadBody(
        endpoint,
        sourceOfferId,
        request.attributes,
        request.requestedAt ? { requestedAt: request.requestedAt } : {},
      ),
    });

    const mapping = this.config.fieldMappings.availability ?? {};
    const reader = new RecordReader(
      this.readRecord(response.body, endpoint, 'availability'),
      'availability',
      this.connectorKey,
    );
    return this.canonical(
      AvailabilitySchema,
      compact({
        offerId,
        status: reader.enumValue(
          'status',
          [mapping.status ?? 'status'],
          mapAvailabilityStatus,
          'UNKNOWN',
        ),
        seatsLeft: reader.nonNegativeInteger('seatsLeft', [
          mapping.seatsLeft ?? 'seatsLeft',
        ]),
        validUntil: reader.dateTime('validUntil', [
          mapping.validUntil ?? 'validUntil',
        ]),
      }),
      'availability',
    );
  }

  private async fetchQuote(
    offerId: string,
    request: QuoteRequest,
  ): Promise<Quote> {
    const endpoint = this.endpoint('getQuote', 'liveQuote');
    this.assertRequestOffer(offerId, request.offerId);
    const sourceOfferId = this.toSourceId(offerId, 'offer');
    const response = await this.request('getQuote', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, { offerId: sourceOfferId }, {}),
      body: this.liveReadBody(endpoint, sourceOfferId, request.attributes),
    });

    const mapping = this.config.fieldMappings.quote ?? {};
    const reader = new RecordReader(
      this.readRecord(response.body, endpoint, 'quote'),
      'quote',
      this.connectorKey,
    );
    const amount = reader.money(
      'amount',
      [mapping.amount ?? 'amount'],
      [mapping.currency ?? 'currency'],
    );
    if (amount === undefined) {
      throw new ConnectorInvalidResponseError({
        message: 'Quote response is missing amount or currency',
        code: 'CONNECTOR_MISSING_QUOTE_AMOUNT',
        source: this.connectorKey,
      });
    }
    // Without an upstream quote id the quote is identified by its offer; it
    // is still a live answer, but not a durable upstream reference.
    const sourceEntityId =
      reader.optionalIdentifier('quoteId', [mapping.quoteId ?? 'quoteId']) ??
      sourceOfferId;
    return this.canonical(
      QuoteSchema,
      compact({
        id: `${this.sourceSystem}:quote:${sourceEntityId}`,
        offerId,
        amount,
        pricingBasis: reader.enumValue(
          'pricingBasis',
          [mapping.pricingBasis ?? 'pricingBasis'],
          mapPricingBasis,
          'UNSPECIFIED',
        ),
        breakdown: reader.jsonRecord('breakdown', [
          mapping.breakdown ?? 'breakdown',
        ]),
        validUntil: reader.dateTime('validUntil', [
          mapping.validUntil ?? 'validUntil',
        ]),
        sourceSystem: this.sourceSystem,
        sourceEntityId,
      }),
      'quote',
    );
  }

  /**
   * Builds a write body from the endpoint's explicit `requestBody` mapping,
   * or returns undefined when none is configured (canonical shape is sent).
   *
   * Only mapped fields are sent; a missing optional source is omitted rather
   * than invented; a missing required source rejects the call before any
   * external write. For patches, required applies only to supplied fields,
   * and a patch that maps to nothing is rejected instead of sent empty.
   */
  private writeBody(
    endpoint: RestEndpointConfig,
    what: string,
    canonical: Record<string, unknown>,
    patch: boolean,
  ): Record<string, unknown> | undefined {
    if (endpoint.requestBody === undefined) return undefined;
    const body: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [target, field] of Object.entries(endpoint.requestBody)) {
      let value: unknown;
      if ('value' in field) {
        value = field.value;
      } else {
        value = getByPath(canonical, field.from);
        if (value === undefined || value === null) {
          if (field.required && !patch) missing.push(field.from);
          continue;
        }
      }
      const segments = target.split('.');
      let node = body;
      for (const segment of segments.slice(0, -1)) {
        node = (node[segment] ??= {}) as Record<string, unknown>;
      }
      node[segments[segments.length - 1]] = value;
    }
    if (missing.length > 0) this.invalidInput(what, missing);
    const mappedFromCaller = Object.values(endpoint.requestBody).some(
      (field) => 'from' in field && getByPath(canonical, field.from) != null,
    );
    if (patch && !mappedFromCaller)
      this.invalidInput(what, ['(no mapped fields)']);
    return body;
  }

  private async submitLead(input: LeadInput): Promise<{ crmLeadId: string }> {
    const endpoint = this.endpoint('createLead', 'createLead');
    const lead = this.input(LeadInputSchema, input, 'lead');
    const response = await this.request('createLead', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, {}, {}),
      body: this.writeBody(endpoint, 'lead', lead, false) ?? {
        ...lead,
        ...endpoint.body,
      },
    });
    const mapping = this.config.fieldMappings.lead ?? {};
    const reader = new RecordReader(
      this.readRecord(response.body, endpoint, 'lead'),
      'lead',
      this.connectorKey,
    );
    return {
      crmLeadId: reader.identifier(
        'crmLeadId',
        mapping.crmLeadId ? [mapping.crmLeadId] : ['id'],
      ),
    };
  }

  private async patchLead(
    crmLeadId: string,
    patch: Partial<LeadInput>,
  ): Promise<void> {
    const endpoint = this.endpoint('updateLead', 'updateLead');
    if (crmLeadId.length === 0 || crmLeadId.length > 200) {
      this.invalidInput('lead id');
    }
    const parsed = this.input(LeadInputSchema.partial(), patch, 'lead patch');
    // Send only the fields the caller supplied: schema defaults (empty slots,
    // empty reason codes) must not overwrite CRM data.
    const body = Object.fromEntries(
      Object.keys(patch ?? {})
        .filter((key) => key in parsed)
        .map((key) => [key, parsed[key as keyof typeof parsed]]),
    );
    await this.request('updateLead', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, { crmLeadId }, {}),
      body: this.writeBody(endpoint, 'lead patch', body, true) ?? {
        ...body,
        ...endpoint.body,
      },
    });
  }

  private async submitBooking(
    input: BookingInput,
  ): Promise<{ bookingId: string }> {
    const endpoint = this.endpoint('createBooking', 'createBooking');
    const booking = this.input(BookingInputSchema, input, 'booking');
    const canonical = {
      ...booking,
      offerId: this.toSourceId(booking.offerId, 'offer'),
    };
    const response = await this.request('createBooking', {
      method: endpoint.method,
      url: this.buildUrl(endpoint, {}, {}),
      body: this.writeBody(endpoint, 'booking', canonical, false) ?? {
        ...canonical,
        ...endpoint.body,
        offerId: canonical.offerId,
      },
    });
    const mapping = this.config.fieldMappings.booking ?? {};
    const reader = new RecordReader(
      this.readRecord(response.body, endpoint, 'booking'),
      'booking',
      this.connectorKey,
    );
    return {
      bookingId: reader.identifier(
        'bookingId',
        mapping.bookingId ? [mapping.bookingId] : ['id'],
      ),
    };
  }
}

/**
 * Maps an upstream availability value to the canonical enum.
 *
 * Unknown or missing values degrade to `UNKNOWN` rather than throwing: the
 * agent must not invent availability, but a missing status is still a valid
 * (honest) answer.
 */
function mapAvailabilityStatus(
  normalized: string,
): AvailabilityStatus | undefined {
  switch (normalized) {
    case 'AVAILABLE':
    case 'IN_STOCK':
    case 'OPEN':
      return 'AVAILABLE';
    case 'LIMITED':
    case 'FEW':
    case 'LOW_STOCK':
      return 'LIMITED';
    case 'SOLD_OUT':
    case 'SOLDOUT':
    case 'OUT_OF_STOCK':
    case 'CLOSED':
      return 'SOLD_OUT';
    default:
      return undefined;
  }
}

/** Maps an upstream pricing basis to the canonical enum; unknown => UNSPECIFIED. */
function mapPricingBasis(normalized: string): PricingBasis | undefined {
  switch (normalized) {
    case 'PER_PERSON':
      return 'PER_PERSON';
    case 'PER_NIGHT':
      return 'PER_NIGHT';
    case 'PER_UNIT':
    case 'PER_ITEM':
      return 'PER_UNIT';
    case 'TOTAL':
      return 'TOTAL';
    default:
      return undefined;
  }
}
