import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import {
  BookingInputSchema,
  CanonicalQuerySchema,
  LeadInputSchema,
  type Availability,
  type BookingInput,
  type CanonicalQuery,
  type CatalogItem,
  type LeadInput,
  type Offer,
  type Quote,
} from '../contracts/canonical.js';
import {
  ConnectorCapabilityError,
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorInvalidResponseError,
  ConnectorNotFoundError,
  ConnectorTimeoutError,
  ConnectorUnavailableError,
} from '../interfaces/errors.js';
import type {
  AvailabilityRequest,
  ChangeHandler,
  ConnectorCapabilities,
  ConnectorChange,
  ConnectorContext,
  CrmConnector,
  ListItemsParams,
  QuoteRequest,
  WriteContext,
} from '../interfaces/crm-connector.js';
import {
  allFixtures,
  findOfferById,
  toCatalogItem,
  toOffer,
  type MockConnectorConfig,
  type MockItemFixture,
} from './mock-fixtures.js';

export type MockFailureMode =
  'none' | 'timeout' | 'transient' | 'invalidResponse' | 'emptySearch';

export interface MockConnectorOptions extends MockConnectorConfig {
  readonly failureMode?: MockFailureMode;
  /**
   * Number of consecutive calls that must fail. Defaults to "always fail"
   * for every mode except `none` and `emptySearch`.
   */
  readonly failTimes?: number;
}

/**
 * Deterministic in-memory connector used for development and tests.
 *
 * It is the reference implementation of the connector contract: every
 * capability is implemented, so the shared conformance suite validates the
 * contract itself rather than one connector's quirks. All catalog data is
 * fictional (see mock-fixtures.ts) and never represents real offerings.
 *
 * Failure simulation is deterministic (no timers, no randomness) so tests can
 * assert exact call sequences.
 */
export class MockConnector implements CrmConnector {
  private readonly logger = new Logger(MockConnector.name);
  readonly connectorKey: string;
  readonly capabilities: ConnectorCapabilities;
  readonly context: ConnectorContext;
  readonly sourceSystem: string;
  private readonly items: readonly MockItemFixture[];
  private readonly failureMode: MockFailureMode;
  private failRemaining: number;
  private callCount = 0;
  private leadCounter = 0;
  private bookingCounter = 0;
  private readonly leads = new Map<string, LeadInput>();
  private readonly bookings = new Map<string, BookingInput>();
  private changeHandler: ChangeHandler | undefined;

  constructor(context: ConnectorContext, options: MockConnectorOptions) {
    this.context = context;
    this.connectorKey = context.connectorKey;
    this.sourceSystem = options.sourceSystem;
    this.failureMode = options.failureMode ?? 'none';
    this.failRemaining =
      options.failTimes ??
      (this.failureMode === 'none' || this.failureMode === 'emptySearch'
        ? 0
        : Number.POSITIVE_INFINITY);
    this.items = options.items ?? allFixtures(options.sourceSystem);

    this.capabilities = {
      sync: true,
      search: true,
      liveQuote: true,
      availability: true,
      createLead: true,
      updateLead: true,
      createBooking: true,
      webhooks: true,
    };
  }

  async initialize(): Promise<void> {
    this.logger.log(
      JSON.stringify({
        event: 'connector.initialized',
        connector: this.connectorKey,
        tenant: this.context.tenantId,
        capabilities: this.capabilities,
        itemCount: this.items.length,
      }),
    );
  }

  async shutdown(): Promise<void> {
    this.changeHandler = undefined;
  }

  async validateConfiguration(): Promise<void> {
    if (!this.sourceSystem) {
      throw new ConnectorConfigurationError({
        message: 'Mock connector requires a sourceSystem',
        source: this.connectorKey,
      });
    }
  }

  private input<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new ConnectorError({
      message: `Invalid ${what} for mock connector`,
      code: 'CONNECTOR_INVALID_INPUT',
      category: ConnectorErrorCategory.VALIDATION,
      source: this.connectorKey,
    });
  }

  /** Number of connector calls made so far; useful for retry assertions. */
  get calls(): number {
    return this.callCount;
  }

  private recordCall(): void {
    this.callCount++;
  }

  private shouldFail(): void {
    if (this.failureMode === 'none' || this.failureMode === 'emptySearch') {
      return;
    }
    if (this.failRemaining <= 0) return;
    this.failRemaining--;

    switch (this.failureMode) {
      case 'timeout':
        throw new ConnectorTimeoutError({
          message: 'Mock connector simulated timeout',
          code: 'CONNECTOR_TIMEOUT',
          source: this.connectorKey,
        });
      case 'transient':
        throw new ConnectorUnavailableError({
          message: 'Mock connector simulated transient failure',
          code: 'CONNECTOR_UNAVAILABLE',
          source: this.connectorKey,
          retryable: true,
        });
      case 'invalidResponse':
        throw new ConnectorInvalidResponseError({
          message: 'Mock connector simulated invalid response',
          code: 'CONNECTOR_INVALID_RESPONSE',
          source: this.connectorKey,
        });
      default:
        return;
    }
  }

  private requireCapability(
    capability: keyof ConnectorCapabilities,
    operation: string,
  ): void {
    if (!this.capabilities[capability]) {
      throw new ConnectorCapabilityError({
        message: `Mock connector does not support '${operation}'`,
        code: 'CONNECTOR_CAPABILITY_UNSUPPORTED',
        source: this.connectorKey,
        retryable: false,
      });
    }
  }

  /** Strips the `sourceSystem:` prefix from a canonical id. */
  private toSourceEntityId(id: string): string {
    const prefix = `${this.sourceSystem}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  private findItem(id: string): MockItemFixture {
    const sourceEntityId = this.toSourceEntityId(id);
    const item = this.items.find((i) => i.sourceEntityId === sourceEntityId);
    if (!item) {
      throw new ConnectorNotFoundError({
        message: `Item not found: ${id}`,
        code: 'CONNECTOR_ITEM_NOT_FOUND',
        source: this.connectorKey,
        retryable: false,
      });
    }
    return item;
  }

  async listItems(params: ListItemsParams = {}): Promise<CatalogItem[]> {
    this.requireCapability('sync', 'listItems');
    this.recordCall();
    this.shouldFail();

    const filtered = params.itemType
      ? this.items.filter((item) => item.itemType === params.itemType)
      : this.items;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? filtered.length;
    return filtered
      .slice(offset, offset + limit)
      .map((item) => toCatalogItem(this.sourceSystem, item));
  }

  async searchItems(query: CanonicalQuery): Promise<CatalogItem[]> {
    this.requireCapability('search', 'searchItems');
    const parsed = this.input(CanonicalQuerySchema, query, 'search query');
    this.recordCall();
    this.shouldFail();

    if (this.failureMode === 'emptySearch') {
      return [];
    }

    const title = parsed.title?.toLowerCase();
    const attributes = Object.entries(parsed.attributes ?? {});
    const matches = this.items.filter((item) => {
      if (parsed.itemType && item.itemType !== parsed.itemType) return false;
      if (title && !item.title.toLowerCase().includes(title)) return false;
      // Every attribute filter must match exactly (case-insensitive text).
      return attributes.every(
        ([name, value]) =>
          String(item.attributes[name] ?? '').toLowerCase() ===
          String(value).toLowerCase(),
      );
    });

    const offset = parsed.offset ?? 0;
    const limit = parsed.limit ?? matches.length;
    return matches
      .slice(offset, offset + limit)
      .map((item) => toCatalogItem(this.sourceSystem, item));
  }

  async getItem(id: string): Promise<CatalogItem> {
    this.requireCapability('search', 'getItem');
    this.recordCall();
    this.shouldFail();
    return toCatalogItem(this.sourceSystem, this.findItem(id));
  }

  async getOffers(itemId: string): Promise<Offer[]> {
    this.requireCapability('search', 'getOffers');
    this.recordCall();
    this.shouldFail();
    const item = this.findItem(itemId);
    return item.offers.map((offer) => toOffer(this.sourceSystem, item, offer));
  }

  async checkAvailability(
    offerId: string,
    _request: AvailabilityRequest,
  ): Promise<Availability> {
    this.requireCapability('availability', 'checkAvailability');
    this.recordCall();
    this.shouldFail();

    const found = findOfferById(this.sourceSystem, this.items, offerId);
    if (!found) {
      throw new ConnectorNotFoundError({
        message: `Offer not found: ${offerId}`,
        code: 'CONNECTOR_OFFER_NOT_FOUND',
        source: this.connectorKey,
        retryable: false,
      });
    }
    return {
      offerId,
      status: found.offer.availabilityStatus ?? 'UNKNOWN',
      seatsLeft: found.offer.seatsLeft,
      validUntil: found.offer.validUntil,
    };
  }

  async getQuote(offerId: string, _request: QuoteRequest): Promise<Quote> {
    this.requireCapability('liveQuote', 'getQuote');
    this.recordCall();
    this.shouldFail();

    const found = findOfferById(this.sourceSystem, this.items, offerId);
    if (!found) {
      throw new ConnectorNotFoundError({
        message: `Offer not found: ${offerId}`,
        code: 'CONNECTOR_OFFER_NOT_FOUND',
        source: this.connectorKey,
        retryable: false,
      });
    }
    if (!found.offer.price) {
      // The capability exists; this particular offer has no price.
      throw new ConnectorNotFoundError({
        message: `Quote unavailable for offer: ${offerId}`,
        code: 'CONNECTOR_QUOTE_UNAVAILABLE',
        source: this.connectorKey,
      });
    }
    return {
      id: `${this.sourceSystem}:quote:${offerId}`,
      offerId,
      amount: found.offer.price,
      pricingBasis: found.offer.pricingBasis ?? 'UNSPECIFIED',
      validUntil: found.offer.validUntil,
      sourceSystem: this.sourceSystem,
      sourceEntityId: found.offer.sourceEntityId,
    };
  }

  /** The mock deduplicates creates by idempotency key, like a native API. */
  readonly writeIdempotency = 'native' as const;
  private readonly leadsByKey = new Map<string, string>();

  async createLead(
    input: LeadInput,
    context?: WriteContext,
  ): Promise<{ crmLeadId: string }> {
    this.requireCapability('createLead', 'createLead');
    const lead = this.input(LeadInputSchema, input, 'lead');
    this.recordCall();
    this.shouldFail();

    const existing = context && this.leadsByKey.get(context.idempotencyKey);
    if (existing) return { crmLeadId: existing };
    this.leadCounter += 1;
    const crmLeadId = `${this.sourceSystem}:lead:${this.leadCounter}`;
    this.leads.set(crmLeadId, lead);
    if (context) this.leadsByKey.set(context.idempotencyKey, crmLeadId);
    return { crmLeadId };
  }

  async updateLead(
    crmLeadId: string,
    patch: Partial<LeadInput>,
  ): Promise<void> {
    this.requireCapability('updateLead', 'updateLead');
    this.recordCall();
    this.shouldFail();

    const parsed = this.input(LeadInputSchema.partial(), patch, 'lead patch');
    const existing = this.leads.get(crmLeadId);
    if (!existing) {
      throw new ConnectorNotFoundError({
        message: `Lead not found: ${crmLeadId}`,
        code: 'CONNECTOR_LEAD_NOT_FOUND',
        source: this.connectorKey,
        retryable: false,
      });
    }
    const supplied = Object.fromEntries(
      Object.keys(patch ?? {})
        .filter((key) => key in parsed)
        .map((key) => [key, parsed[key as keyof typeof parsed]]),
    );
    this.leads.set(crmLeadId, { ...existing, ...supplied });
  }

  async createBooking(input: BookingInput): Promise<{ bookingId: string }> {
    this.requireCapability('createBooking', 'createBooking');
    const booking = this.input(BookingInputSchema, input, 'booking');
    this.recordCall();
    this.shouldFail();

    if (!findOfferById(this.sourceSystem, this.items, booking.offerId)) {
      throw new ConnectorNotFoundError({
        message: `Offer not found: ${booking.offerId}`,
        code: 'CONNECTOR_OFFER_NOT_FOUND',
        source: this.connectorKey,
      });
    }
    this.bookingCounter += 1;
    const bookingId = `${this.sourceSystem}:booking:${this.bookingCounter}`;
    this.bookings.set(bookingId, booking);
    return { bookingId };
  }

  subscribeChanges(handler: ChangeHandler): void {
    this.requireCapability('webhooks', 'subscribeChanges');
    this.changeHandler = handler;
  }

  /** Test helper: pushes a change to the subscribed handler, if any. */
  async emitChange(change: ConnectorChange): Promise<void> {
    await this.changeHandler?.handle(change);
  }
}
