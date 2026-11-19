import type {
  AvailabilityStatus,
  Money,
} from '../../connectors/contracts/canonical.js';
import {
  formatDateTime,
  formatInteger,
  formatMoney,
  type LocalePack,
} from '../locales/locale-pack.js';

/**
 * Hard facts with provenance (D1, D5). Every price, seat count, date,
 * availability or item title the customer sees comes from a tool result in
 * this turn and is referenced by the model only as `{{F<n>}}`; code renders
 * the value. The model never types a commercial number itself.
 */

export type FactValue =
  | {
      readonly kind: 'title';
      readonly text: string;
      /** ADR 044: the canonical catalog item id (rich channel cards). */
      readonly itemId?: string;
      /** ADR 044: the item's https image, for channels that show cards. */
      readonly imageUrl?: string;
    }
  | {
      readonly kind: 'price';
      readonly money: Money;
      readonly confirmedQuote: boolean;
      /** Pricing semantics of the source (canonical PricingBasis). */
      readonly pricingBasis?: string;
    }
  | { readonly kind: 'seats'; readonly count: number }
  | { readonly kind: 'availability'; readonly status: AvailabilityStatus }
  | { readonly kind: 'datetime'; readonly iso: string }
  /** The current date and time, read from the server clock in this turn. */
  | { readonly kind: 'clock'; readonly iso: string }
  | {
      /** A retrieved knowledge passage; rendered verbatim by code. */
      readonly kind: 'knowledge';
      readonly text: string;
      readonly source: string;
      readonly updatedAt: string;
      readonly regulated: boolean;
    };

export interface FactProvenance {
  readonly tool: string;
  readonly connectorKey: string;
  readonly sourceSystem: string;
  readonly sourceEntityId: string;
  readonly retrievedAt: string;
  readonly validUntil?: string;
  /**
   * Evidence binding, stamped by code from the connector that answered and
   * the turn's scope (never from model output). The display gate rejects a
   * commercial fact whose binding is missing or does not match the turn.
   */
  readonly tenantId?: string;
  readonly conversationId?: string;
  readonly offerId?: string;
  /** True only for a fresh get_quote / check_availability result. */
  readonly live?: boolean;
}

export interface Fact {
  readonly id: string;
  readonly value: FactValue;
  readonly provenance: FactProvenance;
}

export const FACT_REFERENCE = /\{\{\s*(F\d{1,4})\s*\}\}/gu;

/**
 * The reserved id of the clock fact. Prompts offer it on every turn, and
 * code registers it only when a draft uses it, so numbered tool facts keep
 * their ids and a turn that never mentions the time records no clock fact.
 */
export const CLOCK_FACT_ID = 'F0';
const CLOCK_REFERENCE = /\{\{\s*F0\s*\}\}/u;

/** Locale rendering of one fact value; the only way facts reach text. */
export function renderFactValue(
  value: FactValue,
  locale: LocalePack,
  timeZone: string,
): string {
  switch (value.kind) {
    case 'title':
      return value.text;
    case 'price':
      return formatMoney(locale, value.money);
    case 'seats':
      return formatInteger(locale, value.count);
    case 'availability':
      return locale.templates.availability[value.status];
    case 'datetime':
      return formatDateTime(locale, value.iso, timeZone);
    case 'clock':
      return new Intl.DateTimeFormat(locale.intlLocale, {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone,
      }).format(new Date(value.iso));
    case 'knowledge': {
      // A regulated statement always carries where it comes from and when it
      // was last verified; other passages are attributed internally only.
      if (!value.regulated) return value.text;
      const date = new Intl.DateTimeFormat(locale.intlLocale, {
        dateStyle: 'medium',
        timeZone,
      }).format(new Date(value.updatedAt));
      return `${value.text} (${value.source}, ${date})`;
    }
  }
}

export class FactStore {
  private readonly facts = new Map<string, Fact>();
  private readonly byKey = new Map<string, string>();
  private sequence = 0;

  add(value: FactValue, provenance: FactProvenance): string {
    // The same value from the same source keeps one id within a turn.
    const key = JSON.stringify([
      value,
      provenance.tool,
      provenance.sourceEntityId,
    ]);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    this.sequence += 1;
    const id = `F${this.sequence}`;
    this.facts.set(id, { id, value, provenance });
    this.byKey.set(key, id);
    return id;
  }

  get(id: string): Fact | undefined {
    return this.facts.get(id);
  }

  /**
   * Registers the clock fact when a draft references it (D5: the model
   * never types the date; code renders it from the server clock).
   */
  addClockIfReferenced(
    draft: string,
    now: Date,
    scope: { readonly tenantId: string; readonly conversationId: string },
  ): void {
    if (this.facts.has(CLOCK_FACT_ID) || !CLOCK_REFERENCE.test(draft)) return;
    const iso = now.toISOString();
    this.facts.set(CLOCK_FACT_ID, {
      id: CLOCK_FACT_ID,
      value: { kind: 'clock', iso },
      provenance: {
        tool: 'clock',
        connectorKey: 'system',
        sourceSystem: 'clock',
        sourceEntityId: 'now',
        retrievedAt: iso,
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
      },
    });
  }

  list(): Fact[] {
    return [...this.facts.values()];
  }

  /** Renders a fact, or undefined when it is unknown or no longer valid. */
  render(
    id: string,
    locale: LocalePack,
    timeZone: string,
    now: Date,
  ): string | undefined {
    const fact = this.facts.get(id);
    if (!fact) return undefined;
    if (
      fact.provenance.validUntil &&
      new Date(fact.provenance.validUntil) <= now
    ) {
      return undefined; // stale: never shown as current
    }
    return renderFactValue(fact.value, locale, timeZone);
  }

  /** Fact ids referenced by a draft, in order of appearance. */
  static references(draft: string): string[] {
    return [...draft.matchAll(FACT_REFERENCE)].map((match) => match[1]);
  }
}
