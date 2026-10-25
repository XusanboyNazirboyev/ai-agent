import {
  unifyApostrophes,
  updatedLatnToLegacy,
  uzbekOrthography,
  type UzbekOrthography,
} from '@agentcore/shared';
import type {
  LanguageCode,
  LocaleId,
  LocaleRegistry,
  ScriptCode,
} from '../locales/locale-pack.js';

/**
 * Deterministic language + script detection (D17). Script is measured from
 * letters; language is scored from common words (lexical evidence) and marker
 * letters (weak evidence). Short, mixed or word-less messages get low
 * confidence so the caller can keep the conversation's locale, ask, or use the
 * model's detection instead of guessing.
 *
 * Empirical status: the word lists and every threshold are HEURISTIC. They
 * have been checked only against the fixtures in this repository (eval cases
 * and unit tests), not against real customer text, and the score is not a
 * calibrated probability.
 */

export interface LanguageDetection {
  readonly language: LanguageCode | 'unknown';
  readonly script: ScriptCode | 'unknown';
  /**
   * Heuristic score in [0,1]. Not a calibrated probability: it is compared
   * only against thresholds in a `LanguagePolicy`.
   */
  readonly confidence: number;
  /** True when Latin and Cyrillic letters are mixed in one message. */
  readonly mixedScript?: boolean;
  /**
   * Writing style (legacy / updated Latin, Cyrillic). Descriptive only: it is
   * neither language evidence nor the language the customer wants answers in.
   */
  readonly orthography?: UzbekOrthography;
}

const WORDS: Readonly<Record<LanguageCode, ReadonlySet<string>>> = {
  uz: new Set([
    'salom',
    'assalomu',
    'mening',
    'sizning',
    'bugun',
    'ertaga',
    'soat',
    'manzil',
    'qayerga',
    'alaykum',
    'kerak',
    'qancha',
    'narxi',
    'narx',
    'bormi',
    'bor',
    'menga',
    'uchun',
    'haqida',
    'qanday',
    'rahmat',
    'iltimos',
    'yaxshi',
    'ha',
    "yo'q",
    'xohlayman',
    'qilmoqchiman',
    'bormi',
    'nima',
    'edi',
    'mumkinmi',
    'qachon',
    'qayerda',
    'nechpul',
    'bilan',
    'va',
    'ham',
    'emas',
    'kerakmi',
    'sizda',
    'qaysi',
    'necha',
    'салом',
    'ассалому',
    'менинг',
    'сизнинг',
    'бугун',
    'эртага',
    'соат',
    'манзил',
    'қаерга',
    'алайкум',
    'керак',
    'қанча',
    'нархи',
    'борми',
    'менга',
    'учун',
    'ҳақида',
    'қандай',
    'раҳмат',
    'илтимос',
    'яхши',
    'ҳа',
    'йўқ',
    'хоҳлайман',
    'эди',
    'мумкинми',
    'қачон',
    'билан',
    'ва',
    'ҳам',
    'эмас',
    'сизда',
    'қайси',
    'нима',
  ]),
  ru: new Set([
    'здравствуйте',
    'привет',
    'добрый',
    'нужен',
    'нужна',
    'нужно',
    'сколько',
    'стоит',
    'хочу',
    'можно',
    'есть',
    'какой',
    'какие',
    'цена',
    'стоимость',
    'спасибо',
    'пожалуйста',
    'да',
    'нет',
    'когда',
    'где',
    'для',
    'на',
    'по',
    'мне',
    'это',
    'или',
    'хотел',
    'хотела',
    'подскажите',
    'у',
    'вас',
    'nujen',
    'skolko',
    'privet',
  ]),
  en: new Set([
    'hello',
    'hi',
    'need',
    'price',
    'how',
    'much',
    'want',
    'please',
    'the',
    'is',
    'i',
    'available',
    'what',
    'when',
    'thanks',
    'thank',
    'yes',
    'no',
    'for',
    'and',
    'can',
    'do',
    'you',
    'have',
    'cost',
    'an',
    'a',
    'my',
    'me',
    'would',
    'like',
    // Common function words (Phase 7.2 eval: "Which documents are required
    // to travel ...?" was not recognised as English). None is an Uzbek or
    // transliterated Russian word.
    'which',
    'are',
    'of',
    'with',
    'there',
    'any',
    'does',
    'will',
    'should',
    'required',
  ]),
};

const LATIN = /[a-z]/giu;
const CYRILLIC = /[\u0400-\u04ff]/giu;

/** All-caps Latin tokens (acronyms, product codes) say nothing about script. */
const ACRONYM = /\b[A-Z][A-Z0-9]{1,9}\b/gu;
/** Below this share of one script a message is mixed, not a script choice. */
const MIXED_SCRIPT_SHARE = 0.75;
const MIXED_SCRIPT_MAX_CONFIDENCE = 0.45;
/** Highest confidence for a guess with no recognised word behind it. */
const LEXICAL_REQUIRED_CAP = 0.25;
/** Highest confidence when words of two languages are present. */
const CONTRADICTION_CAP = 0.4;

export function detectLanguage(input: string): LanguageDetection {
  // Updated-Latin letters (ğ ö ş ç) are folded to the legacy digraphs once,
  // so word lists and script counts see one spelling. The input itself is
  // never modified for anything that is stored or shown.
  const folded = updatedLatnToLegacy(unifyApostrophes(input));
  const orthography = uzbekOrthography(input);
  const text = folded.toLowerCase();
  // Acronyms say nothing about script, but a message typed entirely in
  // capitals is text, not acronyms.
  const scriptText = /\p{Ll}/u.test(folded)
    ? folded.replace(ACRONYM, ' ')
    : folded;
  const latin = scriptText.match(LATIN)?.length ?? 0;
  const cyrillic = scriptText.match(CYRILLIC)?.length ?? 0;
  if (latin + cyrillic === 0)
    return {
      language: 'unknown',
      script: 'unknown',
      confidence: 0,
      orthography,
    };
  const script: ScriptCode = cyrillic >= latin ? 'Cyrl' : 'Latn';
  const scriptShare = Math.max(latin, cyrillic) / (latin + cyrillic);

  // Two kinds of evidence, kept apart. A recognised word is lexical evidence.
  // A marker letter is weak: single letters occur in noise, names and codes
  // ("xqzv"), so markers can raise a score but never carry a classification
  // on their own (see LEXICAL_REQUIRED_CAP below).
  const score: Record<LanguageCode, number> = { uz: 0, ru: 0, en: 0 };
  const lexical: Record<LanguageCode, number> = { uz: 0, ru: 0, en: 0 };
  const words = text.split(/[^\p{L}']+/u).filter(Boolean);
  for (const word of words) {
    // A single letter ("a", "i", "у") is not evidence of any language.
    if (word.length < 2) continue;
    for (const language of ['uz', 'ru', 'en'] as const) {
      if (WORDS[language].has(word)) {
        score[language] += 2;
        lexical[language] += 1;
      }
    }
  }
  // Marker letters: Uzbek-only Cyrillic letters, oʻ/gʻ in Latin, "q", and
  // Russian-only letters. One point each, with small caps.
  score.uz += Math.min(text.match(/[ўқғҳ]/gu)?.length ?? 0, 3);
  score.uz += Math.min(text.match(/[og]'/gu)?.length ?? 0, 2);
  score.uz += Math.min(text.match(/q/gu)?.length ?? 0, 1);
  score.ru += Math.min(text.match(/[ыщ]/gu)?.length ?? 0, 2);
  if (script === 'Latn') score.ru = Math.max(0, score.ru - 1);
  if (script === 'Cyrl') score.en = 0;

  const ranked = (['uz', 'ru', 'en'] as const)
    .map((language) => ({ language, value: score[language] }))
    .sort((a, b) => b.value - a.value);
  const [top, second] = ranked;
  if (top.value === 0)
    return {
      language: 'unknown',
      script,
      confidence: 0.2 * scriptShare,
      mixedScript: scriptShare < MIXED_SCRIPT_SHARE,
      orthography,
    };

  const margin = (top.value - second.value) / (top.value + 2);
  const lengthFactor = Math.min(1, words.length / 3);
  const raw = Math.min(
    1,
    margin * scriptShare * (0.5 + 0.5 * lengthFactor) * 1.4,
  );
  // A message mixing Latin and Cyrillic never switches the conversation's
  // script on its own (addendum §3.10: conservative on uncertain script).
  const mixedCapped =
    scriptShare < MIXED_SCRIPT_SHARE
      ? Math.min(raw, MIXED_SCRIPT_MAX_CONFIDENCE)
      : raw;
  // Without a single recognised word of the top language the guess rests on
  // marker letters only, which is too weak to classify text.
  // Recognised words of a second language contradict the top guess: the
  // message may be mixed-language, so it cannot reach the high-confidence
  // range (the caller then keeps the conversation's language or asks).
  const lexicalCapped =
    lexical[top.language] === 0
      ? Math.min(mixedCapped, LEXICAL_REQUIRED_CAP)
      : mixedCapped;
  const capped =
    lexical[second.language] > 0
      ? Math.min(lexicalCapped, CONTRADICTION_CAP)
      : lexicalCapped;
  return {
    language: top.language,
    script,
    confidence: Math.round(capped * 1000) / 1000,
    mixedScript: scriptShare < MIXED_SCRIPT_SHARE,
    orthography,
  };
}

/** Confidence at which a message may switch the conversation's locale. */
export const LOCALE_SWITCH_CONFIDENCE = 0.6;

/**
 * Picks the reply locale: switch only when the customer clearly writes in
 * another supported language/script; otherwise keep the conversation's
 * locale so the bot does not flip scripts on short messages ("ok", a name).
 */
export function chooseLocale(
  detection: LanguageDetection,
  options: {
    readonly current: LocaleId | undefined;
    readonly supported: readonly LocaleId[];
    readonly fallback: LocaleId;
    readonly registry: LocaleRegistry;
  },
): LocaleId {
  if (
    detection.confidence >= LOCALE_SWITCH_CONFIDENCE &&
    detection.language !== 'unknown' &&
    detection.script !== 'unknown'
  ) {
    const match = options.registry.find(detection.language, detection.script);
    if (match && options.supported.includes(match.id)) return match.id;
  }
  return options.current && options.supported.includes(options.current)
    ? options.current
    : options.fallback;
}
