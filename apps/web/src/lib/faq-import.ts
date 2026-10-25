/**
 * Parses an uploaded FAQ file in the browser (CSV, JSON or plain text); the
 * server only ever receives the validated entries. Nothing here trusts the
 * file: sizes and counts are bounded and every problem is reported by row.
 */
export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_IMPORT_ENTRIES = 500;

export interface ImportEntry {
  question: string;
  answer: string;
  language: string | null;
  regulated: boolean;
}

export type ProblemCode =
  | 'EMPTY_FILE'
  | 'TOO_BIG'
  | 'BAD_FORMAT'
  | 'MISSING_COLUMNS'
  | 'MISSING_TEXT'
  | 'QUESTION_TOO_SHORT'
  | 'QUESTION_TOO_LONG'
  | 'ANSWER_TOO_LONG'
  | 'TOO_MANY';

export interface ImportProblem {
  /** 1-based row, entry or block number; 0 for the whole file. */
  row: number;
  code: ProblemCode;
}

export interface ParsedImport {
  entries: ImportEntry[];
  problems: ImportProblem[];
}

export interface ImportLimits {
  question: number;
  answer: number;
}

const LANGUAGES = ['uz', 'ru', 'en'];
const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

function language(value: unknown): string | null {
  const id = clean(value).toLowerCase();
  return LANGUAGES.includes(id) ? id : null;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'ha', 'да'].includes(clean(value).toLowerCase());
}

/** Validates one candidate; returns the entry or the problem. */
function check(
  row: number,
  question: string,
  answer: string,
  extra: { language: string | null; regulated: boolean },
  limits: ImportLimits,
): ImportEntry | ImportProblem {
  if (!question || !answer) return { row, code: 'MISSING_TEXT' };
  if (question.length < 3) return { row, code: 'QUESTION_TOO_SHORT' };
  if (question.length > limits.question)
    return { row, code: 'QUESTION_TOO_LONG' };
  if (answer.length > limits.answer) return { row, code: 'ANSWER_TOO_LONG' };
  return { question, answer, ...extra };
}

function collect(
  candidates: {
    question: string;
    answer: string;
    language: string | null;
    regulated: boolean;
  }[],
  limits: ImportLimits,
): ParsedImport {
  const entries: ImportEntry[] = [];
  const problems: ImportProblem[] = [];
  candidates.forEach((candidate, index) => {
    if (index >= MAX_IMPORT_ENTRIES) {
      if (index === MAX_IMPORT_ENTRIES)
        problems.push({ row: index + 1, code: 'TOO_MANY' });
      return;
    }
    const result = check(
      index + 1,
      candidate.question,
      candidate.answer,
      { language: candidate.language, regulated: candidate.regulated },
      limits,
    );
    if ('code' in result) problems.push(result);
    else entries.push(result);
  });
  return { entries, problems };
}

/** RFC 4180 style: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS: Record<
  string,
  'question' | 'answer' | 'language' | 'regulated'
> = {
  question: 'question',
  savol: 'question',
  вопрос: 'question',
  answer: 'answer',
  javob: 'answer',
  ответ: 'answer',
  language: 'language',
  til: 'language',
  язык: 'language',
  regulated: 'regulated',
};

function fromCsv(text: string, limits: ImportLimits): ParsedImport {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const delimiter = [';', '\t', ','].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length
      ? candidate
      : best,
  );
  const rows = parseCsv(text, delimiter);
  const header = (rows.shift() ?? []).map(
    (name) => HEADERS[clean(name).toLowerCase()],
  );
  if (!header.includes('question') || !header.includes('answer'))
    return { entries: [], problems: [{ row: 0, code: 'MISSING_COLUMNS' }] };
  const at = (cells: string[], name: string): string =>
    cells[header.indexOf(name as (typeof header)[number])] ?? '';
  return collect(
    rows.map((cells) => ({
      question: clean(at(cells, 'question')),
      answer: clean(at(cells, 'answer')),
      language: language(at(cells, 'language')),
      regulated: truthy(at(cells, 'regulated')),
    })),
    limits,
  );
}

function fromJson(text: string, limits: ImportLimits): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { entries: [], problems: [{ row: 0, code: 'BAD_FORMAT' }] };
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && 'items' in data
      ? (data as { items: unknown }).items
      : undefined;
  if (!Array.isArray(list))
    return { entries: [], problems: [{ row: 0, code: 'BAD_FORMAT' }] };
  return collect(
    list.map((item: unknown) => {
      const o = (item && typeof item === 'object' ? item : {}) as Record<
        string,
        unknown
      >;
      return {
        question: clean(o.question),
        answer: clean(o.answer),
        language: language(o.language),
        regulated: truthy(o.regulated),
      };
    }),
    limits,
  );
}

const Q = /^\s*(?:q|question|savol|вопрос)\s*[:：]\s*/iu;
const A = /^\s*(?:a|answer|javob|ответ)\s*[:：]\s*/iu;

/** Blocks separated by blank lines, each "Q: …" then "A: …" (answers may span lines). */
function fromText(text: string, limits: ImportLimits): ParsedImport {
  const candidates: Parameters<typeof collect>[0] = [];
  for (const block of text.replace(/\r\n?/gu, '\n').split(/\n\s*\n/u)) {
    if (block.trim() === '') continue;
    let question = '';
    let answer = '';
    let target: 'q' | 'a' | null = null;
    for (const line of block.split('\n')) {
      if (Q.test(line)) {
        target = 'q';
        question = line.replace(Q, '');
      } else if (A.test(line)) {
        target = 'a';
        answer = line.replace(A, '');
      } else if (target === 'q') question += ` ${line}`;
      else if (target === 'a') answer += ` ${line}`;
    }
    candidates.push({
      question: clean(question),
      answer: clean(answer),
      language: null,
      regulated: false,
    });
  }
  if (candidates.length === 0)
    return { entries: [], problems: [{ row: 0, code: 'EMPTY_FILE' }] };
  return collect(candidates, limits);
}

export function parseFaqFile(
  fileName: string,
  text: string,
  limits: ImportLimits,
): ParsedImport {
  const body = text.replace(/^\uFEFF/u, '');
  if (body.trim() === '')
    return { entries: [], problems: [{ row: 0, code: 'EMPTY_FILE' }] };
  if (new Blob([body]).size > MAX_IMPORT_BYTES)
    return { entries: [], problems: [{ row: 0, code: 'TOO_BIG' }] };
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return fromJson(body, limits);
  if (lower.endsWith('.csv') || lower.endsWith('.tsv'))
    return fromCsv(body, limits);
  return fromText(body, limits);
}
