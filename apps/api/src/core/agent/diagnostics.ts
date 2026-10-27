import type { Fact } from './facts.js';
import { redactPii } from './redaction.js';

/**
 * Blocked-draft diagnostics (ADR 029 decision 1). When the guardrail blocks
 * a draft, the turn keeps the draft (PII-redacted) and, for every number
 * the guardrail flagged, what kind of number it looks like and where it
 * could have come from. Internal only: never sent to customers, operators
 * or the web API, and purged after a bounded retention. Recording it never
 * changes the reply or the outcome.
 */

export type FlaggedTokenClass =
  | 'price'
  | 'time'
  | 'date'
  | 'seats_or_quantity'
  | 'list_marker'
  | 'phone_like'
  | 'other';

export interface FlaggedToken {
  /** The digits as written; null for phone-like tokens (class only). */
  readonly token: string | null;
  readonly class: FlaggedTokenClass;
  /** A fact of this turn whose rendered value contains the same number. */
  readonly matchedFactId: string | null;
  readonly matchedFactKind: string | null;
  /** The number appears in a tool result the model saw in this turn. */
  readonly inToolResult: boolean;
  /** The number appears in the customer's own text. */
  readonly inCustomerText: boolean;
}

export interface BlockedDraftDiagnostic {
  readonly stage: 'first' | 'regeneration';
  readonly violations: readonly string[];
  readonly draftRedacted: string;
  readonly tokens: readonly FlaggedToken[];
}

export interface TurnDiagnostics {
  readonly blockedDrafts: readonly BlockedDraftDiagnostic[];
}

const MAX_DRAFT_CHARS = 1_500;
const MAX_TOKENS = 40;
/** Currency signs and words; a number directly next to one is a price. */
const CURRENCY =
  "[$€₽£¥₸]|usd|uzs|eur|rub|kzt|so'm|сўм|сум|руб\\p{L}*|dollar\\p{L}*|доллар\\p{L}*|евро";

const escape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** True when `number` occurs in `text` as a whole number (not inside a longer one). */
export function containsNumber(text: string, number: string): boolean {
  return new RegExp(
    `(?<!\\d)(?<!\\d[.,:])${escape(number)}(?!\\d|[.,:]\\d)`,
    'u',
  ).test(text);
}

function digitCount(token: string): number {
  return token.replace(/\D/gu, '').length;
}

/** Classifies one flagged token from its shape and its place in the draft. */
export function classifyToken(
  token: string,
  draft: string,
  facts: readonly Fact[],
): FlaggedTokenClass {
  if (/^\d{1,2}:\d{2}$/u.test(token)) return 'time';
  if (
    /^\d{1,2}[.]\d{1,2}[.]\d{2,4}$/u.test(token) ||
    /^(?:19|20)\d{2}$/u.test(token)
  )
    return 'date';
  if (digitCount(token) >= 7) return 'phone_like';
  const at = escape(token);
  if (new RegExp(`(?:^|\\n)[ \\t]*${at}[.)]\\s`, 'u').test(draft))
    return 'list_marker';
  if (
    new RegExp(
      `(?:${CURRENCY})\\s?${at}(?!\\d)|(?<!\\d)${at}\\s?(?:${CURRENCY})`,
      'iu',
    ).test(draft)
  )
    return 'price';
  for (const fact of facts) {
    if (
      fact.value.kind === 'price' &&
      Number(fact.value.money.amount) === Number(token.replace(',', '.'))
    )
      return 'price';
    if (fact.value.kind === 'seats' && String(fact.value.count) === token)
      return 'seats_or_quantity';
  }
  return 'other';
}

export function diagnoseBlockedDraft(input: {
  readonly stage: BlockedDraftDiagnostic['stage'];
  readonly draft: string;
  readonly violations: readonly string[];
  readonly unsourcedNumbers: readonly string[];
  readonly facts: readonly Fact[];
  /** The rendered value of a fact in the reply's locale, if renderable. */
  readonly render: (fact: Fact) => string | undefined;
  readonly toolTexts: readonly string[];
  readonly customerTexts: readonly string[];
}): BlockedDraftDiagnostic {
  const tokens = [...new Set(input.unsourcedNumbers)]
    .slice(0, MAX_TOKENS)
    .map((token): FlaggedToken => {
      const kind = classifyToken(token, input.draft, input.facts);
      const matched = input.facts.find((fact) => {
        const rendered = input.render(fact);
        return rendered !== undefined && containsNumber(rendered, token);
      });
      return {
        token: kind === 'phone_like' ? null : token,
        class: kind,
        matchedFactId: matched?.id ?? null,
        matchedFactKind: matched?.value.kind ?? null,
        inToolResult: input.toolTexts.some((text) =>
          containsNumber(text, token),
        ),
        inCustomerText: input.customerTexts.some((text) =>
          containsNumber(text, token),
        ),
      };
    });
  return {
    stage: input.stage,
    violations: [...input.violations],
    draftRedacted: redactPii(input.draft, MAX_DRAFT_CHARS),
    tokens,
  };
}
