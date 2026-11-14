/**
 * Reads a price list exported as CSV (Excel "CSV UTF-8", Google Sheets
 * "Download as CSV"): comma, semicolon or tab separated, quotes with doubled
 * quotes, line breaks inside quotes, UTF-8 with or without a BOM (ADR 064).
 * Pure text in, cells out: nothing is evaluated, no formula is followed.
 */

export const SHEET_LIMITS = {
  /** Bytes of the file text, counted as UTF-8. */
  maxBytes: 5 * 1024 * 1024,
  maxRows: 20_000,
  maxColumns: 60,
  maxCellLength: 2_000,
} as const;

export type SheetLimitCode =
  | 'SHEET_TOO_LARGE'
  | 'SHEET_TOO_MANY_ROWS'
  | 'SHEET_TOO_MANY_COLUMNS'
  | 'SHEET_CELL_TOO_LONG'
  | 'SHEET_EMPTY'
  | 'SHEET_UNTERMINATED_QUOTE';

export class SheetReadError extends Error {
  constructor(
    readonly code: SheetLimitCode,
    message: string,
    /** 1-based line of the problem, when there is one. */
    readonly line?: number,
  ) {
    super(message);
    this.name = 'SheetReadError';
  }
}

export type Delimiter = ',' | ';' | '\t';
const DELIMITERS: readonly Delimiter[] = [',', ';', '\t'];

export interface ParsedSheet {
  readonly delimiter: Delimiter;
  /** The header row, trimmed. */
  readonly header: readonly string[];
  /** Data rows with their 1-based line number in the file. */
  readonly rows: ReadonlyArray<{ line: number; cells: readonly string[] }>;
}

/** Counts a delimiter in the first line, ignoring the ones inside quotes. */
function countInFirstLine(text: string, delimiter: Delimiter): number {
  let inQuotes = false;
  let count = 0;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) break;
    else if (!inQuotes && char === delimiter) count += 1;
  }
  return count;
}

/** The delimiter with the most occurrences in the header line (comma on a tie). */
export function detectDelimiter(text: string): Delimiter {
  let best: Delimiter = ',';
  let bestCount = -1;
  for (const delimiter of DELIMITERS) {
    const count = countInFirstLine(text, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function splitRecords(
  text: string,
  delimiter: Delimiter,
): Array<{ line: number; cells: string[] }> {
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let quotedAt = 0;

  const endCell = (): void => {
    if (cell.length > SHEET_LIMITS.maxCellLength)
      throw new SheetReadError(
        'SHEET_CELL_TOO_LONG',
        `A cell is longer than ${SHEET_LIMITS.maxCellLength} characters`,
        startLine,
      );
    cells.push(cell);
    cell = '';
  };
  const endRecord = (): void => {
    endCell();
    if (cells.length > SHEET_LIMITS.maxColumns)
      throw new SheetReadError(
        'SHEET_TOO_MANY_COLUMNS',
        `More than ${SHEET_LIMITS.maxColumns} columns`,
        startLine,
      );
    records.push({ line: startLine, cells });
    if (records.length > SHEET_LIMITS.maxRows + 1)
      throw new SheetReadError(
        'SHEET_TOO_MANY_ROWS',
        `More than ${SHEET_LIMITS.maxRows} rows`,
        line,
      );
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      inQuotes = true;
      quotedAt = line;
    } else if (char === delimiter) endCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else cell += char;
  }
  if (inQuotes)
    throw new SheetReadError(
      'SHEET_UNTERMINATED_QUOTE',
      'A quoted cell is never closed',
      quotedAt,
    );
  if (cell.length > 0 || cells.length > 0) endRecord();
  return records;
}

/** Parses CSV text into a header and data rows; blank lines are skipped. */
export function parseSheet(input: string, delimiter?: Delimiter): ParsedSheet {
  if (Buffer.byteLength(input, 'utf8') > SHEET_LIMITS.maxBytes)
    throw new SheetReadError('SHEET_TOO_LARGE', 'The file is too large');
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const chosen = delimiter ?? detectDelimiter(text);
  const records = splitRecords(text, chosen)
    .map((record) => ({
      line: record.line,
      cells: record.cells.map((value) => value.trim()),
    }))
    .filter((record) => record.cells.some((value) => value !== ''));
  const [head, ...data] = records;
  if (!head || head.cells.every((value) => value === ''))
    throw new SheetReadError('SHEET_EMPTY', 'The file has no header row');
  return { delimiter: chosen, header: head.cells, rows: data };
}
