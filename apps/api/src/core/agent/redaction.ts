/**
 * PII/secret redaction for records and logs (turn records, tool input
 * summaries). Replies to customers are never passed through this: it would
 * corrupt legitimate facts. Patterns are deliberately broad; a redacted
 * harmless number is cheaper than a stored phone or card number.
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, '[email]'],
  // Bearer tokens, API keys and similar long opaque strings.
  [/\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/gu, '[secret]'],
  [/\b[A-Za-z0-9_-]{32,}\b/gu, '[secret]'],
  // Card-like numbers: 13-19 digits with optional spaces or dashes.
  [/\b(?:\d[ -]?){12,18}\d\b/gu, '[number]'],
  // Phone-like numbers: optional +, 7 or more digits with separators.
  [/\+?\d[\d ()-]{6,}\d/gu, '[phone]'],
  // Document-number-like tokens: 1-3 letters followed by 6-9 digits.
  [/\b\p{Lu}{1,3}\d{6,9}\b/gu, '[document]'],
];

export function redactPii(text: string, maxLength = 200): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS)
    result = result.replace(pattern, replacement);
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}

/**
 * Redacts every string leaf of a shallow input object for a summary.
 * Record identifiers (`...Id` keys) are kept, truncated: they are catalog
 * references chosen by code, not customer data.
 */
export function redactedSummary(
  input: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    summary[key] =
      typeof value === 'string'
        ? key.endsWith('Id')
          ? value.slice(0, 120)
          : redactPii(value, 80)
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : '[object]';
  }
  return summary;
}

/**
 * ChatLab research item 1 (owner 2026-11-18: for every tenant). The copy of
 * customer text sent to a language model hides payment card numbers and
 * identity document numbers; the stored message and everything the code
 * and operators see stay unchanged. Phone numbers are kept: the assistant
 * needs them for leads. Patterns are language-neutral and narrow, so a
 * price, a date or a phone is never hidden:
 *  - a card: 16 to 19 digits written together, or four groups of four
 *    digits with one consistent separator (and up to three more digits);
 *    13 to 15 digits written together only when they pass the Luhn check
 *    and do not start with 0 (an international "00…" phone does);
 *  - an Uzbek passport or ID card: two Latin capitals and seven digits;
 *  - a personal identification number (PINFL): 14 digits written together,
 *    starting with 3 to 6.
 */
const MODEL_PATTERNS: ReadonlyArray<
  readonly [RegExp, string | ((match: string) => string)]
> = [
  [/(?<![\d+])\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1?\d{1,3})?(?!\d)/gu, '[card]'],
  [/(?<![\d+])\d{16,19}(?!\d)/gu, '[card]'],
  [/(?<![\d+])[3-6]\d{13}(?!\d)/gu, '[id]'],
  [
    /(?<![\d+])[1-9]\d{12,14}(?!\d)/gu,
    (match: string): string => (luhnValid(match) ? '[card]' : match),
  ],
  [/(?<![\p{L}\d])[A-Z]{2} ?\d{7}(?![\p{L}\d])/gu, '[document]'],
];

export function redactForModel(text: string): string {
  let result = text;
  for (const [pattern, replacement] of MODEL_PATTERNS)
    result =
      typeof replacement === 'string'
        ? result.replace(pattern, replacement)
        : result.replace(pattern, replacement);
  return result;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
