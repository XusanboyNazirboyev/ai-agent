/**
 * Reading single cells of a price list (ADR 064 decision 4). Nothing is
 * guessed: a value that cannot be read with confidence returns `null` and the
 * row is rejected with a reason, never stored with a made-up number.
 */

/** Currencies a tenant price list may use (ISO 4217; fixed list on purpose). */
export const SHEET_CURRENCIES = [
  'UZS',
  'USD',
  'EUR',
  'RUB',
  'KZT',
  'TRY',
  'AED',
  'GBP',
  'CNY',
  'EGP',
  'THB',
  'GEL',
  'KGS',
  'TJS',
] as const;
export type SheetCurrency = (typeof SHEET_CURRENCIES)[number];

const SYMBOLS: ReadonlyArray<readonly [RegExp, SheetCurrency]> = [
  [/\$/u, 'USD'],
  [/€/u, 'EUR'],
  [/£/u, 'GBP'],
  [/₽/u, 'RUB'],
  [/₺/u, 'TRY'],
  [/(?<![\p{L}])(?:сум|сўм|som|so['’ʻʼ]?m|soum)(?![\p{L}])/iu, 'UZS'],
];

/** `USD`, `usd`, `$` and `у.е.` style hints in a currency cell. */
export function parseCurrency(text: string): SheetCurrency | null {
  const value = text.trim();
  if (value === '') return null;
  const code = value.toUpperCase();
  if ((SHEET_CURRENCIES as readonly string[]).includes(code))
    return code as SheetCurrency;
  for (const [pattern, currency] of SYMBOLS)
    if (pattern.test(value)) return currency;
  return null;
}

/** A currency hint written inside the price cell (`$ 820`, `820 USD`). */
export function currencyInAmountCell(text: string): SheetCurrency | null {
  const letters = /[A-Za-z]{3}/u.exec(text)?.[0];
  const fromCode = letters ? parseCurrency(letters) : null;
  return fromCode ?? parseCurrency(text.replace(/[\d\s.,]/gu, ''));
}

const MAX_AMOUNT = 1_000_000_000;

/**
 * A positive decimal string with at most two decimals, or `null`.
 * Accepts `820`, `1 240`, `1,250.50`, `1.250,50`, `710,5`, `$ 820`.
 * A single separator followed by exactly three digits is read as thousands
 * (`1,250` and `1.250` are 1250), the usual meaning in a tour price.
 */
export function parseAmount(text: string): string | null {
  // Currency hints ($, EUR, сум) may sit around the number; any other letter
  // or sign makes the cell unreadable (`1e5` must not become 15).
  const cleaned = text
    .replace(/[$€£₽₺]/gu, '')
    .replace(/(?<![\p{L}])[A-Za-z]{3}(?![\p{L}])/gu, (word) =>
      parseCurrency(word) === null ? word : '',
    )
    .replace(/(?<![\p{L}])(?:сум|сўм|so['’ʻʼ]?m|soum)(?![\p{L}])/giu, '')
    .replace(/[\u00a0\u202f\s]/gu, '');
  if (!/^[\d.,]+$/u.test(cleaned)) return null;
  let value = cleaned;
  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');
  let decimal = '';
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the one that comes last is the decimal separator.
    const decimalChar = lastDot > lastComma ? '.' : ',';
    const thousandChar = decimalChar === '.' ? ',' : '.';
    const [whole, fraction = '', ...rest] = value.split(decimalChar);
    if (rest.length > 0) return null;
    value = whole!.split(thousandChar).join('');
    decimal = fraction;
    if (
      whole!
        .split(thousandChar)
        .some((part, index) => (index > 0 ? part.length !== 3 : part === ''))
    )
      return null;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? '.' : ',';
    const parts = value.split(separator);
    const last = parts[parts.length - 1]!;
    const groups = parts.slice(1);
    const thousands =
      groups.length >= 1 &&
      groups.every((part) => part.length === 3) &&
      parts[0]!.length >= 1 &&
      parts[0]!.length <= 3;
    if (thousands) value = parts.join('');
    else if (parts.length === 2) {
      value = parts[0]!;
      decimal = last;
    } else return null;
  }
  if (!/^\d+$/u.test(value) || (decimal !== '' && !/^\d{1,2}$/u.test(decimal)))
    return null;
  const normalized = decimal === '' ? value : `${value}.${decimal}`;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_AMOUNT)
    return null;
  return decimal === '' ? String(Number(value)) : `${Number(value)}.${decimal}`;
}

/** A whole number of 0 or more, or `null` (`6`, `6 seats` is not accepted). */
export function parseCount(text: string): number | null {
  const value = text.replace(/[\u00a0\s]/gu, '');
  if (!/^\d{1,6}$/u.test(value)) return null;
  return Number(value);
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1)
    return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * `YYYY-MM-DD` or `null`. Accepts `2026-03-14`, `14.03.2026`, `14/03/2026`,
 * `14-03-2026` (day first, as in the region); an impossible date is `null`.
 */
export function parseDate(text: string): string | null {
  const value = text.trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(value);
  const dayFirst = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/u.exec(value);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = Number(dayFirst[2]);
    year = Number(dayFirst[3]);
  } else return null;
  if (!isRealDate(year, month, day)) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Adds days to a `YYYY-MM-DD` date (used for the end of a stay). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const result = new Date(Date.UTC(y, m - 1, d + days));
  return result.toISOString().slice(0, 10);
}

const MEALS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'UAI',
    ['uai', 'ultraallinclusive', 'ультравсёвключено', 'ультравсевключено'],
  ],
  [
    'AI',
    [
      'ai',
      'allinclusive',
      'всёвключено',
      'всевключено',
      'hammasikiritilgan',
      'hammasidavlat',
    ],
  ],
  ['FB', ['fb', 'fullboard', 'полныйпансион', 'toliqpansion', 'tolapansion']],
  ['HB', ['hb', 'halfboard', 'полупансион', 'yarimpansion']],
  [
    'BB',
    ['bb', 'bedandbreakfast', 'breakfast', 'завтрак', 'завтраки', 'nonushta'],
  ],
  ['RO', ['ro', 'ob', 'roomonly', 'nomeals', 'безпитания', 'ovqatsiz']],
];

function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_/.'’`ʻʼ]/gu, '')
    .replace(/ё/gu, 'е');
}

/** A meal-plan code (BB, HB, FB, AI, UAI, RO) or the trimmed text as written. */
export function normalizeMeal(text: string): string {
  const key = squash(text);
  for (const [code, names] of MEALS)
    if (names.some((name) => squash(name) === key)) return code;
  return text.trim();
}

const ROOMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['SGL', ['sgl', 'single', 'одноместный', 'бирокикарли', 'singleroom']],
  [
    'DBL',
    ['dbl', 'double', 'twin', 'двухместный', 'ikkikishilik', 'doubleroom'],
  ],
  [
    'TRPL',
    ['trpl', 'trp', 'triple', 'трехместный', 'трёхместный', 'uchkishilik'],
  ],
];

/** A room code (SGL, DBL, TRPL) or the trimmed text as written. */
export function normalizeRoom(text: string): string {
  const key = squash(text);
  for (const [code, names] of ROOMS)
    if (names.some((name) => squash(name) === key)) return code;
  return text.trim();
}

/** `yes`, `no` and their ru and uz forms; anything else is `null`. */
export function parseYesNo(text: string): boolean | null {
  const key = squash(text);
  if (['yes', 'y', 'true', '1', 'да', 'ha', 'bor', '+'].includes(key))
    return true;
  if (['no', 'n', 'false', '0', 'нет', 'yoq', 'yoʼq', '-'].includes(key))
    return false;
  return null;
}
