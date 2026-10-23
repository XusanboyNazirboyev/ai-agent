import { unifyApostrophes } from '@agentcore/shared';
import type {
  LanguageCode,
  LocaleId,
  LocaleRegistry,
  ScriptCode,
} from '../locales/locale-pack.js';

/**
 * Deterministic language + script detection (D17). Script is measured from
 * letters; language is scored from marker letters and common words. Short or
 * mixed messages get low confidence so the caller can keep the conversation's
 * locale or use the model's detection instead of guessing.
 */

export interface LanguageDetection {
  readonly language: LanguageCode | 'unknown';
  readonly script: ScriptCode | 'unknown';
  readonly confidence: number;
}

const WORDS: Readonly<Record<LanguageCode, ReadonlySet<string>>> = {
  uz: new Set([
    'salom',
    'assalomu',
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
  ]),
};

const LATIN = /[a-z]/giu;
const CYRILLIC = /[\u0400-\u04ff]/giu;

export function detectLanguage(input: string): LanguageDetection {
  const text = unifyApostrophes(input).toLowerCase();
  const latin = text.match(LATIN)?.length ?? 0;
  const cyrillic = text.match(CYRILLIC)?.length ?? 0;
  if (latin + cyrillic === 0)
    return { language: 'unknown', script: 'unknown', confidence: 0 };
  const script: ScriptCode = cyrillic >= latin ? 'Cyrl' : 'Latn';
  const scriptShare = Math.max(latin, cyrillic) / (latin + cyrillic);

  const score: Record<LanguageCode, number> = { uz: 0, ru: 0, en: 0 };
  const words = text.split(/[^\p{L}']+/u).filter(Boolean);
  for (const word of words) {
    for (const language of ['uz', 'ru', 'en'] as const) {
      if (WORDS[language].has(word)) score[language] += 2;
    }
  }
  // Marker letters: Uzbek-only Cyrillic letters, oʻ/gʻ in Latin, and
  // Russian-only letters.
  score.uz += (text.match(/[ўқғҳ]/gu)?.length ?? 0) * 2;
  score.uz += (text.match(/[og]'/gu)?.length ?? 0) * 2;
  score.uz += Math.min(text.match(/q/gu)?.length ?? 0, 3);
  score.ru += (text.match(/[ыщ]/gu)?.length ?? 0) * 2;
  if (script === 'Latn') score.ru = Math.max(0, score.ru - 1);
  if (script === 'Cyrl') score.en = 0;

  const ranked = (['uz', 'ru', 'en'] as const)
    .map((language) => ({ language, value: score[language] }))
    .sort((a, b) => b.value - a.value);
  const [top, second] = ranked;
  if (top.value === 0)
    return { language: 'unknown', script, confidence: 0.2 * scriptShare };

  const margin = (top.value - second.value) / (top.value + 2);
  const lengthFactor = Math.min(1, words.length / 3);
  return {
    language: top.language,
    script,
    confidence:
      Math.round(
        Math.min(1, margin * scriptShare * (0.5 + 0.5 * lengthFactor) * 1.4) *
          1000,
      ) / 1000,
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
