/**
 * Money from the API is an integer in minor units with an ISO currency
 * (ADR 047 §2). The browser only displays it and parses what the owner types;
 * it never computes a price.
 */

function intlLocale(locale: string): string {
  return locale === 'uz-Latn' ? 'uz-Latn' : locale;
}

/** Minor-unit digits of a currency (UZS and USD: 2, JPY: 0). */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** "150 000 soʻm" for 15000000 UZS; decimals only when there are any. */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: string,
): string {
  const digits = minorDigits(currency);
  const scale = 10 ** digits;
  const whole = amountMinor % scale === 0;
  try {
    return new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(amountMinor / scale);
  } catch {
    return `${amountMinor / scale} ${currency}`;
  }
}

/**
 * Parses an amount typed in major units ("150 000", "99.5", "99,50") into
 * integer minor units without floating-point arithmetic. Spaces are digit
 * group separators; one "." or "," separates the decimals. Anything else,
 * or more decimals than the currency has, is refused (undefined).
 */
export function parseMoneyInput(
  text: string,
  currency: string,
): number | undefined {
  const digits = minorDigits(currency);
  const compact = text.replace(/[\s\u00a0\u202f']/gu, '');
  const match = /^(\d+)(?:[.,](\d+))?$/u.exec(compact);
  if (!match) return undefined;
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return undefined;
  const minor = Number(`${match[1]}${fraction.padEnd(digits, '0')}`);
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/** LLM cost as the API reports it: US dollars (not minor units), display only. */
export function formatUsd(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value} USD`;
  }
}

/** Formats a date (no time) for period ends and payment dates. */
export function formatDate(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      dateStyle: 'medium',
    }).format(new Date(value));
  } catch {
    return value.slice(0, 10);
  }
}
