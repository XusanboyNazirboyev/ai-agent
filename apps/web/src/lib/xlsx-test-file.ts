import { strToU8, zipSync } from 'fflate';

/**
 * Builds a small .xlsx in memory for tests, with the parts and attributes
 * Excel writes (workbook, relationships, shared strings, styles, sheets).
 */

export interface TestCell {
  /** Cell reference such as `B2`; the order in a row is as given. */
  readonly ref: string;
  /** Excel cell type: s (shared string), n, str, inlineStr, b, e. */
  readonly t?: string;
  /** Raw `<v>` content (for `s` the index into the shared strings). */
  readonly v?: string;
  /** Style index (`s` attribute). */
  readonly s?: number;
  /** For `inlineStr`: the text. */
  readonly inline?: string;
}

export interface TestRow {
  readonly r: number;
  readonly hidden?: boolean;
  readonly cells: readonly TestCell[];
}

export interface TestSheet {
  readonly name: string;
  readonly state?: 'hidden' | 'veryHidden' | 'visible';
  readonly rows: readonly TestRow[];
}

export interface TestWorkbook {
  readonly sheets: readonly TestSheet[];
  /** Plain texts; a string with a `\u0001` prefix is written as rich text runs. */
  readonly shared?: readonly string[];
  /** `numFmtId` per cell style index (cellXfs), plus custom formats. */
  readonly xfFormats?: readonly number[];
  readonly customFormats?: Readonly<Record<number, string>>;
  readonly date1904?: boolean;
  /** Extra raw XML added to xl/workbook.xml before the sheets (attack tests). */
  readonly extraWorkbookXml?: string;
  /** Raw XML between the XML declaration and the root of xl/workbook.xml (a DOCTYPE). */
  readonly prologXml?: string;
}

const escape = (text: string): string =>
  text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

function cellXml(cell: TestCell): string {
  const attrs = [
    `r="${cell.ref}"`,
    cell.t ? `t="${cell.t}"` : '',
    cell.s !== undefined ? `s="${cell.s}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (cell.t === 'inlineStr')
    return `<c ${attrs}><is><t>${escape(cell.inline ?? '')}</t></is></c>`;
  return cell.v === undefined
    ? `<c ${attrs}/>`
    : `<c ${attrs}><v>${escape(cell.v)}</v></c>`;
}

export function makeXlsx(book: TestWorkbook): Uint8Array {
  const NS =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const R =
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  const sheetTags = book.sheets
    .map(
      (sheet, i) =>
        `<sheet name="${escape(sheet.name)}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${i + 1}"/>`,
    )
    .join('');
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${book.prologXml ?? ''}<workbook ${NS} ${R}>${book.extraWorkbookXml ?? ''}<workbookPr${book.date1904 ? ' date1904="1"' : ''}/><sheets>${sheetTags}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${book.sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  if (book.shared)
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="${book.shared.length}" uniqueCount="${book.shared.length}">${book.shared
        .map((text) =>
          text.startsWith('\u0001')
            ? `<si>${text
                .slice(1)
                .split('|')
                .map((run) => `<r><t>${escape(run)}</t></r>`)
                .join('')}<rPh sb="0" eb="1"><t>IGNORED</t></rPh></si>`
            : `<si><t>${escape(text)}</t></si>`,
        )
        .join('')}</sst>`,
    );
  if (book.xfFormats) {
    const custom = Object.entries(book.customFormats ?? {})
      .map(
        ([id, code]) =>
          `<numFmt numFmtId="${id}" formatCode="${escape(code)}"/>`,
      )
      .join('');
    files['xl/styles.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}>${custom ? `<numFmts count="1">${custom}</numFmts>` : ''}<cellXfs count="${book.xfFormats.length}">${book.xfFormats
        .map((id) => `<xf numFmtId="${id}"/>`)
        .join('')}</cellXfs></styleSheet>`,
    );
  }
  book.sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetData>${sheet.rows
        .map(
          (row) =>
            `<row r="${row.r}"${row.hidden ? ' hidden="1"' : ''}>${row.cells.map(cellXml).join('')}</row>`,
        )
        .join('')}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

/** A header row and data rows of plain shared-string and number cells. */
export function simpleBook(
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
  name = 'Prices',
): { book: TestWorkbook; bytes: Uint8Array } {
  const shared: string[] = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const testRows: TestRow[] = rows.map((row, r) => ({
    r: r + 1,
    cells: row.map((value, c): TestCell => {
      const ref = `${letters[c]}${r + 1}`;
      if (typeof value === 'number') return { ref, v: String(value) };
      shared.push(value);
      return { ref, t: 's', v: String(shared.length - 1) };
    }),
  }));
  const book: TestWorkbook = { sheets: [{ name, rows: testRows }], shared };
  return { book, bytes: makeXlsx(book) };
}
