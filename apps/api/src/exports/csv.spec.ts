import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  CSV_EOL,
  csvChunk,
  csvHeader,
  csvRow,
  customFieldColumns,
  exportFilename,
  formatCell,
  neutraliseCell,
  type CsvColumn,
} from './csv.js';

type Row = { a: string | null; b: string | number | boolean | null };

const cols: CsvColumn<Row>[] = [
  { header: 'a', kind: 'text', get: (r) => r.a },
  { header: 'b', kind: 'text', get: (r) => r.b },
];

describe('neutraliseCell', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-cmd', "'-cmd"],
    ['@evil', "'@evil"],
    ['\tfoo', "'\tfoo"],
    ['\rfoo', "'\rfoo"],
  ])('prefixes dangerous %j', (input, out) => {
    expect(neutraliseCell(input)).toBe(out);
  });

  it('keeps safe strings and empty', () => {
    expect(neutraliseCell('hello')).toBe('hello');
    expect(neutraliseCell('')).toBe('');
  });

  it('neutralises a value that is only =', () => {
    expect(neutraliseCell('=')).toBe("'=");
  });

  it('does not alter a value whose first char is a plain apostrophe', () => {
    expect(neutraliseCell("'already")).toBe("'already");
  });
});

describe('formatCell', () => {
  it('quotes commas, quotes, CR/LF (RFC 4180) and doubles quotes', () => {
    expect(formatCell('a,b', 'text')).toBe('"a,b"');
    expect(formatCell('a"b', 'text')).toBe('"a""b"');
    expect(formatCell('a\nb', 'text')).toBe('"a\nb"');
    expect(formatCell('a\r\nb', 'text')).toBe('"a\r\nb"');
  });

  it('neutralises dangerous first chars in text fields', () => {
    expect(formatCell('=1+1', 'text')).toBe(`'=1+1`);
    expect(formatCell('+cmd', 'text')).toBe(`'+cmd`);
    expect(formatCell('-cmd', 'text')).toBe(`'-cmd`);
    expect(formatCell('@sum', 'text')).toBe(`'@sum`);
    expect(formatCell('\tcmd', 'text')).toBe("'\tcmd");
    expect(formatCell('\rcmd', 'text')).toBe('"\'\rcmd"');
  });

  it('handles empty and null', () => {
    expect(formatCell(null, 'text')).toBe('');
    expect(formatCell(undefined, 'text')).toBe('');
    expect(formatCell('', 'text')).toBe('');
  });

  it('formats booleans, dates, ids, numbers by type', () => {
    expect(formatCell(true, 'boolean')).toBe('true');
    expect(formatCell(false, 'boolean')).toBe('false');
    expect(formatCell(new Date('2026-11-12T10:00:00.000Z'), 'date')).toBe(
      '2026-11-12T10:00:00.000Z',
    );
    expect(formatCell('2026-11-12T10:00:00.000Z', 'date')).toBe(
      '2026-11-12T10:00:00.000Z',
    );
    expect(formatCell('abc-123', 'id')).toBe('abc-123');
    expect(formatCell(42, 'number')).toBe('42');
    expect(formatCell(-5, 'number')).toBe('-5');
  });

  it('keeps unicode text', () => {
    expect(formatCell('Ўзбекча, Кирилл', 'text')).toBe('"Ўзбекча, Кирилл"');
    expect(formatCell('Привет', 'text')).toBe('Привет');
  });

  it('handles value that starts with apostrophe and dangerous char after', () => {
    expect(formatCell("'=SUM(A1)", 'text')).toBe(`'=SUM(A1)`);
  });
});

describe('typed columns and edge cases', () => {
  it('writes a legitimate negative number unprefixed in a number column', () => {
    expect(formatCell(-5, 'number')).toBe('-5');
    expect(formatCell(-0.25, 'number')).toBe('-0.25');
    // The same text in a text column is neutralised: no sniffing.
    expect(formatCell('-5', 'text')).toBe("'-5");
  });

  it('writes nothing for a non-finite or non-number in a number column', () => {
    expect(formatCell(Number.NaN, 'number')).toBe('');
    expect(formatCell(Infinity, 'number')).toBe('');
    expect(formatCell('=1+1', 'number')).toBe('');
  });

  it('never prefixes booleans, dates or ids', () => {
    expect(formatCell(true, 'boolean')).toBe('true');
    expect(formatCell('2026-01-02T03:04:05Z', 'date')).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    expect(formatCell('abc', 'id')).toBe('abc');
  });

  it('neutralises and quotes an unparseable date string', () => {
    expect(formatCell('=evil,x', 'date')).toBe(`"'=evil,x"`);
    expect(formatCell('', 'date')).toBe('');
  });

  it('prefixes first, then quotes: a formula with comma and quote', () => {
    expect(formatCell('=A1,"x"', 'text')).toBe(`"'=A1,""x"""`);
  });

  it('does not touch dangerous characters that are not first', () => {
    expect(formatCell('a=b', 'text')).toBe('a=b');
    expect(formatCell('x-y+z@q', 'text')).toBe('x-y+z@q');
  });

  it('neutralises a lone tab and a lone carriage return', () => {
    expect(formatCell('\t', 'text')).toBe("'\t");
    expect(formatCell('\r', 'text')).toBe(`"'\r"`);
  });

  it('quotes a field that has only a comma, a quote or a newline', () => {
    expect(formatCell(',', 'text')).toBe('","');
    expect(formatCell('"', 'text')).toBe('""""');
    expect(formatCell('\n', 'text')).toBe('"\n"');
  });

  it('keeps unicode and emoji intact', () => {
    expect(formatCell('Тошкент 🚀 oʻzbek', 'text')).toBe('Тошкент 🚀 oʻzbek');
  });

  it('neutralises header labels too (custom field labels are user text)', () => {
    expect(csvHeader([{ header: '=evil', kind: 'text', get: (): string => '' }])).toBe(
      "'=evil",
    );
  });

  it('does not strip an existing apostrophe or add one twice', () => {
    expect(formatCell("'x", 'text')).toBe("'x");
    expect(formatCell("''=x", 'text')).toBe("''=x");
  });
});

describe('csvHeader/csvRow/csvChunk', () => {
  it('builds header and rows with CRLF and BOM on first chunk', () => {
    expect(csvHeader(cols)).toBe('a,b');
    expect(csvRow(cols, { a: 'x', b: 'y' })).toBe('x,y');
    const chunk = csvChunk(cols, [{ a: 'x', b: 'y' }], true);
    expect(chunk.startsWith(CSV_BOM + 'a,b' + CSV_EOL)).toBe(true);
    expect(chunk.endsWith(CSV_EOL)).toBe(true);
  });

  it('writes only the BOM and header for an empty first chunk', () => {
    expect(csvChunk(cols, [], true)).toBe(`${CSV_BOM}a,b${CSV_EOL}`);
    expect(csvChunk(cols, [], false)).toBe('');
  });

  it('puts CRLF between rows and never a bare LF between them', () => {
    const rows = [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ];
    expect(csvChunk(cols, rows, false)).toBe(`1,2${CSV_EOL}3,4${CSV_EOL}`);
  });

  it('omits BOM/header on subsequent chunks', () => {
    const chunk = csvChunk(cols, [{ a: '1', b: '2' }], false);
    expect(chunk.startsWith(CSV_BOM)).toBe(false);
    expect(chunk.startsWith('a,b')).toBe(false);
    expect(chunk).toBe(`1,2${CSV_EOL}`);
  });
});

describe('exportFilename', () => {
  it('formats UTC date', () => {
    expect(exportFilename('people', new Date('2026-11-12T23:59:59Z'))).toBe(
      'people-20261112.csv',
    );
    expect(exportFilename('leads', new Date('2026-01-02T00:00:00Z'))).toBe(
      'leads-20260102.csv',
    );
  });
});

describe('customFieldColumns', () => {
  const defs = [
    { key: 'age', label: 'Age', type: 'NUMBER', options: null, position: 0 },
    { key: 'vip', label: '=VIP', type: 'BOOLEAN', options: null, position: 1 },
    { key: 'note', label: 'Note', type: 'TEXT', options: null, position: 2 },
  ] as const;
  const cols = customFieldColumns<{ customFields: Record<string, unknown> }>(
    defs,
  );

  it('keeps the definition order and labels as headers (neutralised)', () => {
    expect(csvHeader(cols)).toBe("Age,'=VIP,Note");
  });

  it('writes numbers typed, booleans true/false and text neutralised', () => {
    const row = { customFields: { age: -3, vip: false, note: '=cmd' } };
    expect(csvRow(cols, row)).toBe("-3,false,'=cmd");
  });

  it('writes empty cells for missing values', () => {
    expect(csvRow(cols, { customFields: {} })).toBe(',,');
  });
});
