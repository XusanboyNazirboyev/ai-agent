import { describe, expect, it } from 'vitest';
import { decimalAtLeast } from './money.js';

describe('decimalAtLeast', () => {
  it('returns true when amount equals minimum', () => {
    expect(decimalAtLeast('10', '10')).toBe(true);
    expect(decimalAtLeast('10.50', '10.5')).toBe(true);
    expect(decimalAtLeast('0.0', '0')).toBe(true);
  });

  it('returns true when amount is greater (integers and decimals)', () => {
    expect(decimalAtLeast('11', '10')).toBe(true);
    expect(decimalAtLeast('10.01', '10.00')).toBe(true);
    expect(decimalAtLeast('2', '1.999')).toBe(true);
  });

  it('returns false when amount is less', () => {
    expect(decimalAtLeast('9.99', '10')).toBe(false);
    expect(decimalAtLeast('0', '0.001')).toBe(false);
    expect(decimalAtLeast('99.999', '100')).toBe(false);
  });

  it('compares across different fractional lengths without floating point issues', () => {
    expect(decimalAtLeast('1.230', '1.23')).toBe(true);
    expect(decimalAtLeast('1.229999999', '1.23')).toBe(false);
    expect(decimalAtLeast('1000000.0001', '1000000')).toBe(true);
  });
});
