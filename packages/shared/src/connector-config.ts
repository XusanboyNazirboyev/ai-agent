import { z } from 'zod';
import { ItemTypeSchema, SlotKeySchema } from './persistence-schemas';

/**
 * Tenant connector configuration contracts: the single source of truth for
 * the JSON stored in `tenant_connectors.config`, keyed by connector.
 *
 * Everything here is tenant data (stored per tenant, later edited in the
 * admin UI), so it can only *describe* an upstream API. It cannot select the
 * outbound security policy, disable TLS verification, name arbitrary process
 * secrets, traverse object prototypes, or inject path segments: none of those
 * fields exist and unknown keys are rejected. Deployment-level controls are
 * set by code from validated environment configuration.
 */

const FORBIDDEN_PATH_SEGMENTS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

const noPrototypeSegments = (path: string): boolean =>
  path.split('.').every((segment) => !FORBIDDEN_PATH_SEGMENTS.has(segment));

/** Dot-separated path into a JSON response (`data.items`, `prices.0.amount`). */
export const JsonPathSchema = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+){0,9}$/,
    'must be dot-separated field names',
  )
  .refine(noPrototypeSegments, 'must not traverse object prototypes');

/** Path to a list in a response; `$` means the response body itself. */
const DataPathSchema = z.union([z.literal('$'), JsonPathSchema]);

const RESERVED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'must be a valid header name')
  .refine(
    (name) => !RESERVED_HEADERS.has(name.toLowerCase()),
    'is a reserved header',
  );

const QueryParamNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.[\]-]{1,64}$/, 'must be a simple query parameter name');

/**
 * `<scheme>:<name>`; the resolver decides which names are reachable. A raw
 * credential pasted here fails the format check instead of being stored.
 */
export const SecretRefSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9_./-]{1,190}$/, 'must be <scheme>:<name>');

export const RestAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), secretRef: SecretRefSchema }).strict(),
  z
    .object({
      type: z.literal('apiKey'),
      secretRef: SecretRefSchema,
      headerName: HeaderNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('basic'),
      usernameRef: SecretRefSchema,
      passwordRef: SecretRefSchema,
    })
    .strict(),
]);

export const PaginationStrategySchema = z.enum(['offset', 'cursor', 'none']);

export const PaginationConfigSchema = z
  .object({
    strategy: PaginationStrategySchema.default('none'),
    limitParam: QueryParamNameSchema.default('limit'),
    offsetParam: QueryParamNameSchema.default('offset'),
    pageSize: z.number().int().positive().max(1000).default(50),
    cursorParam: QueryParamNameSchema.default('cursor'),
    cursorPath: JsonPathSchema.default('nextCursor'),
    maxPages: z.number().int().positive().max(1000).default(20),
  })
  .strict();

/**
 * Upstream query parameter names for canonical search filters. A filter with
 * no configured parameter is rejected rather than silently dropped, so search
 * results never claim to match a filter the upstream did not apply.
 */
const SearchParamsSchema = z
  .object({
    title: QueryParamNameSchema,
    attributes: z.record(z.string().min(1).max(64), QueryParamNameSchema),
  })
  .partial()
  .strict();

const EndpointPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^\/?(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]|\{[A-Za-z]+\})*(?:\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]|\{[A-Za-z]+\})*)*$/,
    'must be a URL path without query or fragment',
  )
  .refine(
    (path) =>
      path.split('/').every((segment) => segment !== '..' && segment !== '.'),
    'must not contain dot segments',
  );

/** Nested location in an outbound JSON body (`customer.phone`). */
const RequestTargetPathSchema = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z_$][A-Za-z0-9_$-]*){0,9}$/,
    'must be dot-separated field names',
  )
  .refine(noPrototypeSegments, 'must not target object prototypes');

/**
 * One outbound field: copied from a canonical source (`from`) or a static
 * configured value. A missing optional source is omitted, never invented.
 */
export const RequestFieldSchema = z.union([
  z
    .object({
      from: z.string().min(1).max(120),
      required: z.boolean().default(false),
    })
    .strict(),
  z.object({ value: z.json() }).strict(),
]);

/** Canonical sources a write endpoint may read, beyond `slots.*`/`details.*`. */
export const REQUEST_SOURCES = {
  createLead: [
    'contact.name',
    'contact.phone',
    'summary',
    'score',
    'reasonCodes',
    'slots',
  ],
  updateLead: [
    'contact.name',
    'contact.phone',
    'summary',
    'score',
    'reasonCodes',
    'slots',
  ],
  createBooking: ['offerId', 'contact.name', 'contact.phone', 'details'],
} as const;

const DYNAMIC_SOURCE_PREFIX = {
  createLead: 'slots.',
  updateLead: 'slots.',
  createBooking: 'details.',
} as const;

export type WriteEndpointKey = keyof typeof REQUEST_SOURCES;

export function isAllowedRequestSource(
  endpoint: WriteEndpointKey,
  source: string,
): boolean {
  if ((REQUEST_SOURCES[endpoint] as readonly string[]).includes(source)) {
    return true;
  }
  const prefix = DYNAMIC_SOURCE_PREFIX[endpoint];
  return (
    source.startsWith(prefix) &&
    SlotKeySchema.safeParse(source.slice(prefix.length)).success
  );
}

export const RestEndpointConfigSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    path: EndpointPathSchema,
    /** Static query parameters sent with every request. */
    query: z.record(QueryParamNameSchema, z.string().max(500)).optional(),
    /** Static JSON fields merged into request bodies (they override request data). */
    body: z.record(z.string().min(1).max(100), z.json()).optional(),
    /**
     * Explicit canonical-to-native body for writes. When present, the body is
     * built only from these fields; unmapped canonical data is not sent.
     */
    requestBody: z
      .record(RequestTargetPathSchema, RequestFieldSchema)
      .optional(),
    /** Location of the record list in list/search/offer responses. */
    dataPath: DataPathSchema.default('data'),
    /** Location of the single record in item/availability/quote/write responses. */
    itemPath: JsonPathSchema.optional(),
    pagination: PaginationConfigSchema.optional(),
    searchParams: SearchParamsSchema.optional(),
  })
  .strict();

const AttributeMappingSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'must be an attribute name'),
  JsonPathSchema,
);

/**
 * Canonical field -> response path, per canonical entity. Keys are closed
 * sets: an unknown key is rejected instead of being silently ignored.
 * Attributes are copied only when mapped, never wholesale.
 */
export const FieldMappingsSchema = z
  .object({
    item: z
      .object({
        sourceEntityId: JsonPathSchema,
        title: JsonPathSchema,
        description: JsonPathSchema,
        attributes: AttributeMappingSchema,
      })
      .partial()
      .strict(),
    offer: z
      .object({
        sourceEntityId: JsonPathSchema,
        itemId: JsonPathSchema,
        priceAmount: JsonPathSchema,
        priceCurrency: JsonPathSchema,
        pricingBasis: JsonPathSchema,
        taxesIncluded: JsonPathSchema,
        feesIncluded: JsonPathSchema,
        availabilityStatus: JsonPathSchema,
        seatsLeft: JsonPathSchema,
        startsAt: JsonPathSchema,
        endsAt: JsonPathSchema,
        validFrom: JsonPathSchema,
        validUntil: JsonPathSchema,
        attributes: AttributeMappingSchema,
      })
      .partial()
      .strict(),
    availability: z
      .object({
        status: JsonPathSchema,
        seatsLeft: JsonPathSchema,
        validUntil: JsonPathSchema,
      })
      .partial()
      .strict(),
    quote: z
      .object({
        quoteId: JsonPathSchema,
        amount: JsonPathSchema,
        currency: JsonPathSchema,
        pricingBasis: JsonPathSchema,
        breakdown: JsonPathSchema,
        validUntil: JsonPathSchema,
      })
      .partial()
      .strict(),
    lead: z.object({ crmLeadId: JsonPathSchema }).partial().strict(),
    booking: z.object({ bookingId: JsonPathSchema }).partial().strict(),
  })
  .partial()
  .strict();

/** Canonical operations that a REST endpoint can implement. */
export const REST_ENDPOINT_KEYS = [
  'listItems',
  'searchItems',
  'getItem',
  'getOffers',
  'checkAvailability',
  'getQuote',
  'createLead',
  'updateLead',
  'createBooking',
  'findLeadByReference',
] as const;

export type RestEndpointKey = (typeof REST_ENDPOINT_KEYS)[number];

/** Path placeholders each endpoint may use; values are always URL-encoded. */
export const ENDPOINT_PLACEHOLDERS: Readonly<
  Record<RestEndpointKey, readonly string[]>
> = {
  listItems: [],
  searchItems: [],
  getItem: ['sourceEntityId'],
  getOffers: ['itemId'],
  checkAvailability: ['offerId'],
  getQuote: ['offerId'],
  createLead: [],
  updateLead: ['crmLeadId'],
  createBooking: [],
  findLeadByReference: ['reference'],
};

const isWriteEndpoint = (key: RestEndpointKey): key is WriteEndpointKey =>
  key in REQUEST_SOURCES;

/**
 * How the remote API protects creates against duplicates (ADR 023). Only
 * declare what the API documentation guarantees:
 *  - native: the API deduplicates by a key sent in `header`;
 *  - lookup: the key is stored on the created record at `referenceField` of
 *    the create body, and `findLeadByReference` finds it (by `{reference}`
 *    in the path or the `referenceQueryParam` query parameter);
 *  - none (default): no automatic retry after an unclear outcome.
 */
export const WriteIdempotencyConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('native'), header: HeaderNameSchema }).strict(),
  z
    .object({
      mode: z.literal('lookup'),
      referenceField: RequestTargetPathSchema,
      referenceQueryParam: QueryParamNameSchema.optional(),
    })
    .strict(),
]);
export type WriteIdempotencyConfig = z.infer<
  typeof WriteIdempotencyConfigSchema
>;

export const GenericRestConnectorConfigSchema = z
  .object({
    baseUrl: z.url({ protocol: /^https?$/ }),
    /**
     * Canonical item type of every record this connector serves. Configured,
     * never inferred from caller input, so a query cannot relabel records.
     */
    catalogItemType: ItemTypeSchema.default('item'),
    auth: RestAuthSchema.default({ type: 'none' }),
    timeoutMs: z.number().int().positive().max(300_000).default(10_000),
    maxRetries: z.number().int().min(0).max(10).default(3),
    retryBaseMs: z.number().int().positive().max(60_000).default(1_000),
    retryMaxMs: z.number().int().positive().max(60_000).default(30_000),
    /** Redirect hops followed per request (each fully re-validated). */
    maxRedirects: z.number().int().min(0).max(5).default(0),
    maxResponseBytes: z
      .number()
      .int()
      .min(1_024)
      .max(20 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    /** Circuit breaker thresholds for outbound calls. */
    circuitBreaker: z
      .object({
        failureThreshold: z.number().int().positive().max(100).default(5),
        recoveryIntervalMs: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .default(30_000),
        halfOpenMaxAttempts: z.number().int().positive().max(100).default(1),
      })
      .strict()
      .default({
        failureThreshold: 5,
        recoveryIntervalMs: 30_000,
        halfOpenMaxAttempts: 1,
      }),
    endpoints: z
      .object({
        listItems: RestEndpointConfigSchema.optional(),
        searchItems: RestEndpointConfigSchema.optional(),
        getItem: RestEndpointConfigSchema.optional(),
        getOffers: RestEndpointConfigSchema.optional(),
        checkAvailability: RestEndpointConfigSchema.optional(),
        getQuote: RestEndpointConfigSchema.optional(),
        createLead: RestEndpointConfigSchema.optional(),
        updateLead: RestEndpointConfigSchema.optional(),
        createBooking: RestEndpointConfigSchema.optional(),
        /** Lookup of a lead by the idempotency reference sent on create. */
        findLeadByReference: RestEndpointConfigSchema.optional(),
      })
      .strict()
      .default({}),
    fieldMappings: FieldMappingsSchema.default({}),
    writeIdempotency: WriteIdempotencyConfigSchema.default({ mode: 'none' }),
  })
  .strict()
  .superRefine((config, context) => {
    const idempotency = config.writeIdempotency;
    if (
      idempotency &&
      idempotency.mode !== 'none' &&
      !config.endpoints?.createLead
    ) {
      context.addIssue({
        code: 'custom',
        path: ['writeIdempotency'],
        message: 'requires the createLead endpoint',
      });
    }
    if (
      idempotency?.mode === 'native' &&
      config.auth?.type === 'apiKey' &&
      config.auth.headerName.toLowerCase() === idempotency.header.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['writeIdempotency', 'header'],
        message: 'must differ from the authentication header',
      });
    }
    if (idempotency?.mode === 'lookup') {
      const find = config.endpoints?.findLeadByReference;
      if (!find) {
        context.addIssue({
          code: 'custom',
          path: ['endpoints', 'findLeadByReference'],
          message: 'is required for lookup idempotency',
        });
      } else if (
        !idempotency.referenceQueryParam &&
        !find.path.includes('{reference}')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['writeIdempotency', 'referenceQueryParam'],
          message: 'set it, or use {reference} in the findLeadByReference path',
        });
      }
    }
    let base: URL | undefined;
    try {
      base = new URL(config.baseUrl);
    } catch {
      // already reported by the baseUrl schema
    }
    if (base && (base.username !== '' || base.password !== '')) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'must not embed credentials; use auth secret references',
      });
    }
    if (base && (base.search !== '' || base.hash !== '')) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'must not contain a query string or fragment',
      });
    }
    if (config.retryBaseMs > config.retryMaxMs) {
      context.addIssue({
        code: 'custom',
        path: ['retryBaseMs'],
        message: 'must not exceed retryMaxMs',
      });
    }
    for (const key of REST_ENDPOINT_KEYS) {
      const endpoint = config.endpoints?.[key];
      if (typeof endpoint?.path !== 'string') continue;
      const allowed = new Set<string>(ENDPOINT_PLACEHOLDERS[key]);
      for (const match of endpoint.path.matchAll(/\{([A-Za-z]+)\}/g)) {
        if (!allowed.has(match[1])) {
          context.addIssue({
            code: 'custom',
            path: ['endpoints', key, 'path'],
            message: `placeholder {${match[1]}} is not available for ${key}`,
          });
        }
      }
      if (endpoint.requestBody === undefined) continue;
      const at = ['endpoints', key, 'requestBody'];
      if (!isWriteEndpoint(key)) {
        context.addIssue({
          code: 'custom',
          path: at,
          message: `requestBody is only supported on write endpoints`,
        });
        continue;
      }
      if (endpoint.body !== undefined) {
        context.addIssue({
          code: 'custom',
          path: at,
          message: 'use static `value` fields instead of combining with body',
        });
      }
      const targets = Object.keys(endpoint.requestBody);
      for (const target of targets) {
        const field = endpoint.requestBody[target];
        if ('from' in field && !isAllowedRequestSource(key, field.from)) {
          context.addIssue({
            code: 'custom',
            path: [...at, target, 'from'],
            message: `is not a canonical source for ${key}`,
          });
        }
        if (targets.some((other) => other.startsWith(`${target}.`))) {
          context.addIssue({
            code: 'custom',
            path: [...at, target],
            message: 'conflicts with a nested target path',
          });
        }
      }
    }
  });

/** Fictional in-memory catalog for development and tests. */
export const MockConnectorConfigSchema = z
  .object({
    sourceSystem: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    failureMode: z
      .enum(['none', 'timeout', 'transient', 'invalidResponse', 'emptySearch'])
      .optional(),
    failTimes: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();

export type RestAuth = z.infer<typeof RestAuthSchema>;
export type PaginationConfig = z.infer<typeof PaginationConfigSchema>;
export type RestEndpointConfig = z.infer<typeof RestEndpointConfigSchema>;
export type RequestField = z.infer<typeof RequestFieldSchema>;
export type FieldMappings = z.infer<typeof FieldMappingsSchema>;
export type GenericRestConnectorConfig = z.infer<
  typeof GenericRestConnectorConfigSchema
>;
export type MockConnectorConfig = z.infer<typeof MockConnectorConfigSchema>;

/**
 * Configuration schema per registered connector key. A tenant connector row
 * whose key is not listed here cannot be validated and must not be loaded.
 */
export const TenantConnectorConfigSchemas = {
  'generic-rest': GenericRestConnectorConfigSchema,
  mock: MockConnectorConfigSchema,
} as const;

export type TenantConnectorKey = keyof typeof TenantConnectorConfigSchemas;

export type TenantConnectorConfigResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly issues: readonly string[] };

/**
 * Validates stored tenant connector configuration for its connector key.
 * Issues list field paths and reasons only, never submitted values (which
 * may contain a secret pasted into the wrong field).
 */
export function parseTenantConnectorConfig(
  connectorKey: string,
  config: unknown,
): TenantConnectorConfigResult {
  if (
    !Object.prototype.hasOwnProperty.call(
      TenantConnectorConfigSchemas,
      connectorKey,
    )
  ) {
    return { success: false, issues: [`unknown connector '${connectorKey}'`] };
  }
  const schema =
    TenantConnectorConfigSchemas[connectorKey as TenantConnectorKey];
  const result = schema.safeParse(config);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
  };
}
