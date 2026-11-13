import { describe, expect, it } from 'vitest';
import { formatAmount, isValidAmount, parseAmount } from './currencies';

describe('currency helpers', () => {
  it('formats 0.10 without float errors', () => {
    expect(formatAmount('0.10', 'USD')).toContain('0.10');
  });
  it('formats 1234567.89 with grouping', () => {
    const out = formatAmount('1234567.89', 'UZS');
    expect(out).toContain('1,234,567.89');
    expect(out).toContain('UZS');
  });
  it('formats large values', () => {
    const out = formatAmount('999999999999.99', 'USD');
    expect(out).toContain('999,999,999,999.99');
  });
  it('returns dash for null amount', () => {
    expect(formatAmount(null, 'USD')).toBe('—');
  });
  it('validates amount strings', () => {
    expect(isValidAmount('1500.50')).toBe(true);
    expect(isValidAmount('0.10')).toBe(true);
    expect(isValidAmount('123456789012')).toBe(true);
    expect(isValidAmount('1234567890123')).toBe(false);
    expect(isValidAmount('1.234')).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount('-1')).toBe(false);
  });
  it('parseAmount returns null for invalid', () => {
    expect(parseAmount('1500.50')).toBe('1500.50');
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('bad')).toBeNull();
  });
});
