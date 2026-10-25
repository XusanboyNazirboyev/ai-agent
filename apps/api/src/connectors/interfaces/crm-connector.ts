import type {
  Availability,
  BookingInput,
  CanonicalQuery,
  CatalogItem,
  LeadInput,
  Offer,
  Quote,
} from '../contracts/canonical.js';
import type { SecretResolver } from '../interfaces/secret-resolver.js';

/** Capabilities a connector may declare. Every advertised capability must be implemented. */
export const ConnectorCapability = {
  SYNC: 'sync',
  SEARCH: 'search',
  LIVE_QUOTE: 'liveQuote',
  AVAILABILITY: 'availability',
  CREATE_LEAD: 'createLead',
  UPDATE_LEAD: 'updateLead',
  CREATE_BOOKING: 'createBooking',
  WEBHOOKS: 'webhooks',
} as const;

export type ConnectorCapability =
  (typeof ConnectorCapability)[keyof typeof ConnectorCapability];

export interface ConnectorCapabilities {
  sync: boolean;
  search: boolean;
  liveQuote: boolean;
  availability: boolean;
  createLead: boolean;
  updateLead: boolean;
  createBooking: boolean;
  webhooks: boolean;
}

export interface ConnectorContext {
  readonly tenantId: string;
  readonly connectorKey: string;
}

export interface ListItemsParams {
  readonly itemType?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AvailabilityRequest {
  readonly offerId: string;
  readonly requestedAt?: string;
  readonly attributes?: Record<string, unknown>;
}

export interface QuoteRequest {
  readonly offerId: string;
  readonly attributes?: Record<string, unknown>;
}

export interface ConnectorChange {
  readonly type:
    'item.created' | 'item.updated' | 'item.deleted' | 'offer.changed';
  readonly itemId: string;
  readonly offerId?: string;
  readonly sourceEntityId: string;
  readonly occurredAt: string;
}

export interface ChangeHandler {
  readonly handle: (change: ConnectorChange) => Promise<void>;
}

/**
 * How a connector protects a create operation against duplicates when the
 * same logical write is attempted again (ADR 022 §8, ADR 023):
 *  - `native`: the remote system deduplicates by the idempotency key we send;
 *    repeating the call with the same key returns the original record.
 *  - `lookup`: the connector can find a record it created by that key
 *    (`findLeadByIdempotencyKey`); a retry after an unclear outcome looks up first.
 *  - `none`: neither. A call whose outcome is unclear is never repeated
 *    automatically.
 * Passing a key never guarantees exactly-once on its own: only what the
 * remote system honours counts.
 */
export type WriteIdempotency = 'native' | 'lookup' | 'none';

/** Stable for every attempt of one logical write; never regenerated per attempt. */
export interface WriteContext {
  readonly idempotencyKey: string;
}

/** Idempotency keys: printable, header-safe, bounded. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,200}$/u;

/**
 * Universal CRM connector contract.
 *
 * Connectors declare which capabilities they support and only implement the
 * corresponding methods. Unsupported operations are absent (undefined) and must
 * never be faked with a successful response. External identifiers are
 * source-specific; sourceSystem + sourceEntityId together identify a record.
 */
export interface CrmConnector {
  readonly connectorKey: string;
  readonly capabilities: ConnectorCapabilities;
  readonly context: ConnectorContext;
  /**
   * Source system stamped on every record this connector returns. Required
   * for catalog sync, which reconciles the local copy per source system.
   */
  readonly sourceSystem?: string;

  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;

  listItems?(params: ListItemsParams): Promise<CatalogItem[]>;
  searchItems?(query: CanonicalQuery): Promise<CatalogItem[]>;
  getItem?(id: string): Promise<CatalogItem>;
  getOffers?(itemId: string): Promise<Offer[]>;
  checkAvailability?(
    offerId: string,
    request: AvailabilityRequest,
  ): Promise<Availability>;
  getQuote?(offerId: string, request: QuoteRequest): Promise<Quote>;
  /** Default `none`. Verified by the registry and the conformance suite. */
  readonly writeIdempotency?: WriteIdempotency;
  createLead?(
    input: LeadInput,
    context?: WriteContext,
  ): Promise<{ crmLeadId: string }>;
  /**
   * Required when `writeIdempotency` is `lookup`: the record a previous
   * `createLead` with this key created, or undefined when there is none.
   * A failure means "could not determine", never "not found".
   */
  findLeadByIdempotencyKey?(
    idempotencyKey: string,
  ): Promise<{ crmLeadId: string } | undefined>;
  updateLead?(crmLeadId: string, patch: Partial<LeadInput>): Promise<void>;
  createBooking?(
    input: BookingInput,
    context?: WriteContext,
  ): Promise<{ bookingId: string }>;
  subscribeChanges?(handler: ChangeHandler): void;

  validateConfiguration?(): Promise<void>;
}

/**
 * Creates a connector instance for a tenant.
 *
 * The factory receives the tenant-scoped context, the validated connector
 * configuration, and runtime collaborators (secret resolver, HTTP client).
 * It must not perform I/O at construction time; use `initialize()` for that.
 */
export type ConnectorFactory = (
  context: ConnectorContext,
  config: Record<string, unknown>,
  dependencies: ConnectorDependencies,
) => CrmConnector;

/** Runtime collaborators a connector factory may use. */
export interface ConnectorDependencies {
  readonly resolveSecret: SecretResolver;
}

/**
 * Maps each capability to the method that must exist for it to be advertised.
 *
 * The registry uses this to verify that a connector never claims a capability
 * it does not actually implement (and never hides one it does implement).
 */
export const CAPABILITY_METHODS: Readonly<
  Record<keyof ConnectorCapabilities, keyof CrmConnector>
> = {
  sync: 'listItems',
  search: 'searchItems',
  liveQuote: 'getQuote',
  availability: 'checkAvailability',
  createLead: 'createLead',
  updateLead: 'updateLead',
  createBooking: 'createBooking',
  webhooks: 'subscribeChanges',
};
