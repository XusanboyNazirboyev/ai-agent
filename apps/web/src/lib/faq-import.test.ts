import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ENTRIES, parseCsv, parseFaqFile } from './faq-import';

const limits = { question: 200, answer: 600 };

describe('FAQ file parsing', () => {
  it('reads CSV with quotes, newlines, a BOM, semicolons and localized headers', () => {
    const csv =
      '\uFEFFquestion,answer,language,regulated\r\n' +
      '"How long, exactly?","Three months,\ntwo evenings a week.",en,\r\n' +
      'Where?,"She said ""Tashkent""",uz,yes\r\n';
    const parsed = parseFaqFile('faq.csv', csv, limits);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        question: 'How long, exactly?',
        answer: 'Three months, two evenings a week.',
        language: 'en',
        regulated: false,
      },
      {
        question: 'Where?',
        answer: 'She said "Tashkent"',
        language: 'uz',
        regulated: true,
      },
    ]);
    const semi = parseFaqFile(
      'x.csv',
      'Savol;Javob\nNarxi qancha?;100 ming',
      limits,
    );
    expect(semi.entries).toHaveLength(1);
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reports a missing header, missing text and over-long fields by row', () => {
    expect(parseFaqFile('x.csv', 'foo,bar\n1,2', limits).problems).toEqual([
      { row: 0, code: 'MISSING_COLUMNS' },
    ]);
    const parsed = parseFaqFile(
      'x.csv',
      `question,answer\nok question,fine\nonly question,\nab,short\n${'q'.repeat(201)},a\nfine one,${'a'.repeat(601)}`,
      limits,
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.problems).toEqual([
      { row: 2, code: 'MISSING_TEXT' },
      { row: 3, code: 'QUESTION_TOO_SHORT' },
      { row: 4, code: 'QUESTION_TOO_LONG' },
      { row: 5, code: 'ANSWER_TOO_LONG' },
    ]);
  });

  it('reads JSON arrays and { items }, and refuses anything else', () => {
    const list = [{ question: 'Is it free?', answer: 'No.', language: 'xx' }];
    expect(
      parseFaqFile('a.json', JSON.stringify(list), limits).entries,
    ).toEqual([
      {
        question: 'Is it free?',
        answer: 'No.',
        language: null,
        regulated: false,
      },
    ]);
    expect(
      parseFaqFile('a.json', JSON.stringify({ items: list }), limits).entries,
    ).toHaveLength(1);
    expect(parseFaqFile('a.json', '{"a":1}', limits).problems).toEqual([
      { row: 0, code: 'BAD_FORMAT' },
    ]);
    expect(parseFaqFile('a.json', 'not json', limits).problems).toEqual([
      { row: 0, code: 'BAD_FORMAT' },
    ]);
  });

  it('reads Q:/A: text blocks in several languages with multi-line answers', () => {
    const text =
      'Q: When do classes start?\nA: In September,\nevery year.\n\nSavol: Narxi?\nJavob: 100 ming\n\nВопрос: Где?\nОтвет: В Ташкенте';
    const parsed = parseFaqFile('faq.txt', text, limits);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => e.answer)).toEqual([
      'In September, every year.',
      '100 ming',
      'В Ташкенте',
    ]);
  });

  it('bounds the file: empty, too big and too many entries', () => {
    expect(parseFaqFile('a.txt', '  \n ', limits).problems[0].code).toBe(
      'EMPTY_FILE',
    );
    expect(
      parseFaqFile('a.txt', 'x'.repeat(600 * 1024), limits).problems[0].code,
    ).toBe('TOO_BIG');
    const many = Array.from(
      { length: MAX_IMPORT_ENTRIES + 3 },
      (_, i) => `Q: Question number ${i}\nA: Answer ${i}`,
    ).join('\n\n');
    const parsed = parseFaqFile('a.txt', many, limits);
    expect(parsed.entries).toHaveLength(MAX_IMPORT_ENTRIES);
    expect(parsed.problems).toEqual([
      { row: MAX_IMPORT_ENTRIES + 1, code: 'TOO_MANY' },
    ]);
  });
});
