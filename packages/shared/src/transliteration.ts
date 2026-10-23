/**
 * Uzbek Latin <-> Cyrillic transliteration (official 1995 Latin alphabet)
 * and script-insensitive matching.
 *
 * Used for matching and for detecting the customer's script, never to
 * rewrite source facts: product names and other connector values are always
 * rendered exactly as the source returned them.
 */

const APOSTROPHES = /[’‘ʻʼ＇`´]/gu;
const VOWELS_CYRL = new Set('аеёиоуўэюя'.split(''));
const VOWELS_LATN = new Set('aeiou'.split(''));

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
      // Tutuq belgisi after a vowel is the hard sign.
      out += prev !== undefined && VOWELS_LATN.has(prev) ? 'ъ' : char;
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
  return uzCyrlToLatn(unifyApostrophes(value))
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}
