import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import {
  usdToNano,
  nanoToUsd,
  PRICING_SNAPSHOTS,
} from '../src/core/llm/pricing.js';
import { AnthropicLlmProvider } from '../src/llm/anthropic/anthropic-llm-provider.js';
import {
  loadCases,
  runCase,
  summarize,
  type EvalOutcome,
} from '../src/agent/testing/eval-runner.js';

/**
 * Opt-in live evaluation against the real provider (billable).
 *
 * Runs only with LIVE_EVAL=1 and ANTHROPIC_API_KEY, uses only the fictional
 * eval cases and MockConnector data, and stops before the total spend can
 * exceed LIVE_EVAL_BUDGET_USD (default $0.50, at most $5). Scripted model
 * outputs are ignored; only model-independent expectations are scored.
 * Never run in CI by default.
 */

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const PER_TURN_LIMIT_NANO = usdToNano('0.02');

async function main(): Promise<void> {
  if (process.env.LIVE_EVAL !== '1') {
    throw new Error(
      'Live evaluation is opt-in: set LIVE_EVAL=1 (it makes billable API calls).',
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error('ANTHROPIC_API_KEY is required for a live evaluation.');
  const budget = usdToNano(process.env.LIVE_EVAL_BUDGET_USD ?? '0.50');
  if (budget > usdToNano('5'))
    throw new Error('LIVE_EVAL_BUDGET_USD must not exceed 5.');
  const fast = process.env.LLM_FAST_MODEL ?? 'claude-haiku-5-5';
  const strong = process.env.LLM_STRONG_MODEL ?? fast;
  const pricing = PRICING_SNAPSHOTS['anthropic-2026-10-23'];
  for (const model of [fast, strong]) {
    if (!pricing.models[model])
      throw new Error(
        `Model ${model} has no price; refusing to run unbudgeted.`,
      );
  }

  const provider = new AnthropicLlmProvider({
    client: new Anthropic({ apiKey, maxRetries: 0 }),
    models: { FAST: fast, STRONG: strong },
    effort: 'low',
    requestTimeoutMs: 30_000,
    maxRetries: 2,
  });

  const filter = process.env.LIVE_EVAL_FILTER;
  const cases = loadCases(resolve(process.cwd(), '../../eval/cases')).filter(
    (evalCase) => evalCase.live && (!filter || evalCase.id.includes(filter)),
  );
  const outcomes: EvalOutcome[] = [];
  let spent = 0;
  for (const evalCase of cases) {
    // Each turn is itself capped at PER_TURN_LIMIT_NANO by the agent budget.
    if (spent + PER_TURN_LIMIT_NANO > budget) {
      process.stdout.write(
        `Stopping: budget reached after ${outcomes.length} cases.\n`,
      );
      break;
    }
    const outcome = await runCase(evalCase, provider, 'live');
    spent += outcome.costNano;
    outcomes.push(outcome);
    process.stdout.write(
      `${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.id} calls=${outcome.providerCalls} cost=$${nanoToUsd(outcome.costNano)}${
        outcome.failures.length ? ` :: ${outcome.failures.join('; ')}` : ''
      }\n`,
    );
  }
  const summary = summarize(outcomes);
  process.stdout.write(
    `${JSON.stringify({ models: { fast, strong }, ...summary, totalCostUsd: nanoToUsd(summary.totalCostNano) }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Live evaluation failed'}\n`,
  );
  process.exitCode = 1;
});
