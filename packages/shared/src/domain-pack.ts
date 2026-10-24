import { z } from 'zod';
import {
  DomainPackKeySchema,
  ItemTypeSchema,
  LocaleIdSchema,
  PackVersionSchema,
  SlotKeySchema,
} from './persistence-schemas';

/**
 * Domain Pack contract (AGENTS.md §5.1): everything vertical-specific the
 * generic agent core needs, as validated data. The core never contains
 * domain words; it reads slots, questions, tool permissions and prompt
 * fragments from here.
 */

/** Generic tools the core can expose; a pack enables a subset. */
export const AGENT_TOOL_NAMES = [
  'search_catalog',
  'get_item_details',
  'list_offers',
  'check_availability',
  'get_quote',
  'knowledge_search',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const SlotValueOptionSchema = z
  .object({
    value: z.string().min(1).max(60),
    /** Spellings customers use, in any script; matched script-insensitively. */
    synonyms: z.array(z.string().min(1).max(60)).default([]),
  })
  .strict();

/** How a slot narrows a catalog search; absent means it does not filter. */
const SearchFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title') }).strict(),
  z
    .object({
      kind: z.literal('attribute'),
      attribute: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    })
    .strict(),
]);

export const SlotDefinitionSchema = z
  .object({
    key: SlotKeySchema,
    type: z.enum(['text', 'enum', 'integer']),
    /** Extraction guidance for the model (what the slot means, examples). */
    description: z.string().min(1).max(400),
    options: z.array(SlotValueOptionSchema).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    maxLength: z.number().int().min(1).max(200).default(80),
    /** Stages that cannot proceed without this slot. */
    requiredFor: z.array(z.enum(['search', 'quote'])).default([]),
    searchFilter: SearchFilterSchema.optional(),
    /** One clarifying question per locale, asked when the slot is missing. */
    questions: z.record(LocaleIdSchema, z.string().min(1).max(300)),
  })
  .strict();

/** One deterministic lead-scoring rule (Phase 5). */
export const LeadRuleSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/u),
    points: z.number().int().min(1).max(10),
    when: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('slot_present'), slot: SlotKeySchema })
        .strict(),
      z
        .object({
          kind: z.literal('slot_equals'),
          slot: SlotKeySchema,
          value: z.string().min(1).max(60),
        })
        .strict(),
      z
        .object({
          kind: z.literal('intent'),
          intent: z.string().min(1).max(40),
        })
        .strict(),
      z.object({ kind: z.literal('contact_phone') }).strict(),
      z.object({ kind: z.literal('offer_shown') }).strict(),
      z.object({ kind: z.literal('quote_shown') }).strict(),
    ]),
  })
  .strict();

export const LeadScoringSchema = z
  .object({
    rules: z.array(LeadRuleSchema).min(1).max(30),
    /** Score at which the lead is HOT / WARM; below `warm` it is COLD. */
    hot: z.number().int().min(1).max(100),
    warm: z.number().int().min(1).max(100),
  })
  .strict()
  .refine((scoring) => scoring.hot > scoring.warm, {
    message: 'hot must be greater than warm',
  });
export type LeadScoring = z.infer<typeof LeadScoringSchema>;

/** A field an action sends, and where its value comes from (ADR 024). */
export const ActionFieldSchema = z
  .object({
    /** Canonical target: `slots.<key>` of the operation input, or a contact field. */
    name: z
      .string()
      .regex(/^(slots\.[A-Za-z][A-Za-z0-9_]{0,39}|contact\.(name|phone))$/u),
    from: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('slot'), slot: SlotKeySchema }).strict(),
      z
        .object({
          kind: z.literal('contact'),
          field: z.enum(['name', 'phone']),
        })
        .strict(),
    ]),
    required: z.boolean(),
    /** Per-locale label shown in the confirmation summary. */
    label: z.record(LocaleIdSchema, z.string().min(1).max(60)),
  })
  .strict();

/**
 * A business action a pack offers (ADR 022/024). Generic: it maps collected
 * slots and contact fields to one connector write operation. Whether a tenant
 * enables it, and under which data policy, is tenant configuration.
 */
export const ActionSpecSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/u),
    /** Generic connector capability the action uses. */
    operation: z.enum(['createLead']),
    /** Customer intents that start the action. */
    triggerIntents: z.array(z.enum(['booking_interest'])).min(1),
    fields: z.array(ActionFieldSchema).min(1).max(12),
    /** v1 allows only explicit confirmation (owner decision D-1 still open). */
    confirmation: z.literal('explicit'),
    expiresAfterMinutes: z.number().int().min(5).max(1440).default(30),
    /** Per-locale name of the action in the summary ("course enquiry"). */
    title: z.record(LocaleIdSchema, z.string().min(1).max(80)),
    /** Pack-written lead summary prefix sent to the CRM (no customer text). */
    crmSummary: z.string().min(1).max(200),
    showExternalReference: z.boolean().default(false),
  })
  .strict();
export type ActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionField = z.infer<typeof ActionFieldSchema>;

export const DomainPackSchema = z
  .object({
    key: DomainPackKeySchema,
    version: PackVersionSchema,
    /** Canonical item type the pack sells (matches connector catalogItemType). */
    catalogItemType: ItemTypeSchema,
    locales: z.array(LocaleIdSchema).min(1),
    /** Ordered: the first missing required slot is the next question. */
    slots: z.array(SlotDefinitionSchema).min(1),
    tools: z.array(z.enum(AGENT_TOOL_NAMES)).min(1),
    maxOptionsShown: z.number().int().min(1).max(5).default(3),
    /** Knowledge retrieval settings (RAG over textual knowledge only). */
    knowledge: z
      .object({
        /** Minimum cosine similarity for a passage to count as relevant. */
        minScore: z.number().min(-1).max(1).default(0.5),
        /** A regulated passage older than this is treated as unverified. */
        regulatedMaxAgeDays: z.number().int().min(1).max(3650).default(180),
      })
      .strict()
      .default({ minScore: 0.5, regulatedMaxAgeDays: 180 }),
    /**
     * Optional: a confirmed quote at or above this amount (same currency) is
     * not sent to the customer; a person confirms it (HIGH_VALUE handover).
     */
    highValue: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/u),
        minAmount: z.string().regex(/^\d{1,15}(?:\.\d{1,6})?$/u),
      })
      .strict()
      .optional(),
    /** Optional deterministic lead scoring; without it no lead is scored. */
    leadScoring: LeadScoringSchema.optional(),
    /** Optional business actions (disabled until a tenant enables them). */
    actions: z.array(ActionSpecSchema).max(10).default([]),
    prompt: z
      .object({
        businessRole: z.string().min(1).max(400),
        rules: z.array(z.string().min(1).max(300)).max(20).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((pack, context) => {
    const keys = new Set<string>();
    pack.slots.forEach((slot, index) => {
      const at = ['slots', index];
      if (keys.has(slot.key)) {
        context.addIssue({
          code: 'custom',
          path: [...at, 'key'],
          message: 'duplicate slot key',
        });
      }
      keys.add(slot.key);
      if (slot.type === 'enum' && !slot.options?.length) {
        context.addIssue({
          code: 'custom',
          path: [...at, 'options'],
          message: 'enum slots need options',
        });
      }
      if (slot.type !== 'enum' && slot.options) {
        context.addIssue({
          code: 'custom',
          path: [...at, 'options'],
          message: 'only enum slots take options',
        });
      }
      for (const locale of pack.locales) {
        if (!slot.questions[locale]) {
          context.addIssue({
            code: 'custom',
            path: [...at, 'questions', locale],
            message: `missing question for pack locale ${locale}`,
          });
        }
      }
    });
    if (!pack.slots.some((slot) => slot.requiredFor.includes('search'))) {
      context.addIssue({
        code: 'custom',
        path: ['slots'],
        message: 'at least one slot must be required for search',
      });
    }
    const actionKeys = new Set<string>();
    pack.actions.forEach((action, index) => {
      const at = ['actions', index];
      if (actionKeys.has(action.key))
        context.addIssue({
          code: 'custom',
          path: [...at, 'key'],
          message: 'duplicate action key',
        });
      actionKeys.add(action.key);
      const names = new Set<string>();
      action.fields.forEach((field, fieldIndex) => {
        if (names.has(field.name))
          context.addIssue({
            code: 'custom',
            path: [...at, 'fields', fieldIndex, 'name'],
            message: 'duplicate field',
          });
        names.add(field.name);
        if (field.from.kind === 'slot' && !keys.has(field.from.slot))
          context.addIssue({
            code: 'custom',
            path: [...at, 'fields', fieldIndex, 'from'],
            message: 'unknown slot',
          });
        if (
          field.from.kind === 'contact' &&
          field.name !== `contact.${field.from.field}`
        )
          context.addIssue({
            code: 'custom',
            path: [...at, 'fields', fieldIndex, 'name'],
            message: 'contact fields map to themselves',
          });
        for (const locale of pack.locales)
          if (!field.label[locale])
            context.addIssue({
              code: 'custom',
              path: [...at, 'fields', fieldIndex, 'label', locale],
              message: `missing label for ${locale}`,
            });
      });
      for (const locale of pack.locales)
        if (!action.title[locale])
          context.addIssue({
            code: 'custom',
            path: [...at, 'title', locale],
            message: `missing title for ${locale}`,
          });
    });
    if (!pack.tools.includes('search_catalog')) {
      context.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'search_catalog is required',
      });
    }
  });

export type SlotDefinition = z.infer<typeof SlotDefinitionSchema>;
export type DomainPack = z.infer<typeof DomainPackSchema>;
