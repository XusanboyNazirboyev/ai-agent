import { factLines } from './facts';

/** The i18n `t` function (an unknown key comes back unchanged). */
type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const GROUPS = [
  'customerClaims',
  'inferences',
  'unknowns',
  'verifiedFacts',
] as const;

/** A translated message, or `fallback` when the catalog has no such key. */
function known(t: Translate, key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

/** Why a conversation was handed over, in words an operator understands. */
export function reasonLabel(t: Translate, code: string): string {
  return known(t, `handover.reason.${code}`, code);
}

/** One `key=value` entry of the stored summary, translated where known. */
function entry(
  t: Translate,
  item: string,
  shownReason: string | undefined,
): string | null {
  const at = item.indexOf('=');
  if (at <= 0) return item;
  const key = item.slice(0, at);
  const value = item.slice(at + 1);
  switch (key) {
    case 'reason':
      if (value === 'none' || value === shownReason) return null;
      return `${t('handover.field.reason')}: ${reasonLabel(t, value)}`;
    case 'intent':
      return `${t('handover.field.intent')}: ${known(t, `handover.intent.${value}`, value)}`;
    case 'locale':
      return `${t('handover.field.language')}: ${known(t, `handover.language.${value}`, value)}`;
    case 'llmFailure':
    case 'budgetStop':
    case 'guardrail':
      return `${t('handover.field.technical')}: ${key} ${value}`;
    default:
      // A slot of the domain pack, as the customer gave it.
      return `${key}: ${value}`;
  }
}

/**
 * The structured handover summary (HandoverSummarySchema: string lists of
 * `key=value`) as readable lines; the reason already shown above it is not
 * repeated. Any other shape falls back to the generic fact lines.
 */
export function handoverSummaryLines(
  t: Translate,
  summary: unknown,
  shownReason?: string,
): string[] {
  if (
    !summary ||
    typeof summary !== 'object' ||
    !GROUPS.some((group) =>
      Array.isArray((summary as Record<string, unknown>)[group]),
    )
  )
    return factLines(summary);
  const lines: string[] = [];
  for (const group of GROUPS) {
    const items = (summary as Record<string, unknown>)[group];
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, 10)) {
      if (typeof item !== 'string') continue;
      const text = entry(t, item, shownReason);
      if (text) lines.push(`${t(`handover.group.${group}`)} — ${text}`);
    }
  }
  return lines;
}
