/**
 * Uzbek Latin <-> Cyrillic transliteration (official 1995 Latin alphabet)
 * and script-insensitive matching.
 *
 * Used for matching and for detecting the customer's script, never to
 * rewrite source facts: product names and other connector values are always
 * rendered exactly as the source returned them.
 */

const APOSTROPHES = /[’‘ʻʼ＇`´′ʹˈ]/gu;
const VOWELS_CYRL = new Set('аеёиоуўэюя'.split(''));

const CYRL_TO_LATN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'x',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  ъ: "'",
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: "o'",
  қ: 'q',
  ғ: "g'",
  ҳ: 'h',
  ы: 'i',
  щ: 'sh',
};

/** Unifies the apostrophe variants customers type (o‘, oʻ, o’, o`). */
export function unifyApostrophes(value: string): string {
  return value.normalize('NFKC').replace(APOSTROPHES, "'");
}

/**
 * Updated Uzbek Latin letters (as supplied for this project: Ğ ğ, Ö ö, Ş ş,
 * Ç ç) -> the legacy digraph spelling used internally (g', o', sh, ch).
 * One-way and idempotent on purpose: the reverse (sh -> ş) is ambiguous for
 * s+h sequences, so it is never applied. Input is matched in NFC; the
 * customer's original text is not modified by callers.
 */
const UPDATED_TO_LEGACY: Readonly<Record<string, readonly [string, string]>> = {
  ğ: ["g'", "G'"],
  ö: ["o'", "O'"],
  ş: ['sh', 'Sh'],
  ç: ['ch', 'Ch'],
};

export function updatedLatnToLegacy(input: string): string {
  const text = input.normalize('NFC');
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const lower = char.toLowerCase();
    const mapped = UPDATED_TO_LEGACY[lower];
    if (mapped === undefined) {
      out += char;
      continue;
    }
    if (char === lower) {
      out += mapped[0];
      continue;
    }
    // Capital letter: "Ş" -> "Sh", but inside an all-caps word "ŞAHAR" -> "SHAHAR".
    const next = text[index + 1];
    const prev = text[index - 1];
    const capsWord =
      (next !== undefined &&
        next === next.toUpperCase() &&
        /\p{L}/u.test(next)) ||
      (prev !== undefined &&
        prev === prev.toUpperCase() &&
        /\p{L}/u.test(prev));
    out += capsWord ? mapped[0].toUpperCase() : mapped[1];
  }
  return out;
}

export type UzbekOrthography =
  | 'cyrillic'
  | 'latin-updated'
  | 'latin-legacy'
  | 'latin-mixed'
  | 'latin-neutral'
  | 'none';

/**
 * Writing style of a message, independent of language and of the language
 * the customer wants answers in. `latin-neutral` means Latin text without any
 * style-specific letter (plain "salom" is the same in both Latin styles).
 */
export function uzbekOrthography(input: string): UzbekOrthography {
  const text = unifyApostrophes(input).normalize('NFC');
  const cyrillic = text.match(/[\u0400-\u04ff]/gu)?.length ?? 0;
  const latin =
    text.match(/[A-Za-z\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f]/gu)
      ?.length ?? 0;
  if (cyrillic + latin === 0) return 'none';
  if (cyrillic >= latin) return 'cyrillic';
  const updated = /[ğöşç]/iu.test(text);
  const legacy = /[go]'/iu.test(text);
  if (updated && legacy) return 'latin-mixed';
  if (updated) return 'latin-updated';
  if (legacy) return 'latin-legacy';
  return 'latin-neutral';
}

function matchCase(source: string, target: string): string {
  if (target.length === 0) return target;
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return target.length > 1 && source.length === 1
      ? target[0].toUpperCase() + target.slice(1)
      : target.toUpperCase();
  }
  return target;
}

/** Uzbek Cyrillic -> Latin. Non-Uzbek characters pass through unchanged. */
export function uzCyrlToLatn(input: string): string {
  const text = input.normalize('NFC');
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const lower = char.toLowerCase();
    if (lower === 'е') {
      // "е" is "ye" at the start of a word and after a vowel or ъ/ь.
      const prev = text[index - 1]?.toLowerCase();
      const wordStart = prev === undefined || !/\p{L}/u.test(prev);
      const afterVowel =
        prev !== undefined &&
        (VOWELS_CYRL.has(prev) || prev === 'ъ' || prev === 'ь');
      out += matchCase(char, wordStart || afterVowel ? 'ye' : 'e');
      continue;
    }
    const mapped = CYRL_TO_LATN[lower];
    out += mapped === undefined ? char : matchCase(char, mapped);
  }
  return out;
}

const LATN_DIGRAPHS: ReadonlyArray<readonly [string, string]> = [
  ["o'", 'ў'],
  ["g'", 'ғ'],
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['yo', 'ё'],
  ['yu', 'ю'],
  ['ya', 'я'],
];

const LATN_TO_CYRL: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'б',
  d: 'д',
  f: 'ф',
  g: 'г',
  h: 'ҳ',
  i: 'и',
  j: 'ж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'қ',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  x: 'х',
  y: 'й',
  z: 'з',
};

/** Uzbek Latin -> Cyrillic. Characters outside the alphabet pass through. */
export function uzLatnToCyrl(input: string): string {
  const text = unifyApostrophes(input);
  let out = '';
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index).toLowerCase();
    const prev = text[index - 1]?.toLowerCase();
    const wordStart = prev === undefined || !/[\p{L}']/u.test(prev);

    // "yo'" is y + oʻ (йў, as in yo'l), not the "yo" digraph + apostrophe.
    if (rest.startsWith("yo'")) {
      out += matchCase(text[index], 'й');
      index += 1;
      continue;
    }
    const digraph = LATN_DIGRAPHS.find(([latin]) => rest.startsWith(latin));
    if (digraph) {
      out += matchCase(text[index], digraph[1]);
      index += digraph[0].length;
      continue;
    }
    if (rest.startsWith('ye') && wordStart) {
      out += matchCase(text[index], 'е');
      index += 2;
      continue;
    }
    const char = text[index];
    const lower = char.toLowerCase();
    if (lower === 'e') {
      out += matchCase(char, wordStart ? 'э' : 'е');
    } else if (char === "'") {
      // Tutuq belgisi between letters is the hard sign, after a vowel
      // (ma'lumot -> маълумот) and after a consonant (san'at -> санъат).
      // A quote at a word edge is punctuation and passes through.
      const next = text[index + 1];
      out +=
        prev !== undefined &&
        /\p{L}/u.test(prev) &&
        next !== undefined &&
        /\p{L}/u.test(next)
          ? 'ъ'
          : char;
    } else {
      const mapped = LATN_TO_CYRL[lower];
      out += mapped === undefined ? char : matchCase(char, mapped);
    }
    index += 1;
  }
  return out;
}

/**
 * Script-insensitive matching key: unified apostrophes, Cyrillic folded to
 * Uzbek Latin, lower case, collapsed whitespace. "Онлайн", "onlayn" and
 * "ONLAYN" share one key.
 */
export function normalizeForMatching(value: string): string {
  return uzCyrlToLatn(updatedLatnToLegacy(unifyApostrophes(value)))
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}
