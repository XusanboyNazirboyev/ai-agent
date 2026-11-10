import { describe, expect, it } from 'vitest';
import { formatMoney, minorDigits, parseMoneyInput } from './money';

const nbsp = (text: string): string => text.replace(/[\u00a0\u202f]/gu, ' ');

describe('money display (integers in minor units from the API)', () => {
  it('knows the minor digits of a currency', () => {
    expect(minorDigits('UZS')).toBe(2);
    expect(minorDigits('USD')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
  });

  it('formats minor units with the currency, decimals only when present', () => {
    expect(nbsp(formatMoney(15_000_000, 'UZS', 'ru'))).toBe('150 000 UZS');
    expect(nbsp(formatMoney(9_950, 'USD', 'en'))).toBe('$99.50');
    expect(nbsp(formatMoney(10_000, 'USD', 'en'))).toBe('$100');
    expect(nbsp(formatMoney(1_500, 'JPY', 'en'))).toBe('¥1,500');
  });

  it('formats in Uzbek with the local currency name', () => {
    expect(nbsp(formatMoney(15_000_000, 'UZS', 'uz-Latn'))).toContain(
      '150 000',
    );
  });
});

describe('parsing a typed amount (no floating point)', () => {
  it('accepts group spaces and one decimal separator', () => {
    expect(parseMoneyInput('150 000', 'UZS')).toBe(15_000_000);
    expect(parseMoneyInput('150\u00a0000,5', 'UZS')).toBe(15_000_050);
    expect(parseMoneyInput('99.99', 'USD')).toBe(9_999);
    expect(parseMoneyInput('0.29', 'USD')).toBe(29);
    expect(parseMoneyInput('1500', 'JPY')).toBe(1_500);
  });

  it('refuses ambiguous or invalid input', () => {
    expect(parseMoneyInput('', 'UZS')).toBeUndefined();
    expect(parseMoneyInput('150,000', 'UZS')).toBeUndefined();
    expect(parseMoneyInput('1.5', 'JPY')).toBeUndefined();
    expect(parseMoneyInput('-5', 'UZS')).toBeUndefined();
    expect(parseMoneyInput('1e5', 'UZS')).toBeUndefined();
    expect(parseMoneyInput('9'.repeat(20), 'UZS')).toBeUndefined();
  });
});
