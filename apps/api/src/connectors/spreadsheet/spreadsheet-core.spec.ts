import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  normalizeMeal,
  normalizeRoom,
  parseAmount,
  parseCount,
  parseCurrency,
  parseDate,
  parseYesNo,
} from './cell-values.js';
import { detectDelimiter, parseSheet, SheetReadError } from './csv-reader.js';
import { missingRequiredFields, suggestMapping } from './field-suggest.js';
import { mapSheet } from './row-mapper.js';

const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../../docs/samples/tourism-price-list.sample.csv',
  ),
  'utf8',
);

describe('csv reader', () => {
  it('reads quotes, doubled quotes, line breaks inside quotes and CRLF', () => {
    const sheet = parseSheet(
      'a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n',
    );
    expect(sheet.header).toEqual(['a', 'b']);
    expect(sheet.rows.map((r) => r.cells)).toEqual([
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
    // Line numbers count file lines: the third record starts on line 3.
    expect(sheet.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it('strips a BOM, skips blank lines and detects the delimiter', () => {
    const withBom = parseSheet('\ufeffa;b\n1;2\n\n3;4\n');
    expect(withBom.header).toEqual(['a', 'b']);
    expect(withBom.rows).toHaveLength(2);
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('"a,b";c;d')).toBe(';');
  });

  it('keeps formula text as plain text', () => {
    const sheet = parseSheet(
      'a\n"=HYPERLINK(""http://x"",""y"")"\n+1+1\n@SUM(A1)',
    );
    expect(sheet.rows.map((r) => r.cells[0])).toEqual([
      '=HYPERLINK("http://x","y")',
      '+1+1',
      '@SUM(A1)',
    ]);
  });

  it('refuses an empty file, an unclosed quote and oversized input', () => {
    expect(() => parseSheet('')).toThrowError(SheetReadError);
    expect(() => parseSheet('\n\n')).toThrowError(/header/u);
    try {
      parseSheet('a,b\n"open,1\n');
      expect.unreachable();
    } catch (error) {
      expect((error as SheetReadError).code).toBe('SHEET_UNTERMINATED_QUOTE');
      expect((error as SheetReadError).line).toBe(2);
    }
    expect(() => parseSheet(`a\n${'x'.repeat(2_001)}`)).toThrowError(
      /longer than/u,
    );
    expect(() =>
      parseSheet(Array.from({ length: 61 }, (_, i) => `c${i}`).join(',')),
    ).toThrowError(/columns/u);
  });
});

describe('cell values', () => {
  it('reads amounts and never guesses', () => {
    expect(parseAmount('820')).toBe('820');
    expect(parseAmount('1 240')).toBe('1240');
    expect(parseAmount('1 240')).toBe('1240');
    expect(parseAmount('1,250.50')).toBe('1250.50');
    expect(parseAmount('1.250,50')).toBe('1250.50');
    expect(parseAmount('710,5')).toBe('710.5');
    expect(parseAmount('$ 820')).toBe('820');
    expect(parseAmount('1,250')).toBe('1250');
    for (const bad of [
      '',
      '0',
      '-5',
      'abc',
      '1.2.3',
      '1e5',
      '99999999999',
      '1.234,567',
    ])
      expect(parseAmount(bad), bad).toBeNull();
  });

  it('reads dates day first and refuses impossible ones', () => {
    expect(parseDate('2026-03-14')).toBe('2026-03-14');
    expect(parseDate('14.03.2026')).toBe('2026-03-14');
    expect(parseDate('14/03/2026')).toBe('2026-03-14');
    expect(parseDate('2028-02-29')).toBe('2028-02-29');
    for (const bad of [
      '2026-02-29',
      '31.02.2026',
      '00.01.2026',
      '2026-13-01',
      '14.03.26',
      '1999-01-01',
      'soon',
    ])
      expect(parseDate(bad), bad).toBeNull();
    expect(addDays('2026-03-14', 5)).toBe('2026-03-19');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('reads currencies, counts, meal and room codes, yes and no', () => {
    expect(parseCurrency('usd')).toBe('USD');
    expect(parseCurrency('$')).toBe('USD');
    expect(parseCurrency('сум')).toBe('UZS');
    expect(parseCurrency('XXX')).toBeNull();
    expect(parseCount(' 6 ')).toBe(6);
    expect(parseCount('1.5')).toBeNull();
    expect(parseCount('6 seats')).toBeNull();
    expect(normalizeMeal('Все включено')).toBe('AI');
    expect(normalizeMeal('yarim pansion')).toBe('HB');
    expect(normalizeMeal('завтраки')).toBe('BB');
    expect(normalizeMeal('Gourmet')).toBe('Gourmet');
    expect(normalizeRoom('Двухместный')).toBe('DBL');
    expect(normalizeRoom('single')).toBe('SGL');
    expect(parseYesNo('Да')).toBe(true);
    expect(parseYesNo('yoʼq')).toBe(false);
    expect(parseYesNo('maybe')).toBeNull();
  });
});

describe('column suggestion', () => {
  it('maps the sample header', () => {
    const { header } = parseSheet(SAMPLE);
    const mapping = suggestMapping(header);
    expect(mapping).toEqual({
      code: 0,
      destination: 1,
      hotel: 2,
      stars: 3,
      nights: 4,
      meal: 5,
      room: 6,
      departureDate: 7,
      departureCity: 8,
      price: 9,
      currency: 10,
      seats: 11,
      flight: 12,
      notes: 13,
    });
    expect(missingRequiredFields(mapping)).toEqual([]);
  });

  it('maps Russian and Uzbek headers and reports what is missing', () => {
    const ru = suggestMapping([
      'Направление',
      'Отель',
      'Ночей',
      'Питание',
      'Дата вылета',
      'Цена за человека',
      'Валюта',
      'Осталось мест',
    ]);
    expect(ru).toMatchObject({
      destination: 0,
      hotel: 1,
      nights: 2,
      meal: 3,
      departureDate: 4,
      price: 5,
      currency: 6,
      seats: 7,
    });
    const uz = suggestMapping([
      'Yoʼnalish',
      'Mehmonxona',
      'Tun',
      'Ovqat',
      'Jonash sanasi',
      'Narxi',
      'Valyuta',
    ]);
    expect(uz).toMatchObject({
      destination: 0,
      hotel: 1,
      nights: 2,
      meal: 3,
      departureDate: 4,
      price: 5,
      currency: 6,
    });
    expect(missingRequiredFields(suggestMapping(['Hotel', 'Nights']))).toEqual([
      'price',
    ]);
    expect(missingRequiredFields(suggestMapping(['Price', 'Date']))).toEqual([
      'title',
    ]);
  });

  it('uses each column once and does not read "Hotel code" as a code', () => {
    const mapping = suggestMapping(['Hotel code', 'Price']);
    expect(mapping.hotel).toBe(0);
    expect(mapping.code).toBeUndefined();
    expect(mapping.price).toBe(1);
  });
});

describe('row mapping of the sample price list', () => {
  const sheet = parseSheet(SAMPLE);
  const result = mapSheet(sheet, suggestMapping(sheet.header));

  it('accepts the good rows and rejects the three bad ones with their lines', () => {
    expect(result.rowCount).toBe(15);
    expect(result.offers).toHaveLength(12);
    expect(result.errors.map((e) => [e.line, e.code])).toEqual([
      [14, 'PRICE_INVALID'],
      [15, 'DATE_INVALID'],
      [16, 'CURRENCY_UNKNOWN'],
    ]);
  });

  it('groups departures under one item per package', () => {
    expect(result.items).toHaveLength(7);
    const rixos = result.items.find(
      (i) => i.attributes.hotel === 'Rixos Premium Palm',
    )!;
    expect(rixos.title).toBe('Dubai · Rixos Premium Palm 5★ · 5 nights · BB');
    expect(rixos.attributes).toMatchObject({
      destination: 'Dubai',
      stars: 5,
      nights: 5,
      meal: 'BB',
    });
    expect(result.offers.filter((o) => o.itemKey === rixos.key)).toHaveLength(
      4,
    );
  });

  it('reads prices, dates and seats exactly', () => {
    const byKey = new Map(result.offers.map((o) => [o.key, o]));
    const a = byKey.get('DXB-RIX-5-0314')!;
    expect(a.price).toEqual({ amount: '820', currency: 'USD' });
    expect(a.startsOn).toBe('2026-03-14');
    expect(a.endsOn).toBe('2026-03-19');
    expect(a.availability).toBe('AVAILABLE');
    expect(a.attributes).toMatchObject({
      room: 'DBL',
      departureCity: 'Tashkent',
      flightIncluded: true,
    });
    expect(byKey.get('DXB-RIX-5-0321')!.availability).toBe('LIMITED');
    expect(byKey.get('DXB-RIX-5-0328')!.availability).toBe('SOLD_OUT');
    expect(byKey.get('DXB-RIX-5-0328')!.startsOn).toBe('2026-03-28');
    expect(byKey.get('DXB-RIX-5-0314-S')!.attributes.room).toBe('SGL');
    expect(byKey.get('DXB-ATL-4-0314')!.price.amount).toBe('1240');
    expect(byKey.get('SSH-NOV-5-0405')!.price.amount).toBe('710.50');
    expect(byKey.get('SSH-NOV-5-0412')!.startsOn).toBe('2026-04-12');
    expect(byKey.get('ALA-MTN-3-0701')!.attributes.flightIncluded).toBe(false);
  });
});

describe('row mapping rules', () => {
  const sheet = (text: string): ReturnType<typeof parseSheet> =>
    parseSheet(text);

  it('asks for the missing mapping instead of importing', () => {
    const s = sheet('Hotel,Nights\nA,3');
    const r = mapSheet(s, suggestMapping(s.header));
    expect(r.offers).toHaveLength(0);
    expect(r.errors[0]).toMatchObject({ code: 'MAPPING_INCOMPLETE' });
  });

  it('uses the default currency only when the row has none', () => {
    const s = sheet('Hotel,Price,Currency\nA,100,\nB,200,EUR\nC,300,ZZZ');
    const m = suggestMapping(s.header);
    const without = mapSheet(s, m);
    expect(without.errors.map((e) => e.code)).toEqual([
      'CURRENCY_UNKNOWN',
      'CURRENCY_UNKNOWN',
    ]);
    const withDefault = mapSheet(s, m, { defaultCurrency: 'UZS' });
    expect(withDefault.offers.map((o) => o.price.currency)).toEqual([
      'UZS',
      'EUR',
    ]);
    // A wrong written currency is never replaced by the default.
    expect(withDefault.errors).toHaveLength(1);
  });

  it('reads a currency written inside the price cell', () => {
    const s = sheet('Hotel,Price\nA,$ 500\nB,300 EUR');
    expect(
      mapSheet(s, suggestMapping(s.header)).offers.map((o) => o.price),
    ).toEqual([
      { amount: '500', currency: 'USD' },
      { amount: '300', currency: 'EUR' },
    ]);
  });

  it('rejects a repeated key and keeps the first row', () => {
    const s = sheet('Code,Hotel,Price,Currency\nX1,A,100,USD\nX1,B,120,USD');
    const r = mapSheet(s, suggestMapping(s.header));
    expect(r.offers).toHaveLength(1);
    expect(r.errors).toMatchObject([{ line: 3, code: 'DUPLICATE_KEY' }]);
  });

  it('uses a stable key when there is no code, so a re-upload updates the same offer', () => {
    const text = 'Hotel,Nights,Price,Currency,Date\nA,3,100,USD,2026-05-01';
    const a = mapSheet(sheet(text), suggestMapping(sheet(text).header));
    const b = mapSheet(
      sheet(text.replace('100', '110')),
      suggestMapping(sheet(text).header),
    );
    expect(a.offers[0]!.key).toBe(b.offers[0]!.key);
    expect(a.offers[0]!.key).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('marks availability unknown without seats and follows the option', () => {
    const s = sheet('Hotel,Price,Currency\nA,100,USD');
    const m = suggestMapping(s.header);
    expect(mapSheet(s, m).offers[0]!.availability).toBe('UNKNOWN');
    expect(
      mapSheet(s, m, { defaultAvailability: 'AVAILABLE' }).offers[0]!
        .availability,
    ).toBe('AVAILABLE');
  });

  it('rejects unreadable nights, stars and seats with the field named', () => {
    const s = sheet(
      'Hotel,Nights,Stars,Seats,Price,Currency\nA,x,9,many,100,USD',
    );
    const r = mapSheet(s, suggestMapping(s.header));
    expect(r.errors.map((e) => e.field).sort()).toEqual([
      'nights',
      'seats',
      'stars',
    ]);
    expect(r.offers).toHaveLength(0);
  });
});
