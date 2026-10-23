import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentTurnResult } from '../core/agent/agent-turn.js';
import {
  inventedFacts,
  loadCases,
  runCase,
  summarize,
  type EvalOutcome,
} from './testing/eval-runner.js';

/**
 * Deterministic agent evaluation over eval/cases (scripted model outputs).
 * This gates control logic: slot handling, tool authorization, budgets,
 * guardrails, locale/script and safe failure. It does not measure model
 * quality; that needs the opt-in live run (scripts/live-eval.ts).
 */
const cases = loadCases(resolve(process.cwd(), '../../eval/cases'));
const outcomes: EvalOutcome[] = [];

describe('agent evaluation suite (scripted)', () => {
  it('covers every launch locale with the same categories', () => {
    const byLocale = new Map<string, Set<string>>();
    for (const evalCase of cases) {
      const set = byLocale.get(evalCase.locale) ?? new Set<string>();
      set.add(evalCase.category);
      byLocale.set(evalCase.locale, set);
    }
    expect([...byLocale.keys()].sort()).toEqual([
      'en',
      'ru',
      'uz-Cyrl',
      'uz-Latn',
    ]);
    const categories = [...byLocale.values()].map((set) =>
      [...set].sort().join(','),
    );
    expect(new Set(categories).size).toBe(1);
  });

  it.each(cases.map((evalCase) => [evalCase.id, evalCase] as const))(
    '%s',
    async (_id, evalCase) => {
      const outcome = await runCase(evalCase);
      outcomes.push(outcome);
      expect(outcome.failures).toEqual([]);
    },
  );

  it('reports aggregate metrics', () => {
    const summary = summarize(outcomes);
    expect(summary.total).toBe(cases.length);
    expect(summary.passed).toBe(summary.total);
    expect(summary.avgProviderCalls).toBeLessThanOrEqual(6);
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
