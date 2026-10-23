import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { pricingFor, usdToNano } from '../src/core/llm/pricing.js';
import type { LlmProvider } from '../src/core/llm/llm-provider.js';
import { AnthropicLlmProvider } from '../src/llm/anthropic/anthropic-llm-provider.js';
import { OpenAiCompatibleLlmProvider } from '../src/llm/openai-compatible/openai-compatible-provider.js';
import {
  ClientRateLimiter,
  RateLimitedLlmProvider,
} from '../src/llm/rate-limited-provider.js';
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
 * - Provider: LIVE_EVAL_PROVIDER (or LLM_PROVIDER) = anthropic (default) or
 *   openai-compatible (LLM_BASE_URL, optional LLM_API_KEY, LLM_MODEL_FAST /
 *   LLM_MODEL_STRONG, LLM_PRICING_VERSION; LLM_RATE_LIMIT_* respected).
 * - Credentials come from the environment only: `.env.local` (gitignored)
 *   or `.env` at the repository root, or the shell. Keys are never
 *   printed, logged or written to the report.
 * - LIVE_EVAL_TOKEN_BUDGET (default 300000) caps total tokens, so a free
 *   model is bounded too.
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

const MAX_TOKEN_BUDGET = 5_000_000;

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error(`${name} must be a positive integer of at most ${max}.`);
  return value;
}

function optionalInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  return positiveInt(name, 1, 100_000_000);
}

async function main(): Promise<void> {
  if (process.env.LIVE_EVAL !== '1') {
    throw new Error(
      'Live evaluation is opt-in: set LIVE_EVAL=1 (it makes billable API calls).',
    );
  }
  const providerKind =
    process.env.LIVE_EVAL_PROVIDER ?? process.env.LLM_PROVIDER ?? 'anthropic';
  if (providerKind !== 'anthropic' && providerKind !== 'openai-compatible')
    throw new Error(
      'LIVE_EVAL_PROVIDER must be anthropic or openai-compatible.',
    );
  const budgetNano = usdToNano(process.env.LIVE_EVAL_BUDGET_USD ?? '0.50');
  if (budgetNano > MAX_BUDGET || budgetNano <= 0)
    throw new Error(
      'LIVE_EVAL_BUDGET_USD must be greater than 0 and at most 5.',
    );
  const budgetTokens = positiveInt(
    'LIVE_EVAL_TOKEN_BUDGET',
    300_000,
    MAX_TOKEN_BUDGET,
  );

  const pricing = PRICING_CATALOG.snapshot(
    process.env.LLM_PRICING_VERSION ??
      (providerKind === 'anthropic' ? 'anthropic-2026-10-23' : ''),
  );
  const listed = process.env.LIVE_EVAL_MODELS?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const fast =
    providerKind === 'anthropic'
      ? (process.env.LLM_FAST_MODEL ?? 'claude-haiku-5-5')
      : process.env.LLM_MODEL_FAST;
  const strong =
    providerKind === 'anthropic'
      ? (process.env.LLM_STRONG_MODEL ?? fast)
      : process.env.LLM_MODEL_STRONG;
  const configurations: Array<{ fast: string; strong: string }> = listed
    ? listed.map((model) => ({ fast: model, strong: model }))
    : fast && strong
      ? [{ fast, strong }]
      : [];
  if (configurations.length === 0)
    throw new Error('Set LIVE_EVAL_MODELS or LLM_MODEL_FAST/LLM_MODEL_STRONG.');
  for (const configuration of configurations)
    for (const model of [configuration.fast, configuration.strong])
      pricingFor(pricing, model); // throws for an unpriced model

  const limits = {
    requestsPerMinute: optionalInt('LLM_RATE_LIMIT_RPM'),
    tokensPerMinute: optionalInt('LLM_RATE_LIMIT_TPM'),
    requestsPerDay: optionalInt('LLM_RATE_LIMIT_RPD'),
    maxWaitMs: 60_000,
  };
  // One limiter for the whole run: every model shares the key's quota.
  const limiter =
    limits.requestsPerMinute || limits.tokensPerMinute || limits.requestsPerDay
      ? new ClientRateLimiter(limits)
      : undefined;
  const wrap = (provider: LlmProvider): LlmProvider =>
    limiter ? new RateLimitedLlmProvider(provider, limiter) : provider;

  let build: (configuration: { fast: string; strong: string }) => LlmProvider;
  let label: string;
  if (providerKind === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error(
        'ANTHROPIC_API_KEY is required (set it in .env.local; it is never printed).',
      );
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    label = 'anthropic';
    build = (configuration): LlmProvider =>
      new AnthropicLlmProvider({
        client,
        models: { FAST: configuration.fast, STRONG: configuration.strong },
        effort: 'low',
        requestTimeoutMs: 30_000,
        maxRetries: 2,
      });
  } else {
    const baseUrl = process.env.LLM_BASE_URL;
    if (!baseUrl)
      throw new Error('LLM_BASE_URL is required for openai-compatible.');
    const host = new URL(baseUrl).host;
    label = `openai-compatible (${host})`;
    const apiKey = process.env.LLM_API_KEY || undefined;
    build = (configuration): LlmProvider =>
      new OpenAiCompatibleLlmProvider({
        baseUrl,
        apiKey,
        models: { FAST: configuration.fast, STRONG: configuration.strong },
        structuredOutput:
          process.env.LLM_STRUCTURED_OUTPUT === 'json_object'
            ? 'json_object'
            : 'json_schema',
        maxTokensParam:
          process.env.LLM_MAX_TOKENS_PARAM === 'max_completion_tokens'
            ? 'max_completion_tokens'
            : 'max_tokens',
        requestTimeoutMs: 30_000,
        maxRetries: 2,
      });
  }
  process.stdout.write(
    `Live eval: ${label}, pricing ${pricing.version} (asOf ${pricing.asOf}), budget $${process.env.LIVE_EVAL_BUDGET_USD ?? '0.50'}, ${budgetTokens} tokens. Fictional eval data only.\n`,
  );
  const models: EvaluatedModel[] = configurations.map((configuration) => {
    const provider = wrap(build(configuration));
    return {
      provider: label,
      model:
        configuration.fast === configuration.strong
          ? configuration.fast
          : `${configuration.fast} / ${configuration.strong}`,
      pricingVersion: pricing.version,
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
    budgetTokens,
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
