import type {
  AvailabilityStatus,
  CatalogItem,
  Money,
  Offer,
  PricingBasis,
} from '../contracts/canonical.js';

export interface MockOfferFixture {
  sourceEntityId: string;
  title?: string;
  price?: Money;
  pricingBasis?: PricingBasis;
  availabilityStatus?: AvailabilityStatus;
  seatsLeft?: number;
  taxesIncluded?: boolean;
  feesIncluded?: boolean;
  startsAt?: string;
  endsAt?: string;
  validFrom?: string;
  validUntil?: string;
  attributes: Record<string, unknown>;
}

export interface MockItemFixture {
  sourceEntityId: string;
  itemType: string;
  title: string;
  description?: string;
  attributes: Record<string, unknown>;
  offers: readonly MockOfferFixture[];
}

export interface MockConnectorConfig {
  readonly sourceSystem: string;
  readonly items: readonly MockItemFixture[];
}

function buildItemId(sourceSystem: string, sourceEntityId: string): string {
  return `${sourceSystem}:${sourceEntityId}`;
}

function buildOfferId(sourceSystem: string, sourceEntityId: string): string {
  return `${sourceSystem}:offer:${sourceEntityId}`;
}

export function toCatalogItem(
  sourceSystem: string,
  fixture: MockItemFixture,
): CatalogItem {
  return {
    id: buildItemId(sourceSystem, fixture.sourceEntityId),
    sourceSystem,
    sourceEntityId: fixture.sourceEntityId,
    itemType: fixture.itemType,
    title: fixture.title,
    description: fixture.description,
    attributes: fixture.attributes,
  };
}

export function toOffer(
  sourceSystem: string,
  item: MockItemFixture,
  offer: MockOfferFixture,
): Offer {
  return {
    id: buildOfferId(sourceSystem, offer.sourceEntityId),
    itemId: buildItemId(sourceSystem, item.sourceEntityId),
    sourceSystem,
    sourceEntityId: offer.sourceEntityId,
    price: offer.price ?? null,
    currency: offer.price?.currency,
    pricingBasis: offer.pricingBasis ?? 'UNSPECIFIED',
    taxesIncluded: offer.taxesIncluded,
    feesIncluded: offer.feesIncluded,
    availabilityStatus: offer.availabilityStatus ?? 'UNKNOWN',
    seatsLeft: offer.seatsLeft,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    validFrom: offer.validFrom,
    validUntil: offer.validUntil,
    attributes: offer.attributes,
  };
}
/** Deterministic, fictional education fixtures (not real offerings or prices). */
export function educationFixtures(): MockItemFixture[] {
  return [
    {
      sourceEntityId: 'edu-ielts-001',
      itemType: 'course',
      title: 'IELTS Preparation',
      description: 'Academic IELTS preparation course',
      attributes: { subject: 'IELTS', level: 'B1-B2', format: 'online' },
      offers: [
        {
          sourceEntityId: 'ielts-group-weekday',
          title: 'Weekday evenings (Mon/Wed 18:00)',
          price: { amount: '150.00', currency: 'USD' },
          pricingBasis: 'PER_PERSON',
          availabilityStatus: 'AVAILABLE',
          seatsLeft: 12,
          startsAt: '2026-11-02T18:00:00+05:00',
          endsAt: '2026-12-14T20:00:00+05:00',
          attributes: { schedule: 'Mon/Wed 18:00-20:00', location: 'online' },
        },
        {
          sourceEntityId: 'ielts-group-weekend',
          title: 'Weekend mornings (Sat 10:00)',
          price: { amount: '180.00', currency: 'USD' },
          pricingBasis: 'PER_PERSON',
          availabilityStatus: 'LIMITED',
          seatsLeft: 2,
          startsAt: '2026-11-07T10:00:00+05:00',
          endsAt: '2026-12-19T12:00:00+05:00',
          attributes: { schedule: 'Sat 10:00-12:00', location: 'online' },
        },
      ],
    },
    {
      sourceEntityId: 'edu-english-001',
      itemType: 'course',
      title: 'General English',
      description: 'General English course, all levels',
      attributes: { subject: 'English', level: 'A1-C1', format: 'offline' },
      offers: [
        {
          sourceEntityId: 'english-group-morning',
          title: 'Morning group (Tue/Thu 09:00)',
          price: { amount: '200.00', currency: 'USD' },
          pricingBasis: 'PER_PERSON',
          availabilityStatus: 'AVAILABLE',
          seatsLeft: 8,
          startsAt: '2026-11-03T09:00:00+05:00',
          endsAt: '2026-12-12T11:00:00+05:00',
          attributes: { schedule: 'Tue/Thu 09:00-11:00', location: 'Tashkent' },
        },
      ],
    },
  ];
}

/** Deterministic, fictional tourism fixtures (not real offerings or prices). */
export function tourismFixtures(): MockItemFixture[] {
  return [
    {
      sourceEntityId: 'tour-antalya-001',
      itemType: 'tour',
      title: 'Antalya 7 nights',
      description: '7-night tour to Antalya, Turkey',
      attributes: { destination: 'Antalya', nights: 7, kind: 'international' },
      offers: [
        {
          sourceEntityId: 'antalya-departure-2026-06-15',
          title: 'Departure 2026-06-15',
          price: { amount: '1200.00', currency: 'USD' },
          pricingBasis: 'PER_PERSON',
          availabilityStatus: 'AVAILABLE',
          seatsLeft: 14,
          startsAt: '2026-06-15T00:00:00+05:00',
          endsAt: '2026-06-22T00:00:00+05:00',
          attributes: {
            departureDate: '2026-06-15',
            hotelStars: 4,
            mealPlan: 'half-board',
          },
        },
        {
          sourceEntityId: 'antalya-departure-2026-07-01',
          title: 'Departure 2026-07-01',
          price: { amount: '1350.00', currency: 'USD' },
          pricingBasis: 'PER_PERSON',
          availabilityStatus: 'SOLD_OUT',
          seatsLeft: 0,
          startsAt: '2026-07-01T00:00:00+05:00',
          endsAt: '2026-07-08T00:00:00+05:00',
          attributes: {
            departureDate: '2026-07-01',
            hotelStars: 4,
            mealPlan: 'half-board',
          },
        },
      ],
    },
    {
      sourceEntityId: 'tour-istanbul-001',
      itemType: 'tour',
      title: 'Istanbul 3 nights',
      description: '3-night city break in Istanbul, Turkey',
      attributes: { destination: 'Istanbul', nights: 3, kind: 'international' },
      offers: [
        {
          sourceEntityId: 'istanbul-departure-2026-06-10',
          title: 'Departure 2026-06-10',
          price: { amount: '450.00', currency: 'USD' },
          pricingBasis: 'PER_PERSON',
          availabilityStatus: 'AVAILABLE',
          seatsLeft: 6,
          startsAt: '2026-06-10T00:00:00+05:00',
          endsAt: '2026-06-13T00:00:00+05:00',
          attributes: {
            departureDate: '2026-06-10',
            hotelStars: 3,
            mealPlan: 'breakfast',
          },
        },
      ],
    },
  ];
}

export function allFixtures(sourceSystem: string): MockItemFixture[] {
  if (sourceSystem.startsWith('mock-education')) {
    return educationFixtures();
  }
  if (sourceSystem.startsWith('mock-tourism')) {
    return tourismFixtures();
  }
  return [];
}

export function findOfferById(
  sourceSystem: string,
  items: readonly MockItemFixture[],
  offerId: string,
): { item: MockItemFixture; offer: MockOfferFixture } | undefined {
  // Offer ids are `<sourceSystem>:offer:<sourceEntityId>`; accept the bare
  // source entity id as well so callers can pass either form.
  const offerPrefix = `${sourceSystem}:offer:`;
  const offerSourceEntityId = offerId.startsWith(offerPrefix)
    ? offerId.slice(offerPrefix.length)
    : offerId.includes(':')
      ? offerId.split(':').slice(2).join(':')
      : offerId;
  for (const item of items) {
    const offer = item.offers.find(
      (o) => o.sourceEntityId === offerSourceEntityId,
    );
    if (offer) return { item, offer };
  }
  return undefined;
}
