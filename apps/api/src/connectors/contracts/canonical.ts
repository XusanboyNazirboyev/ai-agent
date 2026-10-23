import { z } from 'zod';
import { CurrencyCodeSchema } from '@agentcore/shared';

/** Fixed lifecycle bases for offer pricing, aligned with Prisma PricingBasis. */
export const PricingBasisSchema = z.enum([
  'PER_PERSON',
  'PER_NIGHT',
  'PER_UNIT',
  'TOTAL',
  'UNSPECIFIED',
]);
export type PricingBasis = z.infer<typeof PricingBasisSchema>;

export const AvailabilityStatusSchema = z.enum([
  'AVAILABLE',
  'LIMITED',
  'SOLD_OUT',
  'UNKNOWN',
]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

/** Precise monetary amount as a decimal string, always paired with currency. */
export const MoneySchema = z
  .object({
    amount: z
      .string()
      .regex(/^-?\d+(?:\.\d+)?$/, 'amount must be a signed decimal string'),
    currency: CurrencyCodeSchema,
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;

export const CanonicalQuerySchema = z
  .object({
    itemType: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
export type CanonicalQuery = z.infer<typeof CanonicalQuerySchema>;

export const CatalogItemSchema = z
  .object({
    id: z.string().min(1),
    sourceSystem: z.string().min(1),
    sourceEntityId: z.string().min(1),
    itemType: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const OfferSchema = z
  .object({
    id: z.string().min(1),
    itemId: z.string().min(1),
    sourceSystem: z.string().min(1),
    sourceEntityId: z.string().min(1),
    price: MoneySchema.nullable().optional(),
    currency: z.string().length(3).optional(),
    pricingBasis: PricingBasisSchema.default('UNSPECIFIED'),
    taxesIncluded: z.boolean().optional(),
    feesIncluded: z.boolean().optional(),
    availabilityStatus: AvailabilityStatusSchema.default('UNKNOWN'),
    seatsLeft: z.number().int().min(0).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    validFrom: z.string().datetime({ offset: true }).optional(),
    validUntil: z.string().datetime({ offset: true }).optional(),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Offer = z.infer<typeof OfferSchema>;

export const AvailabilitySchema = z
  .object({
    offerId: z.string().min(1),
    status: AvailabilityStatusSchema,
    seatsLeft: z.number().int().min(0).optional(),
    validUntil: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type Availability = z.infer<typeof AvailabilitySchema>;

export const QuoteSchema = z
  .object({
    id: z.string().min(1),
    offerId: z.string().min(1),
    amount: MoneySchema,
    pricingBasis: PricingBasisSchema,
    breakdown: z.record(z.string(), z.unknown()).optional(),
    validUntil: z.string().datetime({ offset: true }).optional(),
    sourceSystem: z.string().min(1),
    sourceEntityId: z.string().min(1),
  })
  .strict();
export type Quote = z.infer<typeof QuoteSchema>;

export const LeadInputSchema = z
  .object({
    contact: z
      .object({
        name: z.string().min(1).optional(),
        phone: z.string().min(1).optional(),
      })
      .strict(),
    summary: z.string().min(1),
    slots: z.record(z.string(), z.unknown()).default({}),
    score: z.enum(['HOT', 'WARM', 'COLD']).optional(),
    reasonCodes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type LeadInput = z.infer<typeof LeadInputSchema>;

export const BookingInputSchema = z
  .object({
    offerId: z.string().min(1),
    contact: z
      .object({
        name: z.string().min(1).optional(),
        phone: z.string().min(1).optional(),
      })
      .strict(),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type BookingInput = z.infer<typeof BookingInputSchema>;

export function parseCanonicalQuery(input: unknown): CanonicalQuery {
  return CanonicalQuerySchema.parse(input);
}

export function parseCatalogItem(input: unknown): CatalogItem {
  return CatalogItemSchema.parse(input);
}

export function parseOffer(input: unknown): Offer {
  return OfferSchema.parse(input);
}

export function parseAvailability(input: unknown): Availability {
  return AvailabilitySchema.parse(input);
}

export function parseQuote(input: unknown): Quote {
  return QuoteSchema.parse(input);
}

export function parseMoney(input: unknown): Money {
  return MoneySchema.parse(input);
}
