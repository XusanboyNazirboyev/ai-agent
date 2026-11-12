'use strict';

/**
 * Currency helpers (ADR 057, P1.3 S2). Money crosses JSON as a decimal
 * string and is never turned into a JS number on the wire: `1500.50` arrives
 * as the string `"1500.50"`. Display formatting is built from the string
 * parts so no precision is lost and `0.10` stays `0.10`.
 */

/** ISO 4217 codes the operator may choose from (fixed list, per ADR 057). */
export const CURRENCIES = [
  'UZS',
  'USD',
  'EUR',
  'RUB',
  'KZT',
  'GBP',
  'TRY',
  'AED',
  'CNY',
] as const;
export type Currency = (typeof CURRENCIES)[number];

const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

export function isValidAmount(value: string): boolean {
  return AMOUNT_RE.test(value.trim());
}

/** `null` when the text is not a valid amount string (the API rejects it too). */
export function parseAmount(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  return AMOUNT_RE.test(value) ? value : null;
}

/** Formats a decimal string for display, preserving the fraction digits. */
export function formatAmount(
  amount: string | null | undefined,
  currency?: string | null,
  locale?: string,
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const [intPart = '0', fracPart = ''] = String(amount).split('.');
  const fractionDigits = Math.max(2, fracPart.length);
  const number = Number(`${intPart}.${fracPart || '0'}`);
  if (!Number.isFinite(number)) return String(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      useGrouping: true,
    }).format(number);
  } catch {
    return String(amount);
  }
}

/** The last currency an operator chose, persisted per browser (try/catch). */
export function rememberLastCurrency(currency: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('ac.lastCurrency', currency);
  } catch {
    // Storage blocked: the choice still applies to this page view.
  }
}

export function readLastCurrency(): Currency | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem('ac.lastCurrency');
    return value && (CURRENCIES as readonly string[]).includes(value)
      ? (value as Currency)
      : null;
  } catch {
    return null;
  }
}
