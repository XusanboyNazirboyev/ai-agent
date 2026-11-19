/**
 * Small RFC 4180 reader for the lead import (ADR 077). Pure: no DOM, no I/O.
 * Quoted fields may hold the delimiter, quotes ("") and line breaks.
 */

export type ImportField =
  'name' | 'phone' | 'source' | 'amount' | 'currency' | 'note';

export const IMPORT_FIELDS: readonly ImportField[] = [
  'name',
  'phone',
  'source',
  'amount',
  'currency',
  'note',
];

export interface ParsedCsv {
  delimiter: ',' | ';' | '\t';
  headers: string[];
  /** Data rows; blank lines are dropped. */
  rows: string[][];
  /** The 1-based file line each data row starts on (blank lines counted). */
  lines: number[];
}

const DELIMITERS = [',', ';', '\t'] as const;

/** The delimiter with most occurrences outside quotes in the header line. */
function detectDelimiter(text: string): ParsedCsv['delimiter'] {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  let best: ParsedCsv['delimiter'] = ',';
  for (const d of DELIMITERS) if (counts[d] > counts[best]) best = d;
  return best;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  const starts: number[] = [];
  let line = 1;
  let rowStart = 1;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let touched = false;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    records.push(row);
    starts.push(rowStart);
    row = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        // A line break inside quotes is part of the field, still a file line.
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      touched = true;
    } else if (ch === delimiter) {
      endField();
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      rowStart = line;
    } else {
      field += ch;
      touched = true;
    }
  }
  if (touched || field !== '' || row.length > 0) endRow();

  const blank = (r: string[]): boolean => r.every((c) => c.trim() === '');
  const kept = records.flatMap((r, i) =>
    blank(r) ? [] : [{ cells: r, line: starts[i]! }],
  );
  const [header, ...data] = kept;
  return {
    delimiter,
    headers: (header?.cells ?? []).map((h) => h.trim()),
    rows: data.map((r) => r.cells),
    lines: data.map((r) => r.line),
  };
}

const SYNONYMS: Record<ImportField, string[]> = {
  name: [
    'name',
    'full name',
    'fullname',
    'client',
    'customer',
    'ism',
    'ismi',
    'mijoz',
    'fio',
    'f i o',
    'имя',
    'фио',
    'клиент',
    'ф и о',
  ],
  phone: [
    'phone',
    'phone number',
    'tel',
    'telephone',
    'mobile',
    'telefon',
    'telefon raqam',
    'raqam',
    'номер',
    'телефон',
    'тел',
  ],
  source: ['source', 'manba', 'источник'],
  amount: ['amount', 'sum', 'summa', 'budget', 'byudjet', 'сумма', 'бюджет'],
  currency: ['currency', 'valyuta', 'валюта'],
  note: [
    'note',
    'notes',
    'comment',
    'izoh',
    'comments',
    'комментарий',
    'примечание',
  ],
};

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[._\-/]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * Index of the header that holds each field, -1 when none matches. Each
 * header serves at most one field, the first matching one wins.
 */
export function detectColumns(
  headers: readonly string[],
): Record<ImportField, number> {
  const result: Record<ImportField, number> = {
    name: -1,
    phone: -1,
    source: -1,
    amount: -1,
    currency: -1,
    note: -1,
  };
  headers.forEach((header, index) => {
    const key = normalize(header);
    const compact = key.replace(/ /gu, '');
    for (const field of IMPORT_FIELDS) {
      if (result[field] !== -1) continue;
      if (
        SYNONYMS[field].some(
          (s) => s === key || s.replace(/ /gu, '') === compact,
        )
      ) {
        result[field] = index;
        return;
      }
    }
  });
  return result;
}
