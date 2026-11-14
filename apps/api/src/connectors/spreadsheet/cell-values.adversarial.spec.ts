import { describe, expect, it } from 'vitest';
import {
  parseAmount,
  parseDate,
  parseCurrency,
  parseCount,
  normalizeMeal,
  normalizeRoom,
  parseYesNo,
  addDays,
} from './cell-values';

describe('cell-values adversarial', () => {
  describe('parseAmount valid', () => {
    it.each([
      ['820', '820'],
      ['1 240', '1240'],
      ['1\u00A0240', '1240'],
      ['1,250.50', '1250.50'],
      ['1.250,50', '1250.50'],
      ['710,5', '710.5'],
      ['$ 820', '820'],
      ['820 USD', '820'],
    ])('accepts %s -> %s', (input, expected) => {
      expect(parseAmount(input)).toBe(expected);
    });
  });

  describe('parseAmount invalid', () => {
    it.each([
      '',
      '0',
      '-5',
      'abc',
      '1.2.3',
      '1,2,3',
      '12,34,56',
      '12,34,56',
      '\u221E',
      'NaN',
      '99999999999',
      '1.234,567',
    ])('returns null for %j', (input) => {
      expect(parseAmount(input)).toBeNull();
    });

    it('returns null for "1e5"', () => {
      expect(parseAmount('1e5')).toBeNull();
    });
  });

  describe('parseAmount documented edge cases', () => {
    it("'1,250' reads as thousands -> 1250", () => {
      expect(parseAmount('1,250')).toBe('1250');
    });

    it("'1.250' reads as thousands -> 1250", () => {
      expect(parseAmount('1.250')).toBe('1250');
    });

    it("'0,500' reads as thousands -> 500", () => {
      expect(parseAmount('0,500')).toBe('500');
    });

    it("'12.500,5' reads as 12500.5", () => {
      expect(parseAmount('12.500,5')).toBe('12500.5');
    });
  });

  describe('parseAmount output shape', () => {
    it('every non-null output matches ^\\d+(\\.\\d{1,2})?$', () => {
      const inputs = [
        '820',
        '1 240',
        '1,250.50',
        '1.250,50',
        '710,5',
        '$ 820',
        '820 USD',
        '0.5',
        '100.00',
        '999999999',
        '0.01',
      ];
      for (const input of inputs) {
        const result = parseAmount(input);
        if (result !== null) {
          expect(result).toMatch(/^\d+(\.\d{1,2})?$/u);
        }
      }
    });
  });

  describe('parseDate valid', () => {
    it.each([
      ['2026-03-14', '2026-03-14'],
      ['2028-02-29', '2028-02-29'],
      ['14.03.2026', '2026-03-14'],
      ['14/03/2026', '2026-03-14'],
      ['14-03-2026', '2026-03-14'],
      ['1.1.2000', '2000-01-01'],
      ['31.12.2100', '2100-12-31'],
    ])('accepts %s -> %s', (input, expected) => {
      expect(parseDate(input)).toBe(expected);
    });
  });

  describe('parseDate invalid', () => {
    it.each([
      '2026-02-29',
      '31.04.2026',
      '00.01.2026',
      '2026-13-01',
      '99-99-9999',
      '1999-01-01',
      '2101-01-01',
      '2026-03-14 extra',
      'extra 2026-03-14',
      'not-a-date',
      '',
    ])('returns null for %j', (input) => {
      expect(parseDate(input)).toBeNull();
    });
  });

  describe('addDays', () => {
    it('adds days within a month', () => {
      expect(addDays('2026-03-10', 5)).toBe('2026-03-15');
    });

    it('crosses a month boundary', () => {
      expect(addDays('2026-01-28', 5)).toBe('2026-02-02');
    });

    it('crosses a year boundary', () => {
      expect(addDays('2026-12-28', 8)).toBe('2027-01-05');
    });

    it('crosses a leap-year boundary', () => {
      expect(addDays('2028-02-25', 5)).toBe('2028-03-01');
    });

    it('handles a full leap day', () => {
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    });
  });

  describe('parseCurrency', () => {
    it.each([
      ['USD', 'USD'],
      ['usd', 'USD'],
      ['Eur', 'EUR'],
      ['$', 'USD'],
      ['€', 'EUR'],
      ['£', 'GBP'],
      ['₽', 'RUB'],
      ['₺', 'TRY'],
      ['som', 'UZS'],
      ["so'm", 'UZS'],
    ])('accepts %s -> %s', (input, expected) => {
      expect(parseCurrency(input)).toBe(expected);
    });

    it('parseCurrency("сум") -> UZS', () => {
      expect(parseCurrency('сум')).toBe('UZS');
    });

    it('parseCurrency("сўм") -> UZS', () => {
      expect(parseCurrency('сўм')).toBe('UZS');
    });

    it.each(['XXX', 'abc', '', ' ', '123', 'USDD'])(
      'returns null for %j',
      (input) => {
        expect(parseCurrency(input)).toBeNull();
      },
    );
  });

  describe('parseCount', () => {
    it.each([
      ['0', 0],
      ['6', 6],
      [' 6 ', 6],
    ])('accepts %s -> %d', (input, expected) => {
      expect(parseCount(input)).toBe(expected);
    });

    it.each(['-1', '1.5', '6 seats', '1234567', '', 'abc'])(
      'returns null for %j',
      (input) => {
        expect(parseCount(input)).toBeNull();
      },
    );
  });

  describe('normalizeMeal', () => {
    it.each([
      ['BB', 'BB'],
      ['bb', 'BB'],
      ['breakfast', 'BB'],
      ['завтрак', 'BB'],
      ['nonushta', 'BB'],
      ['HB', 'HB'],
      ['halfboard', 'HB'],
      ['полупансион', 'HB'],
      ['yarimpansion', 'HB'],
      ['FB', 'FB'],
      ['fullboard', 'FB'],
      ['полныйпансион', 'FB'],
      ['toliqpansion', 'FB'],
      ['tolapansion', 'FB'],
      ['AI', 'AI'],
      ['allinclusive', 'AI'],
      ['всёвключено', 'AI'],
      ['всевключено', 'AI'],
      ['hammasikiritilgan', 'AI'],
      ['hammasidavlat', 'AI'],
      ['UAI', 'UAI'],
      ['uai', 'UAI'],
      ['ультравсёвключено', 'UAI'],
      ['ультравсевключено', 'UAI'],
      ['RO', 'RO'],
      ['roomonly', 'RO'],
      ['безпитания', 'RO'],
      ['ovqatsiz', 'RO'],
    ])('maps %s -> %s', (input, expected) => {
      expect(normalizeMeal(input)).toBe(expected);
    });

    it('returns unknown text trimmed and unchanged', () => {
      expect(normalizeMeal('  something weird  ')).toBe('something weird');
      expect(normalizeMeal('unknown meal plan')).toBe('unknown meal plan');
    });
  });

  describe('normalizeRoom', () => {
    it.each([
      ['SGL', 'SGL'],
      ['sgl', 'SGL'],
      ['single', 'SGL'],
      ['одноместный', 'SGL'],
      ['бирокикарли', 'SGL'],
      ['singleroom', 'SGL'],
      ['DBL', 'DBL'],
      ['dbl', 'DBL'],
      ['double', 'DBL'],
      ['twin', 'DBL'],
      ['двухместный', 'DBL'],
      ['ikkikishilik', 'DBL'],
      ['doubleroom', 'DBL'],
      ['TRPL', 'TRPL'],
      ['trpl', 'TRPL'],
      ['trp', 'TRPL'],
      ['triple', 'TRPL'],
      ['трехместный', 'TRPL'],
      ['трёхместный', 'TRPL'],
      ['uchkishilik', 'TRPL'],
    ])('maps %s -> %s', (input, expected) => {
      expect(normalizeRoom(input)).toBe(expected);
    });

    it('returns unknown text trimmed and unchanged', () => {
      expect(normalizeRoom('  something weird  ')).toBe('something weird');
      expect(normalizeRoom('unknown room type')).toBe('unknown room type');
    });
  });

  describe('parseYesNo', () => {
    it.each([
      ['yes', true],
      ['y', true],
      ['true', true],
      ['1', true],
      ['да', true],
      ['ha', true],
      ['bor', true],
      ['+', true],
      ['no', false],
      ['n', false],
      ['false', false],
      ['0', false],
      ['нет', false],
      ['yoq', false],
      ["yo'q", false],
    ])('accepts %s -> %s', (input, expected) => {
      expect(parseYesNo(input)).toBe(expected);
    });

    it.each(['', 'maybe', 'unknown', '2', 'yes please', '-'])(
      'returns null for %j',
      (input) => {
        expect(parseYesNo(input)).toBeNull();
      },
    );
  });

  describe('property-style loops', () => {
    function lcg(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0xffffffff;
      };
    }

    const amountChars = '0123456789., $€£';

    it('parseAmount never throws on 2000 random strings; output is null or valid', () => {
      const next = lcg(424242);
      for (let i = 0; i < 2_000; i += 1) {
        let s = '';
        const len = 1 + Math.floor(next() * 12);
        for (let j = 0; j < len; j += 1) {
          s += amountChars[Math.floor(next() * amountChars.length)];
        }
        let result: string | null;
        try {
          result = parseAmount(s);
        } catch {
          throw new Error(`parseAmount threw on input ${JSON.stringify(s)}`);
        }
        if (result !== null) {
          expect(result).toMatch(/^\d+(\.\d{1,2})?$/u);
        }
      }
    });

    const dateChars = '0123456789.-/';

    it('parseDate never throws on 2000 random strings; output is null or a real date', () => {
      const next = lcg(987654);
      for (let i = 0; i < 2_000; i += 1) {
        let s = '';
        const len = 1 + Math.floor(next() * 14);
        for (let j = 0; j < len; j += 1) {
          s += dateChars[Math.floor(next() * dateChars.length)];
        }
        let result: string | null;
        try {
          result = parseDate(s);
        } catch {
          throw new Error(`parseDate threw on input ${JSON.stringify(s)}`);
        }
        if (result !== null) {
          expect(/^\d{4}-\d{2}-\d{2}$/u.test(result)).toBe(true);
          const [y, m, d] = result.split('-').map(Number);
          const probe = new Date(Date.UTC(y, m - 1, d));
          expect(probe.getUTCFullYear()).toBe(y);
          expect(probe.getUTCMonth()).toBe(m - 1);
          expect(probe.getUTCDate()).toBe(d);
        }
      }
    });
  });
});
