import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { pricingFor, usdToNano } from '../src/core/llm/pricing.js';
import {
  buildRoutedProvider,
  loadRoutingPolicy,
} from '../src/llm/routing/routing-factory.js';
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
 * - Provider: LIVE_EVAL_PROVIDER (or LLM_PROVIDER) = anthropic (default),
 *   routed (the application's failover router: only candidates whose key
 *   variable is set and whose model is priced; LLM_ROUTING_POLICY_FILE,
 *   LLM_PRICING_VERSION required, nothing is trusted) or
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
 * - LIVE_EVAL_FILTER limits cases by id substring; LIVE_EVAL_SAMPLE=<file>
 *   restricts the run to the case ids listed in that JSON ({"ids": [...]}).
 * - Hard bounds, all checked before a case starts: LIVE_EVAL_MAX_CASES
 *   (default 30), LIVE_EVAL_MAX_CALLS (default 90 recorded model calls, at
 *   most LIVE_EVAL_CALLS_PER_TURN=4 per case), LIVE_EVAL_MAX_RUNTIME_MS
 *   (default 900000), LIVE_EVAL_MAX_OUTPUT_TOKENS (default 200, at most
 *   1024, the app's LLM_MAX_OUTPUT_TOKENS: the per-call output ceiling of
 *   every request; reasoning models spend part of it on thinking).
 * - Reports go to LIVE_EVAL_REPORT_DIR (default eval/reports, gitignored).
 * Only fictional eval cases and MockConnector data are used. Never in CI.
 */

const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });

const MAX_BUDGET = usdToNano('1');

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
  if (
    providerKind !== 'anthropic' &&
    providerKind !== 'openai-compatible' &&
    providerKind !== 'routed'
  )
    throw new Error(
      'LIVE_EVAL_PROVIDER must be anthropic, openai-compatible or routed.',
    );
  const budgetNano = usdToNano(process.env.LIVE_EVAL_BUDGET_USD ?? '0.50');
  if (budgetNano > MAX_BUDGET || budgetNano <= 0)
    throw new Error(
      'LIVE_EVAL_BUDGET_USD must be greater than 0 and at most 1.',
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
  const maxCases = positiveInt('LIVE_EVAL_MAX_CASES', 30, 200);
  const maxCalls = positiveInt('LIVE_EVAL_MAX_CALLS', 90, 1_000);
  const callsPerTurn = positiveInt('LIVE_EVAL_CALLS_PER_TURN', 4, 6);
  const maxRuntimeMs = positiveInt(
    'LIVE_EVAL_MAX_RUNTIME_MS',
    900_000,
    3_600_000,
  );
  const maxOutputTokens = positiveInt('LIVE_EVAL_MAX_OUTPUT_TOKENS', 200, 1024);
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
  const configurations: Array<{ fast: string; strong: string }> =
    providerKind === 'routed'
      ? [{ fast: 'routed-fast', strong: 'routed-strong' }]
      : listed
        ? listed.map((model) => ({ fast: model, strong: model }))
        : fast && strong
          ? [{ fast, strong }]
          : [];
  if (configurations.length === 0)
    throw new Error('Set LIVE_EVAL_MODELS or LLM_MODEL_FAST/LLM_MODEL_STRONG.');
  if (providerKind !== 'routed') {
    for (const configuration of configurations)
      for (const model of [configuration.fast, configuration.strong])
        pricingFor(pricing, model); // throws for an unpriced model
  }

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
  if (providerKind === 'routed') {
    // Exactly the application's router: no candidate outside the policy, and
    // none without its key and a priced model. Nothing is trusted, so only
    // fictional data may be used (enforced by the fixed case source).
    const routed = buildRoutedProvider({
      policy: loadRoutingPolicy(process.env.LLM_ROUTING_POLICY_FILE),
      snapshot: pricing,
      env: process.env,
      trustedProviders: [],
      requestTimeoutMs: 30_000,
      maxRetries: 1,
      maxInputBytes: 48_000,
    });
    label = `routed (${routed.policy.version})`;
    process.stdout.write(
      `Routed candidates skipped at boot: ${
        routed.skipped.map((s) => `${s.candidate} (${s.reason})`).join('; ') ||
        'none'
      }\n`,
    );
    build = (): LlmProvider => routed.provider;
  } else if (providerKind === 'anthropic') {
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
  const sample = process.env.LIVE_EVAL_SAMPLE
    ? new Set(
        (
          JSON.parse(
            readFileSync(resolve(root, process.env.LIVE_EVAL_SAMPLE), 'utf8'),
          ) as { ids: string[] }
        ).ids,
      )
    : undefined;
  const cases = loadCases(resolve(root, 'eval/cases'))
    .filter(
      (evalCase) =>
        evalCase.live &&
        (!filter || evalCase.id.includes(filter)) &&
        (!sample || sample.has(evalCase.id)),
    )
    .slice(0, maxCases);
  process.stdout.write(
    `Bounds: ${cases.length} cases, <= ${maxCalls} model calls (<= ${callsPerTurn}/case), <= ${maxRuntimeMs} ms, <= ${maxOutputTokens} output tokens per call.\n`,
  );
  const startedAt = Date.now();
  const { runs, spentNano, spentTokens, calls, stoppedBy } =
    await runEvaluation({
      cases,
      models,
      budgetNano,
      budgetTokens,
      limits: {
        maxOutputTokensPerCall: maxOutputTokens,
        maxCallsPerTurn: callsPerTurn,
      },
      maxCalls,
      maxRuntimeMs,
      mode: 'live',
      onCase: (model, outcome) => {
        const d = outcome.diagnostics;
        process.stdout.write(
          `${outcome.passed ? 'PASS' : 'FAIL'} ${model.model} ${outcome.id}${
            outcome.failures.length ? ` :: ${outcome.failures.join('; ')}` : ''
          }${outcome.llmFailure ? ` [model failure: ${outcome.llmFailure}]` : ''}${
            outcome.passed
              ? ''
              : ` {extraction=${d.extractionFailure ?? 'ok'} intent=${d.intent ?? '-'} draft=${d.draftFailure ?? 'ok'} out_tokens=${outcome.outputTokens}}`
          }\n`,
        );
      },
    });
  process.stdout.write(
    `Run summary: ${calls} recorded model calls, ${spentTokens} tokens, ${Date.now() - startedAt} ms, measured cost ${spentNano} nano-USD, stopped by: ${stoppedBy ?? 'completion'}.\n`,
  );
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
