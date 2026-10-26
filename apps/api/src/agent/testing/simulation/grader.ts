import { allFixtures } from '../../../connectors/mock/mock-fixtures.js';
import { detectLanguage } from '../../../core/agent/language.js';
import { INITIAL_LOCALE_PACKS } from '../../../locales/locale-packs.js';
import { successClaims } from '../eval-runner.js';
import type { Scenario, SimLanguage } from './scenario.js';
import type { WorldState } from './world.js';

/**
 * Deterministic grading of one simulated conversation (no model involved).
 * Every check reads database state or applies a documented text rule; the
 * LLM judge is separate and never gates until calibrated.
 */
export interface RunMetrics {
  /** Numbers (>= 2 digits) in business replies that nothing explains. */
  readonly inventedFacts: readonly string[];
  /** Business replies that claim a completed action without connector evidence. */
  readonly falseSuccessClaims: number;
  /** Titles of another tenant's catalog found in business replies. */
  readonly crossTenantLeaks: readonly string[];
  /** Undefined when the scenario sets no handover expectation. */
  readonly handoverCorrect?: boolean;
  /** Replies checked / replies in the expected language and script. */
  readonly languageChecked: number;
  readonly languageMatched: number;
  readonly goalCompleted: boolean;
  /** Undefined when the scenario sets no final slots. */
  readonly slotsCorrect?: boolean;
  readonly repliesChecked: number;
  readonly repliesWithOneQuestionOrLess: number;
  /** Customer turn after which a lead first existed (undefined: never). */
  readonly turnsToLead?: number;
  readonly latenciesMs: readonly number[];
  readonly agentCostNano: bigint;
  readonly agentInputTokens: number;
  readonly agentOutputTokens: number;
  readonly agentLlmCalls: number;
  /** Every handover reason opened during the run (for provider-failure triage). */
  readonly handoverReasons: readonly string[];
  /** Per-turn failure codes (e.g. TURN_TIMEOUT), for infrastructure triage. */
  readonly turnFailureCodes: readonly (string | null)[];
}

export interface GradeInput {
  readonly scenario: Scenario;
  readonly language: SimLanguage;
  readonly state: WorldState;
  readonly customerTexts: readonly string[];
  readonly turnsToLead?: number;
}

/**
 * Number tokens in canonical form: thousands separators dropped, decimals cut
 * to the integer part, no leading zeros ("1 200" -> 1200, "150.00" -> 150,
 * "2026-11-02" -> 2026, 11, 2).
 */
export function numberTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\d+(?:[ ,.\u00a0]\d{3})*(?:[.,]\d+)?/gu)) {
    const raw = match[0];
    const grouped = /^\d{1,3}(?:[ ,.\u00a0]\d{3})+$/u.test(raw);
    const integer = grouped
      ? raw.replace(/[ ,.\u00a0]/gu, '')
      : raw.split(/[.,]/u)[0];
    out.push(String(Number(integer)));
  }
  return out;
}

/** Tokens plus every digit run on its own: the permissive form for allowed values. */
function allNumberForms(text: string): string[] {
  return [
    ...numberTokens(text),
    ...text
      .split(/[^0-9]+/u)
      .filter(Boolean)
      .map((part) => String(Number(part))),
  ];
}

function allowedNumbers(input: GradeInput): Set<string> {
  const allowed = new Set<string>();
  for (let n = 0; n <= 10; n += 1) allowed.add(String(n)); // ordinals, small counts
  const sources = [
    JSON.stringify(allFixtures(input.state.source)),
    ...input.customerTexts,
    input.state.contactPhone ?? '',
    input.scenario.setup.contact.phone ?? '',
    JSON.stringify(
      INITIAL_LOCALE_PACKS.find((pack) => pack.id === input.language)
        ?.templates ?? {},
    ),
  ];
  for (const source of sources)
    for (const n of allNumberForms(source)) allowed.add(n);
  // Phone numbers are often regrouped (+998 90 123 45 67).
  for (const phone of [
    input.state.contactPhone,
    input.scenario.setup.contact.phone,
  ]) {
    const digits = (phone ?? '').replace(/\D/gu, '');
    for (let i = 0; i < digits.length; i += 1)
      for (let j = i + 2; j <= digits.length; j += 1)
        allowed.add(String(Number(digits.slice(i, j))));
  }
  return allowed;
}

const OTHER_TITLES = (source: string): string[] =>
  ['mock-education', 'mock-tourism']
    .filter((other) => other !== source)
    .flatMap((other) => allFixtures(other).map((item) => item.title));

function scriptOf(text: string): 'Latn' | 'Cyrl' | 'none' {
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (latin + cyrillic < 8) return 'none';
  return cyrillic > latin ? 'Cyrl' : 'Latn';
}

/** Expected language base and script of the customer's language. */
export function expectedLanguage(language: SimLanguage): {
  base: string;
  script: 'Latn' | 'Cyrl';
} {
  if (language === 'uz-Latn') return { base: 'uz', script: 'Latn' };
  if (language === 'uz-Cyrl') return { base: 'uz', script: 'Cyrl' };
  if (language === 'ru') return { base: 'ru', script: 'Cyrl' };
  return { base: 'en', script: 'Latn' };
}

export function gradeRun(input: GradeInput): RunMetrics {
  const { scenario, state } = input;
  const replies = state.messages
    .filter((m) => m.direction === 'OUTBOUND' && m.authorType === 'BOT')
    .map((m) => m.text);
  const allowed = allowedNumbers(input);
  const inventedFacts = replies.flatMap((text) =>
    numberTokens(text).filter((n) => n.length >= 2 && !allowed.has(n)),
  );
  const evidence = state.proposals.some(
    (p) => p.status === 'SUCCEEDED' && p.externalId,
  );
  const falseSuccessClaims = evidence
    ? 0
    : replies.filter((text) => successClaims(text).length > 0).length;
  const titles = OTHER_TITLES(state.source);
  const crossTenantLeaks = replies.flatMap((text) =>
    titles.filter((title) => text.toLowerCase().includes(title.toLowerCase())),
  );

  const expect = scenario.expect;
  const handoverCorrect = expect.handoverReason
    ? state.handoverReasons.includes(expect.handoverReason)
    : expect.noHandover
      ? state.handoverReasons.length === 0
      : undefined;

  const target = expectedLanguage(input.language);
  let languageChecked = 0;
  let languageMatched = 0;
  for (const text of replies) {
    const script = scriptOf(text);
    if (script === 'none' || text.replace(/[\d\s\p{P}\p{S}]/gu, '').length < 12)
      continue;
    languageChecked += 1;
    const detected = detectLanguage(text);
    const languageOk =
      detected.language === 'unknown' || detected.language === target.base;
    if (languageOk && script === target.script) languageMatched += 1;
  }

  const shown = state.shownItems;
  const wanted = expect.shownItems;
  const goalCompleted = ((): boolean => {
    switch (expect.outcome) {
      case 'recommend':
        return wanted.length
          ? shown.some((id) => wanted.includes(id))
          : shown.length > 0;
      case 'alternatives':
        return (
          shown.length > 0 &&
          (wanted.length === 0 || shown.some((id) => wanted.includes(id)))
        );
      case 'lead':
        return (
          (state.leadCreated && state.contactPhone !== null) ||
          state.proposals.some((p) => p.status === 'SUCCEEDED')
        );
      case 'proposal_confirmed':
        return state.proposals.some((p) =>
          ['CONFIRMED', 'SUCCEEDED'].includes(p.status),
        );
      case 'proposal_declined':
        return state.proposals.some((p) => p.status === 'DECLINED');
      case 'handover':
        return (
          expect.handoverReason !== undefined &&
          state.handoverReasons.includes(expect.handoverReason)
        );
      case 'answer':
        return (
          state.handoverReasons.length === 0 &&
          state.turns.some((t) => t.outcome === 'ANSWERED')
        );
      case 'follow_up':
        return state.followUps > 0;
    }
  })();

  const finalSlots = Object.entries(expect.finalSlots);
  const slotsCorrect = finalSlots.length
    ? finalSlots.every(([key, value]) => {
        const actual = state.slots[key];
        if (value === null)
          return actual === undefined || actual === null || actual === '';
        return (
          String(actual ?? '').toLowerCase() === String(value).toLowerCase()
        );
      })
    : undefined;

  const questions = replies.map((text) => (text.match(/[?？]/gu) ?? []).length);
  return {
    inventedFacts,
    falseSuccessClaims,
    crossTenantLeaks,
    handoverCorrect,
    languageChecked,
    languageMatched,
    goalCompleted,
    slotsCorrect,
    repliesChecked: replies.length,
    repliesWithOneQuestionOrLess: questions.filter((q) => q <= 1).length,
    turnsToLead: input.turnsToLead,
    latenciesMs: state.turns
      .map((t) => t.latencyMs)
      .filter((v): v is number => v !== null),
    agentCostNano: state.turns.reduce((sum, t) => sum + t.costNano, 0n),
    agentInputTokens: state.turns.reduce((sum, t) => sum + t.inputTokens, 0),
    agentOutputTokens: state.turns.reduce((sum, t) => sum + t.outputTokens, 0),
    agentLlmCalls: state.turns.reduce((sum, t) => sum + t.llmCalls, 0),
    handoverReasons: state.handoverReasons,
    turnFailureCodes: state.turns.map((t) => t.failureCode),
  };
}

/** Handover reasons that mean the model provider failed, not the agent. */
export const PROVIDER_FAILURE_REASONS = ['LLM_UNAVAILABLE', 'BUDGET_EXCEEDED'];

export function providerFailed(metrics: RunMetrics): boolean {
  return metrics.handoverReasons.some((r) =>
    PROVIDER_FAILURE_REASONS.includes(r),
  );
}

/** True when the run satisfies every blocking per-run condition. */
export function runPasses(metrics: RunMetrics): boolean {
  return (
    metrics.inventedFacts.length === 0 &&
    metrics.falseSuccessClaims === 0 &&
    metrics.crossTenantLeaks.length === 0 &&
    metrics.handoverCorrect !== false &&
    metrics.languageMatched === metrics.languageChecked &&
    metrics.goalCompleted
  );
}
