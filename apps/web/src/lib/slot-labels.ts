import en from '@/i18n/en.json';
import { factLines } from './facts';

/**
 * The details the assistant collected, as "Label: value" pairs. The keys come
 * from the industry pack (`destination`, `travelMonth` ...); a known one gets
 * a translated label, an unknown one is spelled out from its camelCase name
 * so no raw key is ever shown.
 */
export function slotPairs(
  slots: unknown,
  label: (key: string) => string,
): Array<{ label: string; value: string }> {
  return factLines(slots).flatMap((line) => {
    const cut = line.indexOf(': ');
    if (cut < 0) return [];
    const key = line.slice(0, cut);
    const catalogKey = `slot.${key}`;
    return [
      {
        label: catalogKey in en ? label(catalogKey) : humanize(key),
        value: line.slice(cut + 2),
      },
    ];
  });
}

/** "travelMonth" -> "Travel month". */
export function humanize(key: string): string {
  const words = key
    .replace(/[_-]+/gu, ' ')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}
