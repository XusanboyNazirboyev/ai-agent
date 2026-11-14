import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  XlsxError,
  XLSX_LIMITS,
  columnIndex,
  isDateFormatCode,
  numberText,
  readXlsx,
  serialToDate,
} from './xlsx-to-csv';
import { makeXlsx, simpleBook } from './xlsx-test-file';

const csvOf = (bytes: Uint8Array, index = 0): string =>
  readXlsx(bytes)[index]!.csv;
const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof XlsxError ? error.code : `other:${String(error)}`;
  }
  return undefined;
};

describe('cell helpers', () => {
  it('reads column letters', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA10')).toBe(26);
    expect(columnIndex('AB12')).toBe(27);
    expect(columnIndex('1A')).toBe(-1);
    expect(columnIndex('')).toBe(-1);
  });

  it('turns date serials into dates', () => {
    expect(serialToDate(45000)).toBe('2023-03-15');
    expect(serialToDate(46095)).toBe('2026-03-14');
    expect(serialToDate(46095.75)).toBe('2026-03-14');
    expect(serialToDate(61)).toBe('1900-03-01');
    expect(serialToDate(59)).toBe('1900-02-28');
    expect(serialToDate(60)).toBeNull();
    expect(serialToDate(0.5)).toBeNull();
    expect(serialToDate(-3)).toBeNull();
    expect(serialToDate(Number.NaN)).toBeNull();
    expect(serialToDate(99_999_999)).toBeNull();
    // The 1904 system starts four years and a day later.
    expect(serialToDate(43538, true)).toBe('2023-03-15');
  });

  it('knows which custom formats are dates', () => {
    expect(isDateFormatCode('dd.mm.yyyy')).toBe(true);
    expect(isDateFormatCode('yyyy-mm-dd;@')).toBe(true);
    expect(isDateFormatCode('[$-409]d-mmm-yy')).toBe(true);
    expect(isDateFormatCode('General')).toBe(false);
    expect(isDateFormatCode('#,##0.00')).toBe(false);
    expect(isDateFormatCode('0.00" days"')).toBe(false);
    expect(isDateFormatCode('"m" 0')).toBe(false);
    expect(isDateFormatCode('[Red]0.00')).toBe(false);
  });

  it('writes numbers without float noise', () => {
    expect(numberText('1240')).toBe('1240');
    expect(numberText('710.5')).toBe('710.5');
    expect(numberText('905.1000000000001')).toBe('905.1');
    expect(numberText('0.1')).toBe('0.1');
    expect(numberText('1E+3')).toBe('1000');
    expect(numberText('abc')).toBe('abc');
  });
});

describe('reading a workbook', () => {
  it('reads shared strings and numbers into CSV', () => {
    const { bytes } = simpleBook([
      ['Hotel', 'Nights', 'Price'],
      ['Rixos Premium Palm', 5, 820],
      ['Nova Beach', 7, 710.5],
    ]);
    expect(csvOf(bytes)).toBe(
      'Hotel,Nights,Price\nRixos Premium Palm,5,820\nNova Beach,7,710.5',
    );
    expect(readXlsx(bytes)[0]).toMatchObject({ name: 'Prices', hasData: true });
  });

  it('quotes commas, quotes and line breaks so the server reads the same cells', () => {
    const { bytes } = simpleBook([
      ['Hotel', 'Notes'],
      ['A, B', 'say "hi"\nnext line'],
    ]);
    expect(csvOf(bytes)).toBe('Hotel,Notes\n"A, B","say ""hi""\nnext line"');
  });

  it('keeps formulas and odd text as plain text', () => {
    const { bytes } = simpleBook([
      ['Hotel'],
      ['=HYPERLINK("http://x","y")'],
      ['+1+1'],
    ]);
    expect(csvOf(bytes)).toBe('Hotel\n"=HYPERLINK(""http://x"",""y"")"\n+1+1');
  });

  it('reads inline strings, formula strings, booleans and drops errors', () => {
    const bytes = makeXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            {
              r: 1,
              cells: [
                { ref: 'A1', t: 'inlineStr', inline: 'Hotel & Spa' },
                { ref: 'B1', t: 'str', v: 'from a formula' },
                { ref: 'C1', t: 'b', v: '1' },
                { ref: 'D1', t: 'e', v: '#DIV/0!' },
                { ref: 'E1', v: '12' },
              ],
            },
          ],
        },
      ],
    });
    expect(csvOf(bytes)).toBe('Hotel & Spa,from a formula,TRUE,,12');
  });

  it('joins rich text runs and ignores phonetic hints', () => {
    const bytes = makeXlsx({
      sheets: [
        { name: 'S', rows: [{ r: 1, cells: [{ ref: 'A1', t: 's', v: '0' }] }] },
      ],
      shared: ['\u0001Rixos |Premium'],
    });
    expect(csvOf(bytes)).toBe('Rixos Premium');
  });

  it('places cells by their reference, with empty ones in between, and keeps row gaps', () => {
    const bytes = makeXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            {
              r: 1,
              cells: [
                { ref: 'A1', v: '1' },
                { ref: 'D1', v: '4' },
              ],
            },
            { r: 3, cells: [{ ref: 'B3', v: '2' }] },
          ],
        },
      ],
    });
    expect(csvOf(bytes)).toBe('1,,,4\n\n,2');
  });

  it('turns date cells into ISO dates, by built-in and custom formats, and leaves plain numbers', () => {
    const bytes = makeXlsx({
      xfFormats: [0, 14, 164, 165],
      customFormats: { 164: 'dd.mm.yyyy', 165: '#,##0.00' },
      sheets: [
        {
          name: 'S',
          rows: [
            {
              r: 1,
              cells: [
                { ref: 'A1', s: 1, v: '46095' },
                { ref: 'B1', s: 2, v: '46096' },
                { ref: 'C1', s: 3, v: '46097' },
                { ref: 'D1', s: 0, v: '46098' },
              ],
            },
          ],
        },
      ],
    });
    expect(csvOf(bytes)).toBe('2026-03-14,2026-03-15,46097,46098');
  });

  it('honours the 1904 date system', () => {
    const bytes = makeXlsx({
      date1904: true,
      xfFormats: [0, 14],
      sheets: [
        {
          name: 'S',
          rows: [{ r: 1, cells: [{ ref: 'A1', s: 1, v: '43538' }] }],
        },
      ],
    });
    expect(csvOf(bytes)).toBe('2023-03-15');
  });

  it('skips rows hidden in Excel and lists hidden sheets without data', () => {
    const bytes = makeXlsx({
      sheets: [
        {
          name: 'Visible',
          rows: [
            { r: 1, cells: [{ ref: 'A1', t: 'inlineStr', inline: 'Hotel' }] },
            {
              r: 2,
              hidden: true,
              cells: [{ ref: 'A2', t: 'inlineStr', inline: 'Old price' }],
            },
            { r: 3, cells: [{ ref: 'A3', t: 'inlineStr', inline: 'Current' }] },
          ],
        },
        {
          name: 'Secret',
          state: 'hidden',
          rows: [
            { r: 1, cells: [{ ref: 'A1', t: 'inlineStr', inline: 'Cost' }] },
          ],
        },
        { name: 'Empty', rows: [] },
      ],
    });
    const sheets = readXlsx(bytes);
    expect(sheets.map((s) => [s.name, s.hasData])).toEqual([
      ['Visible', true],
      ['Secret', false],
      ['Empty', false],
    ]);
    expect(sheets[0]!.csv).toBe('Hotel\n\nCurrent');
  });

  it('drops trailing empty rows and refuses a workbook without any text', () => {
    const { bytes } = simpleBook([['Hotel'], ['A'], ['']]);
    expect(csvOf(bytes)).toBe('Hotel\nA');
    expect(
      codeOf(() => readXlsx(makeXlsx({ sheets: [{ name: 'S', rows: [] }] }))),
    ).toBe('XLSX_NO_DATA');
  });
});

describe('refusing bad files', () => {
  it('refuses what is not an .xlsx', () => {
    expect(codeOf(() => readXlsx(strToU8('Hotel,Price\nA,1')))).toBe(
      'XLSX_UNREADABLE',
    );
    expect(codeOf(() => readXlsx(new Uint8Array(0)))).toBe('XLSX_UNREADABLE');
    // The old binary .xls container starts with D0 CF 11 E0.
    expect(
      codeOf(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))),
    ).toBe('XLSX_OLD_FORMAT');
    // A zip without the workbook parts.
    expect(
      codeOf(() => readXlsx(zipSync({ 'readme.txt': strToU8('hi') }))),
    ).toBe('XLSX_UNREADABLE');
    // A cut-off zip.
    const { bytes } = simpleBook([['Hotel'], ['A']]);
    expect(
      codeOf(() => readXlsx(bytes.slice(0, Math.floor(bytes.length / 2)))),
    ).toBe('XLSX_UNREADABLE');
  });

  it('refuses a DOCTYPE or entities anywhere in the XML (entity expansion)', () => {
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>';
    const { book } = simpleBook([['Hotel'], ['A']]);
    expect(codeOf(() => readXlsx(makeXlsx({ ...book, prologXml: bomb })))).toBe(
      'XLSX_UNREADABLE',
    );
  });

  it('refuses XML that is not well formed', () => {
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships/>'),
    };
    expect(codeOf(() => readXlsx(zipSync(files)))).toBe('XLSX_UNREADABLE');
  });

  it('refuses a part that declares more than the limit before inflating it', () => {
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml': new Uint8Array(XLSX_LIMITS.maxPartBytes + 1),
    };
    expect(codeOf(() => readXlsx(zipSync(files, { level: 9 })))).toBe(
      'XLSX_TOO_LARGE',
    );
  });

  it('refuses a zip with too many entries', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= XLSX_LIMITS.maxEntries; i += 1)
      files[`junk/${i}.txt`] = strToU8('x');
    expect(codeOf(() => readXlsx(zipSync(files)))).toBe('XLSX_TOO_LARGE');
  });

  it('refuses a sheet with more rows than the server accepts', () => {
    const bytes = makeXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            { r: 1, cells: [{ ref: 'A1', t: 'inlineStr', inline: 'Hotel' }] },
            {
              r: XLSX_LIMITS.maxRows + 2,
              cells: [{ ref: 'A1', t: 'inlineStr', inline: 'Late' }],
            },
          ],
        },
      ],
    });
    expect(codeOf(() => readXlsx(bytes))).toBe('XLSX_TOO_LARGE');
  });
});
