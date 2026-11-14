import { describe, expect, it } from 'vitest';
import { parseSheet, SHEET_LIMITS, SheetReadError } from './csv-reader';

function sheet(
  text: string,
  delimiter?: Parameters<typeof parseSheet>[1],
): ReturnType<typeof parseSheet> {
  return parseSheet(text, delimiter);
}

describe('csv-reader adversarial', () => {
  describe('BOM', () => {
    it('strips a UTF-8 BOM and parses normally', () => {
      const s = sheet('\uFEFFa,b\n1,2\n');
      expect(s.header).toEqual(['a', 'b']);
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.cells).toEqual(['1', '2']);
    });

    it('parses without BOM', () => {
      const s = sheet('a,b\n1,2\n');
      expect(s.header).toEqual(['a', 'b']);
    });
  });

  describe('line endings', () => {
    it('handles LF', () => {
      const s = sheet('a,b\n1,2\n3,4\n');
      expect(s.rows).toHaveLength(2);
      expect(s.rows[1]!.line).toBe(3);
    });

    it('handles CRLF', () => {
      const s = sheet('a,b\r\n1,2\r\n3,4\r\n');
      expect(s.rows).toHaveLength(2);
    });

    it('handles lone CR', () => {
      const s = sheet('a,b\r1,2\r3,4\r');
      expect(s.rows).toHaveLength(2);
    });

    it('mixed CRLF and LF do not skip a row', () => {
      const s = sheet('a,b\r\n1,2\n3,4\r\n');
      expect(s.rows).toHaveLength(2);
    });
  });

  describe('quoted cells', () => {
    it('quoted cell with an embedded newline', () => {
      const s = sheet('a,b\n"x\ny",2\n');
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.cells).toEqual(['x\ny', '2']);
    });

    it('quoted cell with an embedded comma', () => {
      const s = sheet('a,b\n"x, y",2\n');
      expect(s.rows[0]!.cells).toEqual(['x, y', '2']);
    });

    it('quoted cell with doubled quotes', () => {
      const s = sheet('a,b\n"say ""hi""",2\n');
      expect(s.rows[0]!.cells).toEqual(['say "hi"', '2']);
    });

    it('quote in the middle of an unquoted cell is treated as literal', () => {
      const s = sheet('a,b\nhe"llo,2\n');
      expect(s.rows[0]!.cells).toEqual(['he"llo', '2']);
    });

    it('unterminated quote throws SHEET_UNTERMINATED_QUOTE with a line number', () => {
      let error: SheetReadError | null = null;
      try {
        sheet('a,b\n"never closed\n');
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error).not.toBeNull();
      expect(error!.code).toBe('SHEET_UNTERMINATED_QUOTE');
      expect(error!.line).toBe(2);
    });

    it('unterminated quote on a later row reports that row', () => {
      let error: SheetReadError | null = null;
      try {
        sheet('a,b\n1,2\n"open\n');
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_UNTERMINATED_QUOTE');
      expect(error!.line).toBe(3);
    });

    it('a quote that starts mid-cell after text is not treated as opening', () => {
      const s = sheet('a,b\nx"y,2\n');
      expect(s.rows[0]!.cells).toEqual(['x"y', '2']);
    });
  });

  describe('semicolon and tab delimiters', () => {
    it('parses a semicolon file', () => {
      const s = sheet('a;b\n1;2\n');
      expect(s.delimiter).toBe(';');
      expect(s.rows[0]!.cells).toEqual(['1', '2']);
    });

    it('parses a tab file', () => {
      const s = sheet('a\tb\n1\t2\n');
      expect(s.delimiter).toBe('\t');
      expect(s.rows[0]!.cells).toEqual(['1', '2']);
    });

    it('explicit delimiter overrides detection', () => {
      const s = sheet('a;b\n1;2\n', ',');
      expect(s.delimiter).toBe(',');
      expect(s.header).toEqual(['a;b']);
      expect(s.rows[0]!.cells).toEqual(['1;2']);
    });
  });

  describe('delimiter detection', () => {
    it('picks comma when the header has more commas', () => {
      const s = sheet('a,b,c\n1,2,3\n');
      expect(s.delimiter).toBe(',');
    });

    it('picks semicolon when the header has more semicolons', () => {
      const s = sheet('a;b;c\n1;2;3\n');
      expect(s.delimiter).toBe(';');
    });

    it('ignores commas inside quoted header cells', () => {
      const s = sheet('"a, b",c\n1,2\n');
      expect(s.delimiter).toBe(',');
      expect(s.header).toEqual(['a, b', 'c']);
    });

    it('defaults to comma on a tie', () => {
      const s = sheet('a,b;c\n1,2;3\n');
      expect(s.delimiter).toBe(',');
    });
  });

  describe('header-only and empty files', () => {
    it('header-only file returns no data rows', () => {
      const s = sheet('a,b\n');
      expect(s.header).toEqual(['a', 'b']);
      expect(s.rows).toHaveLength(0);
    });

    it('empty file throws SHEET_EMPTY', () => {
      let error: SheetReadError | null = null;
      try {
        sheet('');
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_EMPTY');
    });

    it('file of only blank lines throws SHEET_EMPTY', () => {
      let error: SheetReadError | null = null;
      try {
        sheet('\n\n\n');
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_EMPTY');
    });

    it('trailing blank lines are skipped', () => {
      const s = sheet('a,b\n1,2\n\n\n');
      expect(s.rows).toHaveLength(1);
    });

    it('blank lines between data rows are skipped', () => {
      const s = sheet('a,b\n1,2\n\n3,4\n');
      expect(s.rows).toHaveLength(2);
    });
  });

  describe('short and long rows', () => {
    it('row shorter than header is not an error', () => {
      const s = sheet('a,b,c\n1,2\n');
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.cells).toEqual(['1', '2']);
    });

    it('row longer than header is not an error', () => {
      const s = sheet('a,b\n1,2,3\n');
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.cells).toEqual(['1', '2', '3']);
    });

    it('completely empty data row is skipped', () => {
      const s = sheet('a,b\n\n1,2\n');
      expect(s.rows).toHaveLength(1);
    });

    it('row with only whitespace cells is skipped', () => {
      const s = sheet('a,b\n   ,\n1,2\n');
      expect(s.rows).toHaveLength(1);
    });
  });

  describe('limits', () => {
    it('one cell over maxCellLength throws SHEET_CELL_TOO_LONG', () => {
      const longCell = 'x'.repeat(SHEET_LIMITS.maxCellLength + 1);
      let error: SheetReadError | null = null;
      try {
        sheet(`a,b\n${longCell},2\n`);
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_CELL_TOO_LONG');
      expect(error!.line).toBe(2);
    });

    it('a cell exactly at maxCellLength is accepted', () => {
      const longCell = 'x'.repeat(SHEET_LIMITS.maxCellLength);
      const s = sheet(`a,b\n${longCell},2\n`);
      expect(s.rows[0]!.cells[0]).toHaveLength(SHEET_LIMITS.maxCellLength);
    });

    it('more than maxColumns throws SHEET_TOO_MANY_COLUMNS', () => {
      const row = Array(SHEET_LIMITS.maxColumns + 1)
        .fill('x')
        .join(',');
      let error: SheetReadError | null = null;
      try {
        sheet(`a,b\n${row}\n`);
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_TOO_MANY_COLUMNS');
    });

    it('exactly maxColumns is accepted', () => {
      const row = Array(SHEET_LIMITS.maxColumns).fill('x').join(',');
      const s = sheet(`a,b\n${row}\n`);
      expect(s.rows[0]!.cells).toHaveLength(SHEET_LIMITS.maxColumns);
    });

    it('more than maxRows throws SHEET_TOO_MANY_ROWS', () => {
      const rows = Array(SHEET_LIMITS.maxRows + 2)
        .fill('x,y')
        .join('\n');
      let error: SheetReadError | null = null;
      try {
        sheet(`a,b\n${rows}\n`);
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_TOO_MANY_ROWS');
    });

    it('exactly maxRows data rows is accepted', () => {
      const rows = Array(SHEET_LIMITS.maxRows).fill('x,y').join('\n');
      const s = sheet(`a,b\n${rows}\n`);
      expect(s.rows).toHaveLength(SHEET_LIMITS.maxRows);
    });

    it('a file over maxBytes throws SHEET_TOO_LARGE', () => {
      const big = 'x'.repeat(SHEET_LIMITS.maxBytes);
      let error: SheetReadError | null = null;
      try {
        sheet(`a,b\n${big},2\n`);
      } catch (e) {
        error = e as SheetReadError;
      }
      expect(error!.code).toBe('SHEET_TOO_LARGE');
    });
  });

  describe('formulas and Unicode', () => {
    it('spreadsheet formula text comes back as plain text, unchanged', () => {
      const s = sheet('a,b\n"=HYPERLINK(""http://x"",""y"")",+1+1\n');
      expect(s.rows[0]!.cells).toEqual(['=HYPERLINK("http://x","y")', '+1+1']);
    });

    it('@SUM formula is plain text', () => {
      const s = sheet('a,b\n@SUM(A1),2\n');
      expect(s.rows[0]!.cells[0]).toBe('@SUM(A1)');
    });

    it('Cyrillic is preserved', () => {
      const s = sheet('a,b\nМосква,Привет\n');
      expect(s.rows[0]!.cells).toEqual(['Москва', 'Привет']);
    });

    it("Uzbek apostrophes o' and oʻ are preserved", () => {
      const s = sheet("a,b\nO'zbekiston,Oʻzbekiston\n");
      expect(s.rows[0]!.cells).toEqual(["O'zbekiston", 'Oʻzbekiston']);
    });

    it('emoji is preserved', () => {
      const s = sheet('a,b\n😀,✈️\n');
      expect(s.rows[0]!.cells).toEqual(['😀', '✈️']);
    });

    it('right-to-left text is preserved', () => {
      const s = sheet('a,b\nשלום,العربية\n');
      expect(s.rows[0]!.cells).toEqual(['שלום', 'العربية']);
    });

    it('mixed Unicode in a quoted cell with comma', () => {
      const s = sheet('a,b\n"Москва, город",2\n');
      expect(s.rows[0]!.cells).toEqual(['Москва, город', '2']);
    });
  });

  describe('performance', () => {
    it('parses a 5 MB file of one repeated row well under 3 s', () => {
      const row =
        'DXB-RIX-5-0314,Dubai,Rixos Premium Palm,5,5,BB,DBL,2026-03-14,Tashkent,820,USD,6,yes,Visa not included';
      const lines = [
        'Code,Destination,Hotel,Stars,Nights,Meal,Room,Departure date,Departure city,Price per person,Currency,Seats left,Flight included,Notes',
      ];
      for (let i = 0; i < 20_000; i += 1) lines.push(row);
      const big = lines.join('\n') + '\n';
      const start = Date.now();
      const s = sheet(big);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3000);
      expect(s.rows).toHaveLength(20_000);
    });
  });
});
