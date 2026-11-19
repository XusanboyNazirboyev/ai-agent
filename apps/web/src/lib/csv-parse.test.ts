import { describe, expect, it } from 'vitest';
import { detectColumns, parseCsv } from './csv-parse';

describe('parseCsv', () => {
  it('reads plain comma separated rows with LF and CRLF', () => {
    const a = parseCsv('name,phone\nAli,1\nBek,2\n');
    expect(a.headers).toEqual(['name', 'phone']);
    expect(a.rows).toEqual([
      ['Ali', '1'],
      ['Bek', '2'],
    ]);
    expect(parseCsv('name,phone\r\nAli,1\r\nBek,2').rows).toHaveLength(2);
  });

  it('keeps delimiters, escaped quotes and line breaks inside quotes', () => {
    const p = parseCsv('name,note\n"Ali, Jr","say ""hi""\nnext"\n');
    expect(p.rows).toEqual([['Ali, Jr', 'say "hi"\nnext']]);
  });

  it('strips a BOM and drops blank lines', () => {
    const p = parseCsv('﻿name,phone\n\n,\nAli,1\n\n');
    expect(p.headers).toEqual(['name', 'phone']);
    expect(p.rows).toEqual([['Ali', '1']]);
  });

  it('detects semicolon and tab from the header line', () => {
    expect(parseCsv('name;phone\nAli;1').delimiter).toBe(';');
    expect(parseCsv('name\tphone\nAli\t1').rows).toEqual([['Ali', '1']]);
    expect(parseCsv('"a,b,c";phone\nx;y').delimiter).toBe(';');
  });

  it('keeps empty cells and a last row without a line break', () => {
    expect(parseCsv('a,b,c\n1,,3').rows).toEqual([['1', '', '3']]);
  });

  it('returns no headers for an empty file', () => {
    expect(parseCsv('')).toMatchObject({ headers: [], rows: [] });
  });
});

describe('detectColumns', () => {
  it('maps English, Uzbek and Russian headers case-insensitively', () => {
    expect(
      detectColumns(['Full Name', 'TELEFON', 'Manba', 'Izoh']),
    ).toMatchObject({ name: 0, phone: 1, source: 2, note: 3, amount: -1 });
    expect(
      detectColumns([
        'ФИО',
        'Телефон',
        'Источник',
        'Сумма',
        'Валюта',
        'Комментарий',
      ]),
    ).toEqual({
      name: 0,
      phone: 1,
      source: 2,
      amount: 3,
      currency: 4,
      note: 5,
    });
    expect(detectColumns(['F.I.O.', 'номер'])).toMatchObject({
      name: 0,
      phone: 1,
    });
  });

  it('uses each header once and the first match per field', () => {
    expect(detectColumns(['name', 'client', 'x'])).toMatchObject({
      name: 0,
      phone: -1,
    });
  });
});
