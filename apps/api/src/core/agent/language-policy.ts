import type {
  LocaleId,
  LocaleRegistry,
  LocaleStatus,
} from '../locales/locale-pack.js';
import { unifyApostrophes } from '@agentcore/shared';
import { detectLanguage } from './language.js';
import type { HistoryEntry } from './prompts.js';

/**
 * Language confidence policy (Stage C, ADR 013; D17, D18). Enforced in code
 * before any metered model call (hard stops) and again before commercial
 * facts are looked up (sufficiency). The detector is a lexical heuristic,
 * not a calibrated model: its score is compared only with the configurable
 * thresholds below and is reported as `calibrated: false`.
 */

export interface LanguagePolicy {
  /** Score from which a message identifies its locale, by locale status. */
  readonly highConfidence: Readonly<Record<LocaleStatus, number>>;
  /** Score from which a message is a weak (MEDIUM) signal. */
  readonly mediumConfidence: number;
  /** Consecutive unclear customer turns that end in escalation. */
  readonly maxUnclearTurns: number;
  /**
   * Whether the extraction model's own language/script call may confirm a
   * weak or absent heuristic signal (never a contradicting one), by locale
   * status. Set `beta: false` to require the customer's own text.
   */
  readonly modelCorroboration: Readonly<Record<LocaleStatus, boolean>>;
}

export const DEFAULT_LANGUAGE_POLICY: LanguagePolicy = {
  // Beta locales need a stricter score than stable ones; `planned` locales
  // are never selectable, so their threshold is unreachable.
  highConfidence: { stable: 0.4, beta: 0.45, planned: 1.01 },
  mediumConfidence: 0.3,
  maxUnclearTurns: 2,
  modelCorroboration: { stable: true, beta: true, planned: false },
};

export type ConfidenceClass = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type Ambiguity =
  | 'NONE'
  | 'UNSUPPORTED_SCRIPT'
  | 'MIXED_SCRIPT'
  | 'UNRECOGNIZED'
  | 'NO_LETTERS';

export interface LanguageAssessment {
  readonly language: 'uz' | 'ru' | 'en' | 'unknown';
  readonly script: 'Latn' | 'Cyrl' | 'unknown';
  /** Supported locale this message identifies, if any. */
  readonly localeId: LocaleId | undefined;
  readonly localeStatus: LocaleStatus | undefined;
  readonly score: number;
  readonly confidenceClass: ConfidenceClass;
  readonly ambiguity: Ambiguity;
  readonly method: 'lexical-heuristic';
  readonly calibrated: false;
}

const LATIN_OR_CYRILLIC = /[A-Za-zЀ-ӿ]/gu;
const ANY_LETTER = /\p{L}/gu;

export function assessLanguage(
  text: string,
  registry: LocaleRegistry,
  policy: LanguagePolicy = DEFAULT_LANGUAGE_POLICY,
): LanguageAssessment {
  const detection = detectLanguage(text);
  const letters = text.match(ANY_LETTER)?.length ?? 0;
  const known = text.match(LATIN_OR_CYRILLIC)?.length ?? 0;
  const base = {
    method: 'lexical-heuristic',
    calibrated: false,
    score: detection.confidence,
  } as const;
  if (letters === 0) {
    return {
      ...base,
      language: 'unknown',
      script: 'unknown',
      localeId: undefined,
      localeStatus: undefined,
      confidenceClass: 'NONE',
      ambiguity: 'NO_LETTERS',
    };
  }
  if (letters - known > known) {
    return {
      ...base,
      language: 'unknown',
      script: 'unknown',
      localeId: undefined,
      localeStatus: undefined,
      confidenceClass: 'NONE',
      ambiguity: 'UNSUPPORTED_SCRIPT',
    };
  }
  const pack =
    detection.language !== 'unknown' && detection.script !== 'unknown'
      ? registry.find(detection.language, detection.script)
      : undefined;
  const mixed = detection.mixedScript === true;
  const confidenceClass: ConfidenceClass =
    pack && !mixed && detection.confidence >= policy.highConfidence[pack.status]
      ? 'HIGH'
      : pack && detection.confidence >= policy.mediumConfidence
        ? 'MEDIUM'
        : detection.confidence > 0
          ? 'LOW'
          : 'NONE';
  return {
    ...base,
    language: detection.language,
    script: detection.script,
    localeId: pack?.id,
    localeStatus: pack?.status,
    confidenceClass,
    ambiguity: mixed
      ? 'MIXED_SCRIPT'
      : confidenceClass === 'HIGH' || confidenceClass === 'MEDIUM'
        ? 'NONE'
        : 'UNRECOGNIZED',
  };
}

/**
 * Locale a message explicitly asks to be answered in, from the locale
 * packs' request phrases. Two different matches are ambiguous: no request.
 */
export function requestedLocale(
  text: string,
  registry: LocaleRegistry,
  supported: readonly LocaleId[],
): LocaleId | undefined {
  const haystack = unifyApostrophes(text).toLowerCase();
  const matches = new Set<LocaleId>();
  for (const pack of registry.all()) {
    if (!supported.includes(pack.id)) continue;
    if (
      pack.languageRequestPhrases.some((phrase) =>
        haystack.includes(unifyApostrophes(phrase).toLowerCase()),
      )
    )
      matches.add(pack.id);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

export interface LanguageHistory {
  /**
   * Locale the customer asked for explicitly. It outranks detection until
   * they ask for another one.
   */
  readonly pinned?: LocaleId;
  /** Locale the customer clearly wrote in earlier (latest such message). */
  readonly established: LocaleId | undefined;
  /** Trailing customer turns that were unclear. */
  readonly unclearStreak: number;
}

/** A turn that gave no usable language signal. */
function isUnclear(
  assessment: LanguageAssessment,
  established: LocaleId | undefined,
): boolean {
  switch (assessment.ambiguity) {
    case 'UNSUPPORTED_SCRIPT':
      return true;
    case 'NO_LETTERS':
      return false; // emoji, digits: neutral
    case 'NONE':
      return false;
    default:
      // Short or mixed text is fine inside an established conversation.
      return established === undefined;
  }
}

/** Replays the customer's earlier messages; no state is persisted. */
export function languageHistory(
  history: readonly HistoryEntry[],
  registry: LocaleRegistry,
  policy: LanguagePolicy = DEFAULT_LANGUAGE_POLICY,
  supported: readonly LocaleId[] = registry.all().map((pack) => pack.id),
): LanguageHistory {
  let established: LocaleId | undefined;
  let pinned: LocaleId | undefined;
  let unclearStreak = 0;
  for (const entry of history) {
    if (entry.role !== 'customer') continue;
    const asked = requestedLocale(entry.text, registry, supported);
    if (asked) {
      // Which language to ANSWER in. It says nothing about which language
      // the customer's own text is in, so it does not establish anything.
      pinned = asked;
      continue;
    }
    const assessment = assessLanguage(entry.text, registry, policy);
    if (assessment.confidenceClass === 'HIGH' && assessment.localeId) {
      established = assessment.localeId;
      unclearStreak = 0;
    } else if (isUnclear(assessment, established)) {
      unclearStreak += 1;
    }
  }
  return { established, unclearStreak, ...(pinned ? { pinned } : {}) };
}

export type LanguageDecision =
  | { readonly action: 'PROCEED' }
  | {
      readonly action: 'CLARIFY' | 'ESCALATE';
      readonly reasonCodes: readonly string[];
    };

function unclearDecision(
  history: LanguageHistory,
  policy: LanguagePolicy,
  reasonCodes: readonly string[],
): LanguageDecision {
  return {
    action:
      history.unclearStreak + 1 >= policy.maxUnclearTurns
        ? 'ESCALATE'
        : 'CLARIFY',
    reasonCodes,
  };
}

/**
 * Hard stop before any model call: text in a script we do not serve. The
 * customer is asked once to write in a supported language; the next unclear
 * turn escalates.
 */
export function decideBeforeModel(
  assessment: LanguageAssessment,
  history: LanguageHistory,
  policy: LanguagePolicy = DEFAULT_LANGUAGE_POLICY,
): LanguageDecision {
  return assessment.ambiguity === 'UNSUPPORTED_SCRIPT'
    ? unclearDecision(history, policy, ['UNSUPPORTED_SCRIPT'])
    : { action: 'PROCEED' };
}

/**
 * Before commercial facts are looked up the reply locale must be backed by
 * evidence: this message is HIGH for it, the customer clearly wrote in it
 * earlier, or the extraction model independently names it while the
 * heuristic does not contradict it (policy.modelCorroboration). A mixed-script
 * message never rests on the model's word.
 */
export function decideBeforeFacts(
  assessment: LanguageAssessment,
  history: LanguageHistory,
  replyLocale: LocaleId,
  registry: LocaleRegistry,
  modelLocale: LocaleId | undefined,
  policy: LanguagePolicy = DEFAULT_LANGUAGE_POLICY,
): LanguageDecision {
  if (assessment.ambiguity === 'UNSUPPORTED_SCRIPT')
    return unclearDecision(history, policy, ['UNSUPPORTED_SCRIPT']);
  if (
    assessment.confidenceClass === 'HIGH' &&
    assessment.localeId === replyLocale
  )
    return { action: 'PROCEED' };
  if (history.pinned === replyLocale) {
    // The reply language was requested, so it proves nothing about the
    // customer's own text. That text must be understood on its own evidence:
    // clear now, clear earlier, or independently named by the model while
    // the heuristic does not contradict it.
    const clearNow =
      assessment.confidenceClass === 'HIGH' &&
      assessment.localeId !== undefined;
    const corroborated =
      modelLocale !== undefined &&
      policy.modelCorroboration[registry.get(modelLocale).status] &&
      assessment.ambiguity !== 'MIXED_SCRIPT' &&
      (assessment.localeId === undefined ||
        assessment.localeId === modelLocale);
    if (clearNow || history.established !== undefined || corroborated)
      return { action: 'PROCEED' };
    return unclearDecision(
      history,
      policy,
      assessment.ambiguity === 'NONE'
        ? ['LOW_CONFIDENCE', assessment.confidenceClass]
        : [assessment.ambiguity],
    );
  }
  if (history.established === replyLocale) return { action: 'PROCEED' };
  if (
    modelLocale === replyLocale &&
    policy.modelCorroboration[registry.get(replyLocale).status] &&
    assessment.ambiguity !== 'MIXED_SCRIPT' &&
    (assessment.localeId === undefined || assessment.localeId === replyLocale)
  )
    return { action: 'PROCEED' };
  return unclearDecision(
    history,
    policy,
    assessment.ambiguity === 'NONE'
      ? ['LOW_CONFIDENCE', assessment.confidenceClass]
      : [assessment.ambiguity],
  );
}
