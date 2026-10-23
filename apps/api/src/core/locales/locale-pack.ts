import type {
  AvailabilityStatus,
  Money,
} from '../../connectors/contracts/canonical.js';

/**
 * Locale Pack contract (AGENTS.md §6.2). Adding a language means adding a
 * pack; the core never contains customer-facing wording.
 *
 * `status` follows D18: a locale is `stable` only after its eval threshold is
 * met with native-speaker review. `nativeReviewed` records whether that
 * review actually happened; it is never assumed.
 */

export type LocaleId = 'uz-Latn' | 'uz-Cyrl' | 'ru' | 'en';
export type LanguageCode = 'uz' | 'ru' | 'en';
export type ScriptCode = 'Latn' | 'Cyrl';
export type LocaleStatus = 'stable' | 'beta' | 'planned';

/**
 * Handover reasons the agent core can raise (AGENTS.md §7.4). Failure
 * reasons are distinct so an operator can tell a missing record (NO_DATA)
 * from an unreachable CRM (CONNECTOR_UNAVAILABLE) or model (LLM_UNAVAILABLE).
 */
export const HANDOVER_REASONS = [
  'CUSTOMER_REQUEST',
  'COMPLAINT',
  'NEGOTIATION',
  'AUTH_REQUIRED',
  'NO_DATA',
  'GUARDRAIL',
  'BUDGET_EXCEEDED',
  'LLM_UNAVAILABLE',
  'CONNECTOR_UNAVAILABLE',
  'TOOL_LOOP_LIMIT',
  'LOW_LANG_CONFIDENCE',
  'STUCK',
  'HIGH_VALUE',
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export interface LocaleTemplates {
  readonly greeting: string;
  readonly error: string;
  readonly noResults: string;
  readonly offerOperator: string;
  readonly optionsIntro: string;
  readonly notUnderstood: string;
  /**
   * Asks the customer to write in a supported language. Must not promise
   * anything and must be understandable to a customer whose language we
   * could not identify, so it names every supported language.
   */
  readonly languageClarification: string;
  /**
   * Sent once when no operator has picked up a handover within the SLA and
   * the operators were reached. It must not promise a time or a reply.
   */
  readonly operatorDelayNotice: string;
  /**
   * Asks for a phone number after value was delivered. Appended at most once
   * per conversation; never contains digits or promises.
   */
  readonly phoneRequest: string;
  /** Truthful answer when the customer asks whether they talk to a bot. */
  readonly aiDisclosure: string;
  /**
   * Customer-facing handover notices. They must not claim that a person or
   * the CRM has accepted anything: until operator notification exists they
   * may only say that the message was recorded.
   */
  readonly handover: Readonly<Record<HandoverReason, string>>;
  readonly labels: {
    readonly price: string;
    readonly seats: string;
    readonly starts: string;
    readonly availability: string;
  };
  readonly availability: Readonly<Record<AvailabilityStatus, string>>;
}

export interface LocalePack {
  readonly id: LocaleId;
  readonly language: LanguageCode;
  readonly script: ScriptCode;
  readonly status: LocaleStatus;
  readonly nativeReviewed: boolean;
  /** BCP-47 tag for Intl number/date/currency formatting. */
  readonly intlLocale: string;
  /** How the language is named in model instructions. */
  readonly promptName: string;
  /** Tone and register guidance for the response model. */
  readonly toneGuidance: string;
  readonly templates: LocaleTemplates;
  /**
   * Stems of claims the bot may never make on its own (discounts, free
   * extras, guarantees); matched case-insensitively in model-written text.
   */
  readonly forbiddenClaimStems: readonly string[];
  /**
   * Imperative phrases, in any supported language, with which a customer asks
   * to be answered in THIS locale ("write in Russian"). Deliberately not bare
   * language names, which can also be a subject of the conversation. Matched
   * case-insensitively after apostrophe unification.
   */
  readonly languageRequestPhrases: readonly string[];
}

export class LocaleRegistry {
  private readonly packs = new Map<LocaleId, LocalePack>();

  constructor(packs: readonly LocalePack[]) {
    for (const pack of packs) {
      if (this.packs.has(pack.id))
        throw new Error(`Duplicate locale ${pack.id}`);
      if (pack.status === 'stable' && !pack.nativeReviewed) {
        throw new Error(
          `Locale ${pack.id} cannot be stable without native review`,
        );
      }
      this.packs.set(pack.id, pack);
    }
  }

  get(id: LocaleId): LocalePack {
    const pack = this.packs.get(id);
    if (!pack) throw new Error(`Unknown locale ${id}`);
    return pack;
  }

  has(id: string): id is LocaleId {
    return this.packs.has(id as LocaleId);
  }

  find(language: LanguageCode, script: ScriptCode): LocalePack | undefined {
    for (const pack of this.packs.values()) {
      if (pack.language === language && pack.script === script) return pack;
    }
    return undefined;
  }

  all(): LocalePack[] {
    return [...this.packs.values()];
  }
}

/**
 * Code-side rendering of hard facts in the customer's locale (D5). The
 * decimal string is formatted exactly (Intl accepts numeric strings), with
 * the source's precision: never rounded, never routed through a float.
 */
export function formatMoney(locale: LocalePack, money: Money): string {
  const decimals = (money.amount.split('.')[1] ?? '').replace(/0+$/, '').length;
  const digits = decimals === 0 ? 0 : Math.max(decimals, 2);
  const formatter = new Intl.NumberFormat(locale.intlLocale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // ES2023 Intl accepts decimal strings exactly; the bundled lib typings
  // only declare number | bigint.
  return (formatter.format as unknown as (value: string) => string)(
    money.amount,
  );
}

export function formatDateTime(
  locale: LocalePack,
  isoDateTime: string,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(locale.intlLocale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(isoDateTime));
}

export function formatInteger(locale: LocalePack, value: number): string {
  return new Intl.NumberFormat(locale.intlLocale, {
    maximumFractionDigits: 0,
  }).format(value);
}
