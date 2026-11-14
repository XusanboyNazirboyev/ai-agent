import { factLines } from './facts';
import { slotLabel } from './slot-labels';

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
      return `${slotLabel(key, (name) => t(name))}: ${value}`;
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

/**
 * The same summary as headed groups ("Customer said", "Assistant understood",
 * ...) with one line per item, for the details panel: the group name is said
 * once instead of in front of every line.
 */
export function handoverSummaryGroups(
  t: Translate,
  summary: unknown,
  shownReason?: string,
): Array<{ title: string; items: string[] }> {
  if (
    !summary ||
    typeof summary !== 'object' ||
    !GROUPS.some((group) =>
      Array.isArray((summary as Record<string, unknown>)[group]),
    )
  )
    return [];
  const out: Array<{ title: string; items: string[] }> = [];
  for (const group of GROUPS) {
    const items = (summary as Record<string, unknown>)[group];
    if (!Array.isArray(items)) continue;
    const lines = items
      .slice(0, 10)
      .flatMap((item) =>
        typeof item === 'string' ? [entry(t, item, shownReason)] : [],
      )
      .filter((line): line is string => line !== null);
    if (lines.length > 0)
      out.push({ title: t(`handover.group.${group}`), items: lines });
  }
  return out;
}

/**
 * Two lines for the top of the handover card, from the stored summary and
 * without a model: what the customer asked for (the intent) and what they said
 * (their own details). Either is null when the summary has none.
 */
export function handoverHeadline(
  t: Translate,
  summary: unknown,
): { asked: string | null; said: string | null } {
  const items = (group: string): string[] => {
    const list = (summary as Record<string, unknown> | null)?.[group];
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string')
      : [];
  };
  if (!summary || typeof summary !== 'object')
    return { asked: null, said: null };
  const intent = items('inferences')
    .map((item) => /^intent=(.+)$/u.exec(item)?.[1])
    .find((value): value is string => Boolean(value));
  const claims = items('customerClaims')
    .slice(0, 6)
    .map((item) => entry(t, item, undefined))
    .filter((line): line is string => line !== null);
  const text = intent ? known(t, `handover.intent.${intent}`, intent) : null;
  return {
    asked: text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : null,
    said: claims.length > 0 ? claims.join(' · ') : null,
  };
}
