import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentTurnResult } from '../core/agent/agent-turn.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LocaleRegistry } from '../core/locales/locale-pack.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { coverage } from './testing/eval-coverage.js';
import {
  inventedFacts,
  loadCases,
  runCase,
  scriptedProvider,
  successClaims,
  summarize,
  type EvalOutcome,
} from './testing/eval-runner.js';
import { loadLifecycleCases } from './testing/lifecycle-cases.js';

/** Reproducible CI artefacts under eval/reports (gitignored). */
function writeReport(name: string, data: unknown): void {
  const dir = resolve(process.cwd(), '../../eval/reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Deterministic agent evaluation over eval/cases (scripted model outputs).
 * This gates control logic: slot handling, tool authorization, budgets,
 * guardrails, locale/script and safe failure. It does not measure model
 * quality; that needs the opt-in live run (scripts/live-eval.ts).
 */
const cases = loadCases(resolve(process.cwd(), '../../eval/cases'));
const outcomes: EvalOutcome[] = [];

describe('agent evaluation suite (scripted)', () => {
  it('meets the Phase 7.2 coverage gate per pack, locale and risk group', () => {
    const lifecycle = loadLifecycleCases(
      resolve(process.cwd(), '../../eval/lifecycle'),
    );
    const report = coverage(
      [...cases, ...lifecycle],
      ['education', 'travel'],
      ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
    );
    writeReport('coverage.json', report);
    expect(report.gaps).toEqual([]);
  });

  it.each(cases.map((evalCase) => [evalCase.id, evalCase] as const))(
    '%s',
    async (_id, evalCase) => {
      const outcome = await runCase(evalCase);
      outcomes.push(outcome);
      expect(outcome.failures).toEqual([]);
    },
  );

  it('reports aggregate metrics; blocking: zero false success claims and invented facts', () => {
    const summary = summarize(outcomes);
    writeReport('scripted-summary.json', summary);
    console.log(
      `EVAL scripted: ${summary.passed}/${summary.total} passed, false success claims = ${summary.falseSuccessClaims}, invented facts = ${summary.hardFactViolations}`,
    );
    expect(summary.total).toBe(cases.length);
    expect(summary.passed).toBe(summary.total);
    expect(summary.falseSuccessClaims).toBe(0);
    expect(summary.hardFactViolations).toBe(0);
    expect(summary.avgProviderCalls).toBeLessThanOrEqual(6);
  });
});

describe('false-success-claim gate is sensitive (mutation test)', () => {
  // Remove the action-claim guardrail from every locale: the cases whose
  // model draft claims a completed action must now ship a claim, and the
  // gate must count it. If this ever passes with 0, the gate is blind.
  const blind = new LocaleRegistry(
    INITIAL_LOCALE_PACKS.map((pack) => ({ ...pack, actionClaimStems: [] })),
  );
  const claimCases = cases.filter((evalCase) =>
    evalCase.scripted.some(
      (step) =>
        step.kind === 'respond' &&
        typeof step.text === 'string' &&
        successClaims(step.text).length > 0,
    ),
  );

  it('has claim-drafting cases for both packs', () => {
    expect(new Set(claimCases.map((c) => c.pack))).toEqual(
      new Set(['education', 'travel']),
    );
  });

  it('catches every shipped claim once the guardrail is removed', async () => {
    let caught = 0;
    for (const evalCase of claimCases) {
      const outcome = await runCase(
        evalCase,
        scriptedProvider(evalCase),
        'scripted',
        { locales: blind },
      );
      caught += outcome.falseSuccessClaims;
    }
    expect(caught).toBeGreaterThanOrEqual(claimCases.length);
  });

  it('counts a claim in any locale and ignores honest wording', () => {
    expect(successClaims('Бронь подтверждена: Antalya 7 nights.')).not.toEqual(
      [],
    );
    expect(successClaims("Siz ro'yxatdan o'tdingiz.")).not.toEqual([]);
    expect(successClaims('Thank you, I am sending your request now.')).toEqual(
      [],
    );
    expect(
      successClaims('Your request has been recorded for our team.'),
    ).toEqual([]);
  });
});

describe('evaluation scorer', () => {
  it('flags digits that come from neither a fact nor the customer', () => {
    const reply = (
      text: string,
      facts: AgentTurnResult['facts'] = [],
    ): AgentTurnResult =>
      ({ reply: text, locale: 'en', facts }) as unknown as AgentTurnResult;
    expect(
      inventedFacts(reply('The course costs 120 dollars.'), 'How much?'),
    ).toEqual(['120']);
    expect(inventedFacts(reply('A group for age 16.'), 'My son is 16')).toEqual(
      [],
    );
    const price = {
      id: 'F1',
      value: {
        kind: 'price',
        money: { amount: '150.00', currency: 'USD' },
        confirmedQuote: true,
      },
      provenance: {
        tool: 'get_quote',
        connectorKey: 'mock',
        sourceSystem: 's',
        sourceEntityId: 'o',
        retrievedAt: '',
      },
    } as const;
    expect(inventedFacts(reply('It costs $150.', [price]), 'price?')).toEqual(
      [],
    );
    expect(
      inventedFacts(reply('It costs $150, or 140 for you.', [price]), 'price?'),
    ).toEqual(['140']);
  });
});
