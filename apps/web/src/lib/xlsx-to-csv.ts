import { unzipSync } from 'fflate';

/**
 * Reads an Excel workbook (.xlsx) in the BROWSER and turns one sheet into CSV
 * text, so the server keeps reading CSV only (ADR 064, S3). An .xlsx is a zip
 * of XML files; only text, numbers and dates are read: macros, formulas (the
 * value Excel saved is used), styles and pictures are ignored.
 *
 * Untrusted file, so: size limits are checked on the sizes the zip declares
 * BEFORE anything is inflated, XML with a DOCTYPE or entities is refused, and
 * the browser's own XML parser (no external entities) does the parsing.
 */

export const XLSX_LIMITS = {
  /** Largest XML part after inflating (the sheet itself). */
  maxPartBytes: 50 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
  maxEntries: 200,
  maxRows: 20_000,
  maxColumns: 60,
} as const;

export type XlsxErrorCode =
  'XLSX_UNREADABLE' | 'XLSX_TOO_LARGE' | 'XLSX_NO_DATA' | 'XLSX_OLD_FORMAT';

export class XlsxError extends Error {
  constructor(readonly code: XlsxErrorCode) {
    super(code);
    this.name = 'XlsxError';
  }
}

export interface XlsxSheet {
  readonly name: string;
  /** Visible and with at least one cell of text. */
  readonly hasData: boolean;
  /** The sheet as CSV text (comma separated, quoted where needed). */
  readonly csv: string;
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Built-in number formats that show a date or a time (ECMA-376 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

const decoder = new TextDecoder('utf-8');

function parseXml(bytes: Uint8Array): Document {
  const text = decoder.decode(bytes);
  // A workbook never needs a DTD or entities; refusing them closes the
  // entity-expansion attacks without relying on the parser's own limits.
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new XlsxError('XLSX_UNREADABLE');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0)
    throw new XlsxError('XLSX_UNREADABLE');
  return doc;
}

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter(
    (child) => child.localName === name,
  );
}

function descendants(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(NS_MAIN, name));
}

/** `AB12` -> column index 27 (0-based), or -1 when it is not a cell reference. */
export function columnIndex(reference: string): number {
  const match = /^([A-Z]{1,3})\d+$/u.exec(reference);
  if (!match) return -1;
  let index = 0;
  for (const letter of match[1]!)
    index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

/** An Excel date serial as `YYYY-MM-DD` (the time of day is dropped). */
export function serialToDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const whole = Math.floor(serial);
  if (!date1904 && whole === 60) return null; // the fictional 29 Feb 1900
  // 1900 system: serial 1 is 1900-01-01, and Excel counts a 29 Feb 1900 that
  // never existed, so from 61 on the epoch is 1899-12-30; before it, 12-31.
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : whole < 60
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const time = new Date(epoch + whole * 86_400_000);
  const year = time.getUTCFullYear();
  if (year < 1900 || year > 2200) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())}`;
}

/** Whether a custom number format code shows a date (d, m, y outside quotes and brackets). */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/gu, '')
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/\\./gu, '');
  if (/^general$/iu.test(stripped.trim())) return false;
  return /[dmyhs]/iu.test(stripped) && /[dmy]/iu.test(stripped);
}

/** A number cell as text: integers as they are, decimals trimmed of float noise. */
export function numberText(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/\.?0+$/u, '');
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

interface Workbook {
  readonly files: Record<string, Uint8Array>;
  readonly sheets: ReadonlyArray<{
    name: string;
    hidden: boolean;
    path: string;
  }>;
  readonly shared: readonly string[];
  readonly dateStyles: ReadonlySet<number>;
  readonly date1904: boolean;
}

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  // The ZIP signature of every real .xlsx; an old .xls is a different container.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf)
      throw new XlsxError('XLSX_OLD_FORMAT');
    throw new XlsxError('XLSX_UNREADABLE');
  }
  let entries = 0;
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        total += file.originalSize;
        if (
          entries > XLSX_LIMITS.maxEntries ||
          file.originalSize > XLSX_LIMITS.maxPartBytes ||
          total > XLSX_LIMITS.maxTotalBytes
        )
          throw new XlsxError('XLSX_TOO_LARGE');
        // Only the parts that are read are inflated.
        return (
          file.name === 'xl/workbook.xml' ||
          file.name === 'xl/_rels/workbook.xml.rels' ||
          file.name === 'xl/sharedStrings.xml' ||
          file.name === 'xl/styles.xml' ||
          /^xl\/worksheets\/[^/]+\.xml$/u.test(file.name)
        );
      },
    });
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError('XLSX_UNREADABLE');
  }
}

function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzip(bytes);
  const workbookXml = files['xl/workbook.xml'];
  const relsXml = files['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !relsXml) throw new XlsxError('XLSX_UNREADABLE');
  const workbook = parseXml(workbookXml);
  const rels = parseXml(relsXml);

  const targets = new Map<string, string>();
  for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target)
      targets.set(
        id,
        target.startsWith('/')
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//u, '')}`,
      );
  }
  const sheets: Array<{ name: string; hidden: boolean; path: string }> = [];
  for (const sheet of descendants(workbook, 'sheet')) {
    const id = sheet.getAttributeNS(NS_REL, 'id');
    const path = id ? targets.get(id) : undefined;
    const name = sheet.getAttribute('name');
    if (!path || !name || !files[path]) continue;
    sheets.push({
      name,
      hidden:
        sheet.getAttribute('state') !== null &&
        sheet.getAttribute('state') !== 'visible',
      path,
    });
  }
  if (sheets.length === 0) throw new XlsxError('XLSX_UNREADABLE');

  const shared: string[] = [];
  const sharedXml = files['xl/sharedStrings.xml'];
  if (sharedXml)
    for (const item of descendants(parseXml(sharedXml), 'si'))
      // Rich text is several runs; phonetic hints (rPh) are not part of the text.
      shared.push(
        descendants(item, 't')
          .filter((t) => t.parentElement?.localName !== 'rPh')
          .map((t) => t.textContent ?? '')
          .join(''),
      );

  const dateStyles = new Set<number>();
  const stylesXml = files['xl/styles.xml'];
  if (stylesXml) {
    const styles = parseXml(stylesXml);
    const custom = new Map<number, string>();
    for (const format of descendants(styles, 'numFmt')) {
      const id = Number(format.getAttribute('numFmtId'));
      const code = format.getAttribute('formatCode');
      if (Number.isInteger(id) && code) custom.set(id, code);
    }
    const cellXfs = descendants(styles, 'cellXfs')[0];
    if (cellXfs)
      children(cellXfs, 'xf').forEach((xf, index) => {
        const id = Number(xf.getAttribute('numFmtId'));
        const code = custom.get(id);
        if (BUILTIN_DATE_FORMATS.has(id) || (code && isDateFormatCode(code)))
          dateStyles.add(index);
      });
  }
  const date1904 =
    descendants(workbook, 'workbookPr')[0]?.getAttribute('date1904') === '1';
  return { files, sheets, shared, dateStyles, date1904 };
}

function sheetToCsv(
  book: Workbook,
  path: string,
): { csv: string; hasData: boolean } {
  const xml = book.files[path];
  if (!xml) throw new XlsxError('XLSX_UNREADABLE');
  const doc = parseXml(xml);
  const lines: string[] = [];
  let hasData = false;
  let rowNumber = 0;
  for (const row of descendants(doc, 'row')) {
    const declared = Number(row.getAttribute('r'));
    const at =
      Number.isInteger(declared) && declared > 0 ? declared : rowNumber + 1;
    if (at > XLSX_LIMITS.maxRows + 1) throw new XlsxError('XLSX_TOO_LARGE');
    while (rowNumber + 1 < at) {
      lines.push('');
      rowNumber += 1;
    }
    // Rows hidden in Excel (often old or withdrawn prices) are not imported,
    // but they keep their place as an empty line, so a line number reported
    // for a problem is the row number the admin sees in Excel.
    if (
      row.getAttribute('hidden') === '1' ||
      row.getAttribute('hidden') === 'true'
    ) {
      lines.push('');
      rowNumber = at;
      continue;
    }
    const cells: string[] = [];
    let next = 0;
    for (const cell of children(row, 'c')) {
      const column = columnIndex(cell.getAttribute('r') ?? '');
      const index = column >= 0 ? column : next;
      if (index >= XLSX_LIMITS.maxColumns) continue;
      while (cells.length < index) cells.push('');
      const kind = cell.getAttribute('t') ?? 'n';
      const valueText = children(cell, 'v')[0]?.textContent ?? '';
      let text = '';
      if (kind === 's') text = book.shared[Number(valueText)] ?? '';
      else if (kind === 'inlineStr')
        text = descendants(cell, 't')
          .map((t) => t.textContent ?? '')
          .join('');
      else if (kind === 'str') text = valueText;
      else if (kind === 'b') text = valueText === '1' ? 'TRUE' : 'FALSE';
      else if (kind === 'e') text = '';
      else if (valueText !== '') {
        const style = Number(cell.getAttribute('s') ?? '0');
        const serial = Number(valueText);
        text = book.dateStyles.has(style)
          ? (serialToDate(serial, book.date1904) ?? numberText(valueText))
          : numberText(valueText);
      }
      if (text.trim() !== '') hasData = true;
      cells[index] = text;
      next = index + 1;
    }
    lines.push(cells.map(csvCell).join(','));
    rowNumber = at;
  }
  while (lines.length > 0 && lines[lines.length - 1]!.replace(/,/gu, '') === '')
    lines.pop();
  return { csv: lines.join('\n'), hasData };
}

/** All sheets of a workbook as CSV; hidden sheets are listed but never `hasData`. */
export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  const book = readWorkbook(bytes);
  const sheets = book.sheets.map((sheet) => {
    const { csv, hasData } = sheetToCsv(book, sheet.path);
    return { name: sheet.name, hasData: hasData && !sheet.hidden, csv };
  });
  if (!sheets.some((sheet) => sheet.hasData))
    throw new XlsxError('XLSX_NO_DATA');
  return sheets;
}
