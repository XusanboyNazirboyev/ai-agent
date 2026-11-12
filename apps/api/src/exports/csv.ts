/**
 * Pure CSV building and formatting (ADR 056, P1.9). No I/O, no database.
 *
 * Rules: UTF-8 BOM, \r\n, RFC 4180 quoting, and formula-injection defence
 * (OWASP CSV Injection, https://owasp.org/www-community/attacks/CSV_Injection,
 * read 2026-11-12): any cell whose first character is = + - @ tab or CR is
 * prefixed with a single quote. Defence applies to user-controlled text;
 * numbers/booleans/dates formatted by code use typed formatters (a legitimate
 * negative number is only produced by the numeric formatter).
 */

export const CSV_BOM = '\ufeff';
export const CSV_EOL = '\r\n';
export const CSV_PAGE_SIZE = 500;
export const EXPORT_ROW_LIMIT = 50_000;
export const EXPORT_LOCK_TTL_MS = 10 * 60 * 1000;

const DANGEROUS_FIRST = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Neutralise a user-controlled string value for CSV cells. */
export function neutraliseCell(value: string): string {
  if (value.length === 0) return value;
  return DANGEROUS_FIRST.has(value[0]!) ? `'${value}` : value;
}

function quoteIfNeeded(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Formats one cell. `kind` controls injection handling. */
export function formatCell(
  value: unknown,
  kind: 'text' | 'number' | 'boolean' | 'date' | 'id' = 'text',
): string {
  if (value === null || value === undefined) return '';
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value);
    return '';
  }
  if (kind === 'date') {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value) {
      const d = new Date(value);
      return Number.isNaN(d.getTime())
        ? neutraliseCell(value)
        : d.toISOString();
    }
    return '';
  }
  if (kind === 'id') {
    const s = String(value);
    // ids are system-generated but still pass through quoting; no formula prefix
    return quoteIfNeeded(/[",\r\n]/.test(s) ? s : s);
  }
  const s = typeof value === 'string' ? value : String(value);
  return quoteIfNeeded(neutraliseCell(s));
}

export type CsvColumn<T> = {
  header: string;
  kind: 'text' | 'number' | 'boolean' | 'date' | 'id';
  get: (row: T) => unknown;
};

export function csvHeader<T>(columns: readonly CsvColumn<T>[]): string {
  return columns.map((c) => formatCell(c.header, 'text')).join(',');
}

export function csvRow<T>(columns: readonly CsvColumn<T>[], row: T): string {
  return columns.map((c) => formatCell(c.get(row), c.kind)).join(',');
}

/** One chunk: header (with BOM when `first`) + rows. */
export function csvChunk<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
  first: boolean,
): string {
  const parts: string[] = [];
  if (first) parts.push(CSV_BOM + csvHeader(columns));
  for (const row of rows) parts.push(csvRow(columns, row));
  if (parts.length === 0) return '';
  // Each part becomes a line; caller streams chunks; ensure chunk ends with EOL.
  return parts.join(CSV_EOL) + CSV_EOL;
}

export function exportFilename(
  kind: 'people' | 'leads',
  now = new Date(),
): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${kind}-${y}${m}${d}.csv`;
}
