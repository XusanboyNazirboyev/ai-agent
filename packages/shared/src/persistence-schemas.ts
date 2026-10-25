import { z } from 'zod';
import { CurrencyCodeSchema } from './currency-codes';

export const LocaleIdSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

export const DomainPackKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);

export const PackVersionSchema = z.string().trim().min(1).max(64);

export const ItemTypeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);

export const HandoverReasonCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,99}$/);

export const SlotKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);

export const CapabilityIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);

export const TenantLocaleSettingsSchema = z
  .object({
    defaultLocale: LocaleIdSchema,
    supportedLocales: z.array(LocaleIdSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.supportedLocales.includes(value.defaultLocale)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultLocale'],
        message: 'defaultLocale must be included in supportedLocales',
      });
    }
    if (
      new Set(value.supportedLocales).size !== value.supportedLocales.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['supportedLocales'],
        message: 'supportedLocales must not contain duplicates',
      });
    }
  });

export const TenantConfigSchema = z
  .object({
    tone: z.string().trim().min(1).max(120).optional(),
    handoverSlaMinutes: z.number().int().positive().max(10_080).optional(),
    fallbackLocale: LocaleIdSchema.optional(),
    /**
     * Business actions this tenant enables (ADR 024). Absent = all off.
     * - mode `live` lets the agent propose and, after confirmation, execute.
     * - allowUnprotectedConnector: allow execution through a connector without
     *   native/lookup idempotency (owner decision D-2; default false).
     * - consent: per-locale text shown with every proposal that sends contact
     *   data; required for such actions (owner decision D-5 decides wording).
     */
    actions: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{2,40}$/u),
        z
          .object({
            mode: z.enum(['off', 'live']).default('off'),
            allowUnprotectedConnector: z.boolean().default(false),
            consent: z
              .record(LocaleIdSchema, z.string().min(1).max(400))
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const TenantRetentionSettingsSchema = z
  .object({
    conversationDays: z.number().int().positive().optional(),
    messageDays: z.number().int().positive().optional(),
    inboundEventMinutes: z.number().int().positive().optional(),
  })
  .strict();

export const CatalogAttributesSchema = z
  .object({
    fields: z.record(z.string().min(1), z.json()),
  })
  .strict();

export const ConversationSlotValueSchema = z
  .object({
    value: z.json(),
    source: z.enum(['customer', 'inferred', 'connector', 'operator']),
    confidence: z.number().min(0).max(1).optional(),
    confirmedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ConversationSlotsSchema = z
  .object({
    version: z.number().int().positive(),
    slots: z.record(SlotKeySchema, ConversationSlotValueSchema),
  })
  .strict();

export const QuoteBreakdownSchema = z
  .object({
    lines: z.array(
      z
        .object({
          label: z.string().min(1),
          amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
          currency: CurrencyCodeSchema,
        })
        .strict(),
    ),
    taxesIncluded: z.boolean().nullable(),
    feesIncluded: z.boolean().nullable(),
  })
  .strict();

export const QuoteSnapshotSchema = z
  .object({
    itemTitle: z.string().min(1),
    offerFacts: z.record(z.string().min(1), z.json()),
    price: z
      .object({
        amount: z.string().regex(/^\d+(?:\.\d+)?$/),
        currency: CurrencyCodeSchema,
        pricingBasis: z.enum([
          'PER_PERSON',
          'PER_NIGHT',
          'PER_UNIT',
          'TOTAL',
          'UNSPECIFIED',
        ]),
      })
      .strict(),
  })
  .strict();

export const HandoverSummarySchema = z
  .object({
    verifiedFacts: z.array(z.string()),
    customerClaims: z.array(z.string()),
    inferences: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .strict();

export type TenantConfig = z.infer<typeof TenantConfigSchema>;
export type TenantLocaleSettings = z.infer<typeof TenantLocaleSettingsSchema>;
export type TenantRetentionSettings = z.infer<
  typeof TenantRetentionSettingsSchema
>;
export type CatalogAttributes = z.infer<typeof CatalogAttributesSchema>;
export type ConversationSlots = z.infer<typeof ConversationSlotsSchema>;
export type QuoteBreakdown = z.infer<typeof QuoteBreakdownSchema>;
export type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;
export type HandoverSummary = z.infer<typeof HandoverSummarySchema>;
