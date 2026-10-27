import type { Fact } from './facts.js';

/**
 * A reply made by code from verified facts only, for the case where the model
 * could not produce an acceptable draft but a live confirmed quote exists.
 * It contains nothing but two fact references ("title: price"); the caller
 * runs it through the same guardrail and display gate as any model draft, so
 * the price is rendered by code and only if it is live, fresh and sourced.
 *
 * Deliberately narrow: exactly one title fact and exactly one live confirmed
 * price fact, so the pairing is unambiguous. Anything else returns undefined
 * and the turn stays a handover.
 */
export function verifiedQuoteDraft(facts: readonly Fact[]): string | undefined {
  const titles = facts.filter((fact) => fact.value.kind === 'title');
  const quotes = facts.filter(
    (fact) =>
      fact.value.kind === 'price' &&
      fact.value.confirmedQuote &&
      fact.provenance.live === true,
  );
  if (titles.length !== 1 || quotes.length !== 1) return undefined;
  return `{{${titles[0].id}}}: {{${quotes[0].id}}}`;
}
