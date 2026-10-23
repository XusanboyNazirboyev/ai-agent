import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { pricingFor, usdToNano } from '../src/core/llm/pricing.js';
import { AnthropicLlmProvider } from '../src/llm/anthropic/anthropic-llm-provider.js';
import { PRICING_CATALOG } from '../src/llm/pricing-catalog.js';
import { loadCases } from '../src/agent/testing/eval-runner.js';
import {
  buildReport,
  renderMarkdown,
  runEvaluation,
  type EvaluatedModel,
} from '../src/agent/testing/live-eval-runner.js';

/**
 * Opt-in live evaluation against the real provider (billable).
 *
 *   LIVE_EVAL=1 pnpm --filter @agentcore/api eval:live
 *
 * - Credentials come from the environment only: `.env.local` (gitignored)
 *   or `.env` at the repository root, or the shell. The key is never
 *   printed, logged or written to the report.
 * - LIVE_EVAL_BUDGET_USD (default 0.50, at most 5) caps the whole run and
 *   is checked before every model call.
 * - LIVE_EVAL_MODELS=a,b compares models (each serves both tiers); without
 *   it, LLM_FAST_MODEL / LLM_STRONG_MODEL are evaluated as configured.
 * - LIVE_EVAL_FILTER limits cases by id substring.
 * - Reports go to LIVE_EVAL_REPORT_DIR (default eval/reports, gitignored).
 * Only fictional eval cases and MockConnector data are used. Never in CI.
 */

const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });

const MAX_BUDGET = usdToNano('5');

async function main(): Promise<void> {
  if (process.env.LIVE_EVAL !== '1') {
    throw new Error(
      'Live evaluation is opt-in: set LIVE_EVAL=1 (it makes billable API calls).',
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error(
      'ANTHROPIC_API_KEY is required (set it in .env.local; it is never printed).',
    );
  const budgetNano = usdToNano(process.env.LIVE_EVAL_BUDGET_USD ?? '0.50');
  if (budgetNano > MAX_BUDGET || budgetNano <= 0)
    throw new Error(
      'LIVE_EVAL_BUDGET_USD must be greater than 0 and at most 5.',
    );

  const pricing = PRICING_CATALOG.snapshot(
    process.env.LLM_PRICING_VERSION ?? 'anthropic-2026-10-23',
  );
  const fast = process.env.LLM_FAST_MODEL ?? 'claude-haiku-5-5';
  const strong = process.env.LLM_STRONG_MODEL ?? fast;
  const configurations: Array<{ fast: string; strong: string }> = process.env
    .LIVE_EVAL_MODELS
    ? process.env.LIVE_EVAL_MODELS.split(',')
        .map((model) => model.trim())
        .filter(Boolean)
        .map((model) => ({ fast: model, strong: model }))
    : [{ fast, strong }];
  for (const configuration of configurations)
    for (const model of [configuration.fast, configuration.strong])
      pricingFor(pricing, model); // throws for an unpriced model

  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const models: EvaluatedModel[] = configurations.map((configuration) => {
    const provider = new AnthropicLlmProvider({
      client,
      models: { FAST: configuration.fast, STRONG: configuration.strong },
      effort: 'low',
      requestTimeoutMs: 30_000,
      maxRetries: 2,
    });
    return {
      provider: provider.providerId,
      model:
        configuration.fast === configuration.strong
          ? configuration.fast
          : `${configuration.fast} / ${configuration.strong}`,
      providerFor: () => provider,
    };
  });

  const filter = process.env.LIVE_EVAL_FILTER;
  const cases = loadCases(resolve(root, 'eval/cases')).filter(
    (evalCase) => evalCase.live && (!filter || evalCase.id.includes(filter)),
  );
  const { runs, spentNano } = await runEvaluation({
    cases,
    models,
    budgetNano,
    mode: 'live',
    onCase: (model, outcome) =>
      process.stdout.write(
        `${outcome.passed ? 'PASS' : 'FAIL'} ${model.model} ${outcome.id}${
          outcome.failures.length ? ` :: ${outcome.failures.join('; ')}` : ''
        }\n`,
      ),
  });
  const report = buildReport({ mode: 'live', runs, budgetNano, spentNano });
  const dir = resolve(root, process.env.LIVE_EVAL_REPORT_DIR ?? 'eval/reports');
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, '-');
  const markdown = renderMarkdown(report);
  writeFileSync(
    resolve(dir, `live-${stamp}.json`),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(resolve(dir, `live-${stamp}.md`), markdown);
  process.stdout.write(markdown);
}

main().catch((error: unknown) => {
  // Messages here never include the key: it is only passed to the SDK.
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Live evaluation failed'}\n`,
  );
  process.exitCode = 1;
});
