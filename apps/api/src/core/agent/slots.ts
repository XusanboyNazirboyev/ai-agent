import {
  normalizeForMatching,
  unifyApostrophes,
  type DomainPack,
  type SlotDefinition,
} from '@agentcore/shared';
import { z } from 'zod';
import type { CanonicalQuery } from '../../connectors/contracts/canonical.js';

/**
 * Slot engine (D4): the model only proposes raw slot values; code validates
 * them against the Domain Pack, decides what is missing, and builds queries.
 */

export type SlotValue = string | number;

export interface SlotEntry {
  readonly value: SlotValue;
  readonly source: 'customer' | 'inferred';
}

export type SlotState = Readonly<Record<string, SlotEntry>>;

export const INTENTS = [
  'greeting',
  'search',
  'details',
  'price',
  'availability',
  'booking_interest',
  'human_request',
  'complaint',
  'negotiation',
  'account_question',
  'ai_question',
  'other',
] as const;
export type Intent = (typeof INTENTS)[number];

export interface Extraction {
  readonly language: 'uz' | 'ru' | 'en' | 'other';
  readonly script: 'Latn' | 'Cyrl' | 'other';
  readonly intent: Intent;
  readonly slots: Readonly<Record<string, string | null>>;
}

/** Zod validator plus the matching JSON Schema for constrained decoding. */
export function extractionSchema(pack: DomainPack): {
  schema: z.ZodType<Extraction>;
  jsonSchema: Record<string, unknown>;
} {
  const slotShape: Record<string, z.ZodType<string | null>> = {};
  const slotProps: Record<string, unknown> = {};
  for (const slot of pack.slots) {
    slotShape[slot.key] = z.string().max(400).nullable();
    slotProps[slot.key] = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: slot.description,
    };
  }
  const schema = z
    .object({
      language: z.enum(['uz', 'ru', 'en', 'other']),
      script: z.enum(['Latn', 'Cyrl', 'other']),
      intent: z.enum(INTENTS),
      slots: z.object(slotShape).strict(),
    })
    .strict() as unknown as z.ZodType<Extraction>;
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['language', 'script', 'intent', 'slots'],
    properties: {
      language: { type: 'string', enum: ['uz', 'ru', 'en', 'other'] },
      script: { type: 'string', enum: ['Latn', 'Cyrl', 'other'] },
      intent: { type: 'string', enum: [...INTENTS] },
      slots: {
        type: 'object',
        additionalProperties: false,
        required: pack.slots.map((slot) => slot.key),
        properties: slotProps,
      },
    },
  };
  return { schema, jsonSchema };
}

export type NormalizedSlot =
  | { readonly kind: 'value'; readonly value: SlotValue }
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' };

/** Validates one proposed value against its slot definition. */
export function normalizeSlot(
  slot: SlotDefinition,
  raw: string | null | undefined,
): NormalizedSlot {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  const text = unifyApostrophes(raw).trim().replace(/\s+/gu, ' ');
  if (text.length === 0) return { kind: 'empty' };
  if (slot.type === 'enum') {
    const key = normalizeForMatching(text);
    for (const option of slot.options ?? []) {
      const names = [option.value, ...option.synonyms].map(
        normalizeForMatching,
      );
      if (names.includes(key)) return { kind: 'value', value: option.value };
    }
    return { kind: 'invalid' };
  }
  if (slot.type === 'integer') {
    if (!/^\d{1,3}$/.test(text)) return { kind: 'invalid' };
    const value = Number(text);
    if (
      (slot.min !== undefined && value < slot.min) ||
      (slot.max !== undefined && value > slot.max)
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'value', value };
  }
  // eslint-disable-next-line no-control-regex
  if (text.length > slot.maxLength || /[\u0000-\u001f]/u.test(text))
    return { kind: 'invalid' };
  return { kind: 'value', value: text };
}

/**
 * Deterministic enum detection from the raw message: synonyms the pack
 * lists ("onlayn", "очно") are matched as whole phrases in any script.
 * Complements model extraction and makes the mock mode useful.
 */
export function detectEnumSlots(
  pack: DomainPack,
  message: string,
): Record<string, string> {
  const haystack = ` ${normalizeForMatching(message).replace(/[^\p{L}\p{N}' ]+/gu, ' ')} `;
  const found: Record<string, string> = {};
  for (const slot of pack.slots) {
    if (slot.type !== 'enum') continue;
    for (const option of slot.options ?? []) {
      const names = [option.value, ...option.synonyms].map(
        normalizeForMatching,
      );
      if (names.some((name) => haystack.includes(` ${name} `))) {
        found[slot.key] = option.value;
        break;
      }
    }
  }
  return found;
}

export interface SlotMerge {
  readonly state: SlotState;
  readonly changed: readonly string[];
  readonly invalid: readonly string[];
}

/** Applies validated customer values; invalid proposals never overwrite. */
export function mergeSlots(
  pack: DomainPack,
  state: SlotState,
  proposed: Readonly<Record<string, string | null>>,
): SlotMerge {
  const next: Record<string, SlotEntry> = { ...state };
  const changed: string[] = [];
  const invalid: string[] = [];
  for (const slot of pack.slots) {
    const result = normalizeSlot(slot, proposed[slot.key]);
    if (result.kind === 'invalid') invalid.push(slot.key);
    if (result.kind !== 'value') continue;
    if (next[slot.key]?.value !== result.value) changed.push(slot.key);
    next[slot.key] = { value: result.value, source: 'customer' };
  }
  return { state: next, changed, invalid };
}

/** First slot (pack order) the stage needs but the state lacks. */
export function firstMissing(
  pack: DomainPack,
  state: SlotState,
  stage: 'search' | 'quote',
): SlotDefinition | undefined {
  return pack.slots.find(
    (slot) => slot.requiredFor.includes(stage) && state[slot.key] === undefined,
  );
}

/** Canonical query from filled slots; `requiredOnly` drops optional filters. */
export function searchQuery(
  pack: DomainPack,
  state: SlotState,
  options: { requiredOnly?: boolean } = {},
): CanonicalQuery {
  const attributes: Record<string, string | number> = {};
  let title: string | undefined;
  for (const slot of pack.slots) {
    const entry = state[slot.key];
    if (!entry || !slot.searchFilter) continue;
    if (options.requiredOnly && !slot.requiredFor.includes('search')) continue;
    if (slot.searchFilter.kind === 'title') title = String(entry.value);
    else attributes[slot.searchFilter.attribute] = entry.value;
  }
  return {
    itemType: pack.catalogItemType,
    ...(title ? { title } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    limit: pack.maxOptionsShown,
  };
}
