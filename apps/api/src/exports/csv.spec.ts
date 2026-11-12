import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  CSV_EOL,
  csvChunk,
  csvHeader,
  csvRow,
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

describe('csvHeader/csvRow/csvChunk', () => {
  it('builds header and rows with CRLF and BOM on first chunk', () => {
    expect(csvHeader(cols)).toBe('a,b');
    expect(csvRow(cols, { a: 'x', b: 'y' })).toBe('x,y');
    const chunk = csvChunk(cols, [{ a: 'x', b: 'y' }], true);
    expect(chunk.startsWith(CSV_BOM + 'a,b' + CSV_EOL)).toBe(true);
    expect(chunk.endsWith(CSV_EOL)).toBe(true);
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
