import { unifyApostrophes } from '@agentcore/shared';
import type { LocalePack } from '../locales/locale-pack.js';
import {
  checkReferences,
  type EvidenceContext,
  type EvidenceViolation,
} from './display-gate.js';
import { FACT_REFERENCE, FactStore } from './facts.js';
import { detectLanguage } from './language.js';

/**
 * Reply guardrail (AGENTS.md §7.3, addendum override of D5).
 *
 * The primary control is structural: commercial facts can only enter a
 * reply through `{{F<n>}}` references that code renders from this turn's
 * tool results. This check enforces that contract on the model's draft:
 * no unknown or stale references, no numbers the customer did not write,
 * no currency outside a price fact, no forbidden claims, no internal
 * markers, and the target language/script. It is a backstop, not the only
 * line of defence.
 */

export type GuardrailViolation =
  | 'EMPTY'
  | 'TOO_LONG'
  | EvidenceViolation
  | 'UNSOURCED_AVAILABILITY'
  | 'UNSOURCED_NUMBER'
  | 'UNSOURCED_CURRENCY'
  | 'FORBIDDEN_CLAIM'
  /** The draft claims a business action was completed; only code may say that. */
  | 'ACTION_CLAIM'
  | 'PROMPT_LEAK'
  | 'SCRIPT_MISMATCH'
  | 'LANGUAGE_MISMATCH';

export interface GuardrailResult {
  readonly violations: readonly GuardrailViolation[];
  /** The customer-facing text, present only when there are no violations. */
  readonly rendered?: string;
  /** Fact ids referenced by the accepted draft (present with `rendered`). */
  readonly references?: readonly string[];
  /** Number tokens behind UNSOURCED_NUMBER (diagnostics only, ADR 029). */
  readonly unsourcedNumbers?: readonly string[];
}

const MAX_REPLY_CHARS = 1_500;
const CURRENCY =
  /[$€₽£¥₸]|\b(?:usd|uzs|eur|rub|kzt)\b|so'm|сўм|\bсум\b|\bруб|dollar|доллар|евро|рубл/iu;
const LEAK =
  /system prompt|<\/?(?:system|instructions?|tool_result|catalog_context|customer_message)>|\b(?:search_catalog|get_item_details|list_offers|check_availability|get_quote|knowledge_search)\b|\{\{(?!\s*F\d)/iu;

export function checkDraft(
  draft: string,
  context: {
    readonly facts: FactStore;
    readonly locale: LocalePack;
    readonly customerTexts: readonly string[];
    readonly timeZone: string;
    readonly now: Date;
    /** Tenant, conversation and display policy the evidence is checked against. */
    readonly evidence: Omit<EvidenceContext, 'now'>;
  },
): GuardrailResult {
  const violations = new Set<GuardrailViolation>();
  const text = draft.trim();
  if (text.length === 0) return { violations: ['EMPTY'] };
  if (text.length > MAX_REPLY_CHARS) violations.add('TOO_LONG');

  // Evidence first: every reference must be backed by verified stored facts
  // (existence, tenant/conversation, offer, expiry, freshness, liveness).
  const references = FactStore.references(text);
  for (const violation of checkReferences(references, context.facts, {
    ...context.evidence,
    now: context.now,
  }))
    violations.add(violation);
  const rendered = new Map<string, string>();
  for (const id of references) {
    const value = context.facts.render(
      id,
      context.locale,
      context.timeZone,
      context.now,
    );
    if (value !== undefined) rendered.set(id, value);
  }

  // Everything below inspects only what the model wrote itself.
  const own = unifyApostrophes(text.replace(FACT_REFERENCE, ' '));
  const titles = context.facts
    .list()
    .flatMap((fact) => (fact.value.kind === 'title' ? [fact.value.text] : []));
  const echoes = [...context.customerTexts, ...titles].map((value) =>
    unifyApostrophes(value),
  );

  const unsourcedNumbers: string[] = [];
  for (const number of own.match(/\d+(?:[.,:]\d+)*/gu) ?? []) {
    if (!echoes.some((source) => source.includes(number))) {
      violations.add('UNSOURCED_NUMBER');
      unsourcedNumbers.push(number);
    }
  }
  if (CURRENCY.test(own)) violations.add('UNSOURCED_CURRENCY');
  const lower = own.toLowerCase();
  // An availability phrase the model typed itself is a claim without a fact.
  if (
    Object.values(context.locale.templates.availability).some((phrase) =>
      lower.includes(unifyApostrophes(phrase).toLowerCase()),
    )
  ) {
    violations.add('UNSOURCED_AVAILABILITY');
  }
  if (
    context.locale.forbiddenClaimStems.some((stem) =>
      lower.includes(stem.toLowerCase()),
    )
  ) {
    violations.add('FORBIDDEN_CLAIM');
  }
  if (
    context.locale.actionClaimStems.some((stem) =>
      lower.includes(unifyApostrophes(stem).toLowerCase()),
    )
  ) {
    violations.add('ACTION_CLAIM');
  }
  if (LEAK.test(own)) violations.add('PROMPT_LEAK');

  // Script: ignore words echoed from the customer or from item titles.
  const echoWords = new Set(
    echoes
      .flatMap((source) => source.toLowerCase().split(/[^\p{L}']+/u))
      .filter(Boolean),
  );
  const ownWords = lower
    .split(/[^\p{L}']+/u)
    .filter((word) => word && !echoWords.has(word));
  const letters = ownWords.join('');
  const latin = letters.match(/[a-z]/gu)?.length ?? 0;
  const cyrillic = letters.match(/[\u0400-\u04ff]/gu)?.length ?? 0;
  if (latin + cyrillic > 0) {
    const foreign = context.locale.script === 'Cyrl' ? latin : cyrillic;
    if (foreign / (latin + cyrillic) > 0.2) violations.add('SCRIPT_MISMATCH');
  }
  const detected = detectLanguage(ownWords.join(' '));
  if (
    detected.confidence >= 0.8 &&
    detected.language !== context.locale.language
  ) {
    violations.add('LANGUAGE_MISMATCH');
  }

  if (violations.size > 0)
    return {
      violations: [...violations],
      ...(unsourcedNumbers.length ? { unsourcedNumbers } : {}),
    };
  return {
    violations: [],
    references: [...new Set(references)],
    rendered: text.replace(
      FACT_REFERENCE,
      (_match, id: string) => rendered.get(id) ?? '',
    ),
  };
}
