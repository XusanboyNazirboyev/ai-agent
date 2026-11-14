import {
  CanonicalQuerySchema,
  type Availability,
  type CanonicalQuery,
  type CatalogItem,
  type Offer,
  type Quote,
} from '../contracts/canonical.js';
import {
  ConnectorInvalidResponseError,
  ConnectorNotFoundError,
  ConnectorUnavailableError,
} from '../interfaces/errors.js';
import type {
  AvailabilityRequest,
  ConnectorCapabilities,
  ConnectorContext,
  CrmConnector,
  QuoteRequest,
} from '../interfaces/crm-connector.js';
import type {
  SheetCatalogMeta,
  SheetCatalogReader,
  StoredItem,
  StoredOffer,
} from './sheet-catalog.store.js';

export const SPREADSHEET_CONNECTOR_KEY = 'spreadsheet';
export const SPREADSHEET_SOURCE_SYSTEM = 'spreadsheet';

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 20;

/** `2026-03-14` at the start of that day in `timeZone`, as an instant with its offset. */
export function startOfLocalDay(date: string, timeZone: string): string {
  let offset = '+00:00';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(`${date}T00:00:00Z`));
    const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    const match = /^GMT([+-]\d{2}:\d{2})$/u.exec(raw);
    if (match) offset = match[1]!;
  } catch {
    // An unknown zone name keeps UTC: the date stays right, the hour may be off.
  }
  return `${date}T00:00:00${offset}`;
}

/**
 * The tenant's uploaded price list as a catalog connector (ADR 064): search,
 * offers, availability and quotes, answered from the stored rows. No write
 * capability and no sync. A price list older than its freshness window is not
 * quoted and reports availability UNKNOWN (decision 5): the agent hands over
 * instead of stating a stale price.
 */
export class SpreadsheetConnector implements CrmConnector {
  readonly connectorKey: string;
  readonly context: ConnectorContext;
  readonly sourceSystem = SPREADSHEET_SOURCE_SYSTEM;
  readonly capabilities: ConnectorCapabilities = {
    sync: false,
    search: true,
    liveQuote: true,
    availability: true,
    createLead: false,
    updateLead: false,
    createBooking: false,
    webhooks: false,
  };

  constructor(
    context: ConnectorContext,
    private readonly reader: SheetCatalogReader,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.context = context;
    this.connectorKey = context.connectorKey;
  }

  private id(key: string): string {
    return `${this.sourceSystem}:${key}`;
  }

  private key(id: string): string {
    const prefix = `${this.sourceSystem}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  private notFound(
    what: string,
    id: string,
    code: string,
  ): ConnectorNotFoundError {
    return new ConnectorNotFoundError({
      message: `${what} not found: ${id}`,
      code,
      source: this.connectorKey,
      retryable: false,
    });
  }

  private expiresAt(meta: SheetCatalogMeta): Date {
    return new Date(meta.uploadedAt.getTime() + meta.freshnessDays * DAY_MS);
  }

  private isStale(meta: SheetCatalogMeta): boolean {
    return this.clock().getTime() > this.expiresAt(meta).getTime();
  }

  private toItem(item: StoredItem): CatalogItem {
    return {
      id: this.id(item.key),
      sourceSystem: this.sourceSystem,
      sourceEntityId: item.key,
      itemType: item.itemType,
      title: item.title,
      attributes: { ...item.attributes },
    };
  }

  private toOffer(offer: StoredOffer, meta: SheetCatalogMeta): Offer {
    const stale = this.isStale(meta);
    const attributes: Record<string, unknown> = { ...offer.attributes };
    if (offer.startsOn) attributes.departureDate = offer.startsOn;
    return {
      id: this.id(offer.key),
      itemId: this.id(offer.itemKey),
      sourceSystem: this.sourceSystem,
      sourceEntityId: offer.key,
      price: { amount: offer.price, currency: offer.currency },
      currency: offer.currency,
      pricingBasis: 'PER_PERSON',
      availabilityStatus: stale ? 'UNKNOWN' : offer.availability,
      ...(!stale && offer.seatsLeft !== null
        ? { seatsLeft: offer.seatsLeft }
        : {}),
      ...(offer.startsOn
        ? { startsAt: startOfLocalDay(offer.startsOn, meta.timeZone) }
        : {}),
      ...(offer.endsOn
        ? { endsAt: startOfLocalDay(offer.endsOn, meta.timeZone) }
        : {}),
      validUntil: this.expiresAt(meta).toISOString(),
      attributes,
    };
  }

  private async requireMeta(): Promise<SheetCatalogMeta> {
    const meta = await this.reader.meta(this.context.tenantId);
    if (!meta)
      throw new ConnectorUnavailableError({
        message: 'No price list has been uploaded',
        code: 'SHEET_CATALOG_EMPTY',
        source: this.connectorKey,
        retryable: false,
      });
    return meta;
  }

  async searchItems(query: CanonicalQuery): Promise<CatalogItem[]> {
    const parsed = CanonicalQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new ConnectorInvalidResponseError({
        message: 'Invalid search query',
        code: 'CONNECTOR_INVALID_QUERY',
        source: this.connectorKey,
      });
    const meta = await this.reader.meta(this.context.tenantId);
    if (!meta) return [];
    const items = await this.reader.searchItems(this.context.tenantId, {
      itemType: parsed.data.itemType,
      title: parsed.data.title,
      attributes: parsed.data.attributes,
      limit: Math.min(parsed.data.limit ?? DEFAULT_LIMIT, 100),
      offset: parsed.data.offset ?? 0,
    });
    return items.map((item) => this.toItem(item));
  }

  async getItem(id: string): Promise<CatalogItem> {
    const item = await this.reader.getItem(this.context.tenantId, this.key(id));
    if (!item) throw this.notFound('Item', id, 'CONNECTOR_ITEM_NOT_FOUND');
    return this.toItem(item);
  }

  async getOffers(itemId: string): Promise<Offer[]> {
    const meta = await this.requireMeta();
    const offers = await this.reader.getOffers(
      this.context.tenantId,
      this.key(itemId),
    );
    return offers.map((offer) => this.toOffer(offer, meta));
  }

  async checkAvailability(
    offerId: string,
    _request: AvailabilityRequest,
  ): Promise<Availability> {
    const meta = await this.requireMeta();
    const offer = await this.reader.getOffer(
      this.context.tenantId,
      this.key(offerId),
    );
    if (!offer)
      throw this.notFound('Offer', offerId, 'CONNECTOR_OFFER_NOT_FOUND');
    const stale = this.isStale(meta);
    return {
      offerId,
      status: stale ? 'UNKNOWN' : offer.availability,
      ...(!stale && offer.seatsLeft !== null
        ? { seatsLeft: offer.seatsLeft }
        : {}),
      validUntil: this.expiresAt(meta).toISOString(),
    };
  }

  async getQuote(offerId: string, _request: QuoteRequest): Promise<Quote> {
    const meta = await this.requireMeta();
    const offer = await this.reader.getOffer(
      this.context.tenantId,
      this.key(offerId),
    );
    if (!offer)
      throw this.notFound('Offer', offerId, 'CONNECTOR_OFFER_NOT_FOUND');
    if (this.isStale(meta))
      throw new ConnectorUnavailableError({
        message: 'The price list is older than its freshness window',
        code: 'SHEET_CATALOG_STALE',
        source: this.connectorKey,
        retryable: false,
      });
    return {
      id: `${this.sourceSystem}:quote:${offer.key}`,
      offerId,
      amount: { amount: offer.price, currency: offer.currency },
      pricingBasis: 'PER_PERSON',
      validUntil: this.expiresAt(meta).toISOString(),
      sourceSystem: this.sourceSystem,
      sourceEntityId: offer.key,
    };
  }
}
