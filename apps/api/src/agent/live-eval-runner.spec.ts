import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usdToNano } from '../core/llm/pricing.js';
import { loadCases, scriptedProvider } from './testing/eval-runner.js';
import {
  buildReport,
  percentile,
  renderMarkdown,
  runEvaluation,
  type EvaluatedModel,
} from './testing/live-eval-runner.js';

const cases = loadCases(resolve(process.cwd(), '../../eval/cases'));
const scripted = (model: string): EvaluatedModel => ({
  provider: 'mock',
  model,
  providerFor: scriptedProvider,
});

describe('evaluation runner (scripted model only)', () => {
  it('compares models on the same cases and reports every metric', async () => {
    const subset = cases.filter((c) => c.locale === 'uz-Latn');
    const { runs, spentNano } = await runEvaluation({
      cases: subset,
      models: [scripted('model-a'), scripted('model-b')],
      budgetNano: usdToNano('1'),
      mode: 'scripted',
    });
    const report = buildReport({
      mode: 'scripted',
      runs,
      budgetNano: usdToNano('1'),
      spentNano,
      now: new Date('2026-10-23T00:00:00Z'),
    });
    expect(report.models.map((m) => `${m.provider}/${m.model}`)).toEqual([
      'mock/model-a',
      'mock/model-b',
    ]);
    const [a, b] = report.models;
    expect(a).toMatchObject({
      cases: subset.length,
      notRun: 0,
      passRate: { passed: subset.length, total: subset.length },
      hardFactViolations: 0,
    });
    expect(a.blockedFactViolations).toBeGreaterThan(0);
    expect(a.byLocale['uz-Latn'].total).toBe(subset.length);
    expect(Object.keys(a.byCategory)).toContain('apostrophe_variants');
    expect(a.toolCallValidity.total).toBeGreaterThan(0);
    // Planted invalid tool calls are counted as invalid, not hidden.
    expect(a.toolCallValidity.passed).toBeLessThan(a.toolCallValidity.total);
    expect(a.structuredOutputValidity.total).toBe(subset.length);
    expect(a.handoverCorrectness.total).toBeGreaterThan(0);
    expect(a.languageScriptMatch).toEqual({
      passed: subset.length,
      total: subset.length,
    });
    expect(Number(a.costUsd)).toBeGreaterThan(0);
    expect(b.passRate).toEqual(a.passRate);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('| mock | model-a |');
    expect(markdown).toContain('## mock / model-b');
  });

  it('stops before the run budget is exceeded and reports cases not run', async () => {
    const subset = cases.filter((c) => c.locale === 'en').slice(0, 6);
    const budgetNano = 3_000;
    const { runs, spentNano } = await runEvaluation({
      cases: subset,
      models: [scripted('tiny')],
      budgetNano,
      mode: 'scripted',
    });
    expect(spentNano).toBeLessThanOrEqual(budgetNano);
    expect(runs[0].notRun).toBeGreaterThan(0);
    expect(runs[0].outcomes.length + runs[0].notRun).toBe(subset.length);
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });
});

describe('live eval CLI guards (no network)', () => {
  const run = (env: Record<string, string>): ReturnType<typeof spawnSync> =>
    spawnSync('pnpm', ['exec', 'tsx', 'scripts/live-eval.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: '', LIVE_EVAL: '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('refuses to run without LIVE_EVAL=1', () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('opt-in');
  });

  it('refuses without a key and never echoes one', () => {
    const result = run({ LIVE_EVAL: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ANTHROPIC_API_KEY is required');
    const fake = 'placeholder-test-value-not-a-key-0000';
    const capped = run({
      LIVE_EVAL: '1',
      ANTHROPIC_API_KEY: fake,
      LIVE_EVAL_BUDGET_USD: '6',
    });
    expect(capped.status).toBe(1);
    expect(capped.stderr).toContain('at most 5');
    expect(`${capped.stdout}${capped.stderr}`).not.toContain(fake);
  });
});
