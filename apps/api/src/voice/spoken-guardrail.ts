/**
 * Guardrail for one spoken sentence of a voice turn (ADR 045 slice 3,
 * step 2). Every sentence is checked and rendered before it is spoken, so a
 * violation is never heard; what was already spoken passed this check.
 *
 * It is the text guardrail (`checkDraft`: fact references rendered by code,
 * no digits or currency the customer did not say, forbidden and action
 * claims, prompt-leak markers, script and language) plus what a voice reply
 * adds, seen live on a fast model on 2026-11-09:
 * - UNSOURCED_CONTACT: an invented handle, link or e-mail address (digits of
 *   a phone number are already UNSOURCED_NUMBER);
 * - UNSOURCED_SPOKEN_FACT: numbers or dates spelled out in words, which a
 *   spoken reply would otherwise use to slip past the digit check;
 * - PROMPT_LEAK: the reply repeats a run of words from the system prompt.
 * Words the customer said themselves are allowed (an echo is not a claim).
 */
import { unifyApostrophes } from '@agentcore/shared';
import {
  checkDraft,
  type GuardrailViolation,
} from '../core/agent/guardrails.js';
import type { EvidenceContext } from '../core/agent/display-gate.js';
import { FACT_REFERENCE, type FactStore } from '../core/agent/facts.js';
import type { LocalePack } from '../core/locales/locale-pack.js';

export type SpokenViolation =
  GuardrailViolation | 'UNSOURCED_CONTACT' | 'UNSOURCED_SPOKEN_FACT';

export interface SpokenCheckContext {
  readonly facts: FactStore;
  readonly locale: LocalePack;
  /** Everything the caller said in this call (echoes are allowed). */
  readonly customerTexts: readonly string[];
  readonly timeZone: string;
  readonly now: Date;
  readonly evidence: Omit<EvidenceContext, 'now'>;
  /** The system prompt of the turn, to catch a reply that repeats it. */
  readonly systemPrompt: string;
}

export interface SpokenCheckResult {
  readonly violations: readonly SpokenViolation[];
  /** The sentence to speak, present only when there are no violations. */
  readonly rendered?: string;
}

const CONTACT =
  /(?:^|[\s(])@[\p{L}\p{N}_.]{3,}|https?:\/\/|\bwww\.|\bt\.me\b|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\b[\p{L}\p{N}-]+\.(?:uz|ru|com|org|net|io|me)\b/iu;

/** Words of an exact number; one small one alone ("bir daqiqa") is fine. */
const NUMBER_WORDS: Readonly<Record<string, readonly string[]>> = {
  uz: [
    'nol',
    'bir',
    'ikki',
    'uch',
    'toʻrt',
    'besh',
    'olti',
    'yetti',
    'sakkiz',
    'toʻqqiz',
    'oʻn',
    'yigirma',
    'oʻttiz',
    'qirq',
    'ellik',
    'oltmish',
    'yetmish',
    'sakson',
    'toʻqson',
    'yuz',
    'ming',
    'million',
    'milliard',
    'ноль',
    'бир',
    'икки',
    'уч',
    'тўрт',
    'беш',
    'олти',
    'етти',
    'саккиз',
    'тўққиз',
    'ўн',
    'йигирма',
    'ўттиз',
    'қирқ',
    'эллик',
    'олтмиш',
    'етмиш',
    'саксон',
    'тўқсон',
    'юз',
    'минг',
    'миллион',
    'миллиард',
  ],
  ru: [
    'ноль',
    'один',
    'одна',
    'одно',
    'два',
    'две',
    'три',
    'четыре',
    'пять',
    'шесть',
    'семь',
    'восемь',
    'девять',
    'десять',
    'одиннадцать',
    'двенадцать',
    'тринадцать',
    'четырнадцать',
    'пятнадцать',
    'шестнадцать',
    'семнадцать',
    'восемнадцать',
    'девятнадцать',
    'двадцать',
    'тридцать',
    'сорок',
    'пятьдесят',
    'шестьдесят',
    'семьдесят',
    'восемьдесят',
    'девяносто',
    'сто',
    'двести',
    'триста',
    'четыреста',
    'пятьсот',
    'тысяча',
    'тысячи',
    'тысяч',
    'миллион',
    'миллиона',
    'миллионов',
    'первого',
    'второго',
    'третьего',
    'пятого',
    'десятого',
    'двадцатого',
  ],
  en: [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fifteen',
    'twenty',
    'thirty',
    'forty',
    'fifty',
    'sixty',
    'seventy',
    'eighty',
    'ninety',
    'hundred',
    'thousand',
    'million',
    'billion',
    'first',
    'second',
    'third',
  ],
};
/** A magnitude word is a number claim even alone ("ming", "тысяч"). */
const MAGNITUDE = new Set([
  'yuz',
  'ming',
  'million',
  'milliard',
  'юз',
  'минг',
  'миллион',
  'миллиард',
  'сто',
  'двести',
  'триста',
  'пятьсот',
  'тысяча',
  'тысячи',
  'тысяч',
  'миллиона',
  'миллионов',
  'hundred',
  'thousand',
  'million',
  'billion',
]);
/** Month names (not "may"/"май"/"mart"-like words that are also verbs). */
const MONTHS =
  /^(?:yanvar|fevral|aprel|iyun|iyul|avgust|sentabr|oktabr|noyabr|dekabr|январ|феврал|апрел|июн|июл|август|сентябр|октябр|ноябр|декабр|january|february|april|june|july|august|september|october|november|december)/u;
/** Uzbek suffixes stripped before matching a number word ("beshinchi", "uchga"). */
const UZ_SUFFIX =
  /(?:inchi|nchi|инчи|нчи)?(?:ta|ga|da|dan|gacha|lik|та|га|да|дан|гача|лик)?$/u;

function words(text: string): string[] {
  return unifyApostrophes(text)
    .toLowerCase()
    .replace(/[‘’'`ʼ]/gu, 'ʻ')
    .split(/[^\p{L}ʻ]+/u)
    .filter(Boolean);
}

function numberWord(word: string, language: string): boolean {
  const list = NUMBER_WORDS[language] ?? [];
  if (list.includes(word)) return true;
  return language === 'uz' && list.includes(word.replace(UZ_SUFFIX, ''));
}

/** True when the sentence states a number or date in words of its own. */
function spokenFact(
  sentence: string,
  language: string,
  echoed: ReadonlySet<string>,
): boolean {
  // An echo may carry another suffix ("noyabr" said, "noyabrni" replied).
  const isEcho = (word: string): boolean =>
    echoed.has(word) ||
    [...echoed].some(
      (said) =>
        said.length >= 4 && (word.startsWith(said) || said.startsWith(word)),
    );
  const own = words(sentence).filter((word) => !isEcho(word));
  let run = 0;
  for (const word of own) {
    if (MONTHS.test(word)) return true;
    const bare = language === 'uz' ? word.replace(UZ_SUFFIX, '') : word;
    if (MAGNITUDE.has(word) || MAGNITUDE.has(bare)) return true;
    run = numberWord(word, language) ? run + 1 : 0;
    if (run >= 2) return true;
    // An ordinal is a date or position claim ("beshinchi", "первого").
    if (
      numberWord(word, language) &&
      (/(?:inchi|nchi|инчи|нчи)$/u.test(word) ||
        (language !== 'uz' && /(?:ого|ое|first|second|third)$/u.test(word)))
    )
      return true;
  }
  return false;
}

/** A run of this many words copied from the system prompt is a leak. */
const LEAK_RUN = 5;

function repeatsPrompt(sentence: string, systemPrompt: string): boolean {
  const prompt = words(systemPrompt);
  if (prompt.length < LEAK_RUN) return false;
  const runs = new Set<string>();
  for (let i = 0; i + LEAK_RUN <= prompt.length; i++)
    runs.add(prompt.slice(i, i + LEAK_RUN).join(' '));
  const own = words(sentence);
  for (let i = 0; i + LEAK_RUN <= own.length; i++)
    if (runs.has(own.slice(i, i + LEAK_RUN).join(' '))) return true;
  return false;
}

export function checkSpokenSentence(
  sentence: string,
  context: SpokenCheckContext,
): SpokenCheckResult {
  const base = checkDraft(sentence, context);
  const violations = new Set<SpokenViolation>(base.violations);
  // Only what the model wrote itself; rendered facts come from code.
  const own = sentence.replace(FACT_REFERENCE, ' ');
  const echoed = new Set(context.customerTexts.flatMap(words));
  if (CONTACT.test(own)) violations.add('UNSOURCED_CONTACT');
  if (spokenFact(own, context.locale.language, echoed))
    violations.add('UNSOURCED_SPOKEN_FACT');
  if (repeatsPrompt(own, context.systemPrompt)) violations.add('PROMPT_LEAK');
  if (violations.size > 0) return { violations: [...violations] };
  return {
    violations: [],
    ...(base.rendered ? { rendered: base.rendered } : {}),
  };
}
