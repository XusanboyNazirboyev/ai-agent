import { describe, expect, it } from 'vitest';
import {
  monthKeyOf,
  monthKeys,
  minorToDecimal,
  monthlyEquivalentMinor,
} from './overview-math.js';

describe('overview math', () => {
  it('uses the Tashkent calendar month, not UTC', () => {
    // 19:30 UTC on 31 Oct is already 1 Nov in Tashkent (UTC+5).
    expect(monthKeyOf(new Date('2026-10-31T19:30:00Z'))).toBe('2026-11');
    expect(monthKeyOf(new Date('2026-10-31T18:30:00Z'))).toBe('2026-10');
  });

  it('lists months oldest first across a year boundary', () => {
    expect(monthKeys(new Date('2026-02-10T00:00:00Z'), 4)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthKeys(new Date('2026-02-10T00:00:00Z'), 1)).toEqual(['2026-02']);
  });

  it('renders minor units as decimal strings', () => {
    expect(minorToDecimal(15000050n, 'UZS')).toBe('150000.50');
    expect(minorToDecimal(5n, 'USD')).toBe('0.05');
    expect(minorToDecimal(0n, 'USD')).toBe('0.00');
    expect(minorToDecimal(500n, 'JPY')).toBe('500');
  });

  it('normalises a price to 30 days with rounding', () => {
    expect(monthlyEquivalentMinor(10000n, 30)).toBe(10000n);
    expect(monthlyEquivalentMinor(120000n, 365)).toBe(9863n);
    expect(monthlyEquivalentMinor(100n, 0)).toBe(0n);
  });
});
