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
