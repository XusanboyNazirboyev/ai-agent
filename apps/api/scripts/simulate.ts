/**
 * Scenario simulation against the v1 agent (ADR 026 slice 1). Synthetic data
 * only; never the development database; never contacts Telegram.
 *
 *   SIM=1 SIM_POSTGRES_DATABASE=agentcore_slice1 SIM_PRESET=groq pnpm simulate
 *   SIM=1 SIM_ESTIMATE=1 SIM_ESTIMATE_FROM=../../eval/reports/sim-....json pnpm simulate
 *
 * Environment (names only; keys come from .env / the shell and are never printed):
 * - SIM_POSTGRES_DATABASE: dedicated `agentcore_*` database (not the dev one, not agentcore_test)
 * - SIM_PRESET: groq | gemini (free tiers, OpenAI-compatible presets), or
 *   SIM_PROVIDER=anthropic (paid: needs SIM_PAID=1 and SIM_BUDGET_USD <= 5)
 * - SIM_MODEL_FAST / SIM_MODEL_STRONG (default: preset defaults), SIM_PRICING_VERSION
 * - SIM_CUSTOMER: scripted (default) | llm;  SIM_K (default 1)
 * - SIM_FILTER (id substring), SIM_LANGUAGES, SIM_PACKS (comma lists), SIM_MAX_UNITS
 * - LLM_RATE_LIMIT_RPM / LLM_RATE_LIMIT_TPM / LLM_RATE_LIMIT_RPD
 * - SIM_ESTIMATE=1: print the paid-run cost estimate only (no model calls)
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  estimateSuiteCost,
  type ModelPrice,
} from '../src/agent/testing/simulation/cost.js';
import { providerFailed } from '../src/agent/testing/simulation/grader.js';
import {
  LlmCustomer,
  ScriptedCustomer,
  type SimulatedCustomer,
} from '../src/agent/testing/simulation/customer.js';
import {
  buildReport,
  renderMarkdown,
  type SimulationReport,
} from '../src/agent/testing/simulation/report.js';
import {
  runScenario,
  type RunResult,
} from '../src/agent/testing/simulation/runner.js';
import {
  loadScenarios,
  SIM_LANGUAGES,
  type SimLanguage,
} from '../src/agent/testing/simulation/scenario.js';
import { simulationSettings } from '../src/agent/testing/simulation/world.js';
import type { LlmProvider } from '../src/core/llm/llm-provider.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { AnthropicLlmProvider } from '../src/llm/anthropic/anthropic-llm-provider.js';
import { OpenAiCompatibleLlmProvider } from '../src/llm/openai-compatible/openai-compatible-provider.js';
import { pricingFor } from '../src/core/llm/pricing.js';
import { PRICING_CATALOG } from '../src/llm/pricing-catalog.js';
import { presetFor } from '../src/llm/provider-presets.js';
import {
  ClientRateLimiter,
  RateLimitedLlmProvider,
} from '../src/llm/rate-limited-provider.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';

const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env'), quiet: true });
const env = process.env;
const int = (name: string, fallback: number): number => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
};
const list = (name: string): string[] | undefined =>
  env[name]
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function anthropicPrice(model: string): ModelPrice {
  const rates = pricingFor(
    PRICING_CATALOG.snapshot('anthropic-2026-10-23'),
    model,
  ).standard;
  // Catalog rates are nano-USD per token: x 1e6 tokens / 1e9 = USD per million tokens.
  return {
    model,
    inputPerMTok: rates.input / 1_000,
    outputPerMTok: rates.output / 1_000,
  };
}

/** Paid-run estimate from a measured report (token shape) and catalog prices. */
function estimate(): void {
  const from = env.SIM_ESTIMATE_FROM;
  if (!from)
    throw new Error(
      'SIM_ESTIMATE_FROM=<report.json> (a measured run) is required',
    );
  const report = JSON.parse(
    readFileSync(resolve(process.cwd(), from), 'utf8'),
  ) as SimulationReport;
  const done = report.runs.filter((r) => r.status === 'completed' && r.metrics);
  const turns = done.reduce((a, r) => a + r.customerTurns, 0);
  if (!turns) throw new Error('the report has no completed turns to measure');
  const agentIn =
    done.reduce((a, r) => a + r.metrics!.agentInputTokens, 0) / turns;
  const agentOut =
    done.reduce((a, r) => a + r.metrics!.agentOutputTokens, 0) / turns;
  const custIn =
    done.reduce((a, r) => a + r.simulatorUsage.inputTokens, 0) / turns;
  const custOut =
    done.reduce((a, r) => a + r.simulatorUsage.outputTokens, 0) / turns;
  const scenarios = loadScenarios(resolve(root, 'eval/scenarios'));
  const units = scenarios
    .filter((s) => s.pack !== 'retail')
    .reduce((a, s) => a + s.languages.length, 0);
  // Optional conservative overrides (the measured shape is short when v1 hands over early).
  const override = (name: string, measured: number): number =>
    env[name] ? Number(env[name]) : measured;
  const customerTurns = override('SIM_ESTIMATE_TURNS', turns / done.length);
  const haiku = anthropicPrice('claude-haiku-5-5');
  const sonnet = anthropicPrice('claude-sonnet-5-5');
  // An LLM customer has not been measured yet: assume ~800 in / 60 out per turn if absent.
  const llmCustIn = custIn || 800;
  const llmCustOut = custOut || 60;
  const shape = {
    units,
    runsPerUnit: 3,
    customerTurns,
    agentInputPerTurn: override('SIM_ESTIMATE_AGENT_IN', agentIn),
    agentOutputPerTurn: override('SIM_ESTIMATE_AGENT_OUT', agentOut),
  };
  const rows = [
    [
      'A: v1 default (agent Haiku both tiers), scripted customer, no judge',
      estimateSuiteCost(
        {
          ...shape,
          customerInputPerTurn: 0,
          customerOutputPerTurn: 0,
          judgeInputPerRun: 0,
          judgeOutputPerRun: 0,
        },
        { agent: haiku, customer: haiku, judge: sonnet },
      ),
    ],
    [
      'B: agent Haiku, LLM customer Haiku, no judge',
      estimateSuiteCost(
        {
          ...shape,
          customerInputPerTurn: llmCustIn,
          customerOutputPerTurn: llmCustOut,
          judgeInputPerRun: 0,
          judgeOutputPerRun: 0,
        },
        { agent: haiku, customer: haiku, judge: sonnet },
      ),
    ],
    [
      'C: worst case, all agent tokens on Sonnet, LLM customer Haiku',
      estimateSuiteCost(
        {
          ...shape,
          customerInputPerTurn: llmCustIn,
          customerOutputPerTurn: llmCustOut,
          judgeInputPerRun: 0,
          judgeOutputPerRun: 0,
        },
        { agent: sonnet, customer: haiku, judge: sonnet },
      ),
    ],
    [
      'D: B plus a Sonnet judge (~3,000 in / 300 out per run; judge not gating yet)',
      estimateSuiteCost(
        {
          ...shape,
          customerInputPerTurn: llmCustIn,
          customerOutputPerTurn: llmCustOut,
          judgeInputPerRun: 3_000,
          judgeOutputPerRun: 300,
        },
        { agent: haiku, customer: haiku, judge: sonnet },
      ),
    ],
  ] as const;
  process.stdout.write(
    `Measured from ${from}: ${done.length} runs, ${customerTurns.toFixed(2)} customer turns/run, agent ${Math.round(agentIn)} in / ${Math.round(agentOut)} out tokens per turn${custIn ? `, customer ${Math.round(custIn)} / ${Math.round(custOut)}` : ''}.\n` +
      `Full suite = ${units} runnable units x k=3 = ${units * 3} runs. Prices: anthropic-2026-10-23 (Haiku $${haiku.inputPerMTok}/$${haiku.outputPerMTok}, Sonnet $${sonnet.inputPerMTok}/$${sonnet.outputPerMTok} per MTok).\n\n` +
      `| Option | Agent | Customer | Judge | Total per full run | Full runs within $50 |\n|---|---|---|---|---|---|\n` +
      rows
        .map(
          ([label, e]) =>
            `| ${label} | $${e.agentUsd.toFixed(2)} | $${e.customerUsd.toFixed(2)} | $${e.judgeUsd.toFixed(2)} | **$${e.totalUsd.toFixed(2)}** | ${e.runsWithinCap} |`,
        )
        .join('\n') +
      '\n',
  );
}

function buildProvider(): {
  provider: LlmProvider;
  label: string;
  pricingVersion: string;
  paid: boolean;
} {
  const limits = {
    requestsPerMinute: env.LLM_RATE_LIMIT_RPM
      ? int('LLM_RATE_LIMIT_RPM', 1)
      : undefined,
    tokensPerMinute: env.LLM_RATE_LIMIT_TPM
      ? int('LLM_RATE_LIMIT_TPM', 1)
      : undefined,
    requestsPerDay: env.LLM_RATE_LIMIT_RPD
      ? int('LLM_RATE_LIMIT_RPD', 1)
      : undefined,
    // Must stay well below AGENT_TURN_TIMEOUT_MS (60 s in simulation settings):
    // a longer client-side wait becomes a turn timeout and an LLM_UNAVAILABLE handover.
    maxWaitMs: 20_000,
  };
  const wrap = (provider: LlmProvider): LlmProvider =>
    limits.requestsPerMinute || limits.tokensPerMinute || limits.requestsPerDay
      ? new RateLimitedLlmProvider(provider, new ClientRateLimiter(limits))
      : provider;
  if (env.SIM_PROVIDER === 'anthropic') {
    if (env.SIM_PAID !== '1')
      throw new Error(
        'Paid provider: set SIM_PAID=1 after the owner approved the cost estimate.',
      );
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error('ANTHROPIC_API_KEY is required (never printed).');
    const fast = env.SIM_MODEL_FAST ?? 'claude-haiku-5-5';
    return {
      provider: wrap(
        new AnthropicLlmProvider({
          client: new Anthropic({ apiKey, maxRetries: 0 }),
          models: { FAST: fast, STRONG: env.SIM_MODEL_STRONG ?? fast },
          effort: 'low',
          requestTimeoutMs: 30_000,
          maxRetries: 2,
        }),
      ),
      label: `anthropic ${fast}`,
      pricingVersion: 'anthropic-2026-10-23',
      paid: true,
    };
  }
  const preset = presetFor(env.SIM_PRESET ?? 'groq');
  if (!preset.free)
    throw new Error(
      `${preset.id} is not a free preset; paid runs need SIM_PROVIDER=anthropic`,
    );
  const apiKey = preset.apiKeyEnvVar ? env[preset.apiKeyEnvVar] : undefined;
  if (preset.apiKeyRequired && !apiKey)
    throw new Error(`${preset.apiKeyEnvVar} is required (never printed).`);
  const fast = env.SIM_MODEL_FAST ?? preset.defaultModels.FAST;
  const strong = env.SIM_MODEL_STRONG ?? fast;
  const structured =
    preset.capabilities[fast]?.structured === 'json_object'
      ? 'json_object'
      : 'json_schema';
  return {
    provider: wrap(
      new OpenAiCompatibleLlmProvider({
        baseUrl: preset.baseUrl,
        apiKey,
        models: { FAST: fast, STRONG: strong },
        structuredOutput: structured,
        maxTokensParam: preset.maxTokensParam,
        requestTimeoutMs: 60_000,
        maxRetries: 2,
      }),
    ),
    label: `${preset.id} ${fast}${strong !== fast ? ` / ${strong}` : ''}`,
    pricingVersion: env.SIM_PRICING_VERSION ?? 'routing-free-2026-10-23',
    paid: false,
  };
}

async function main(): Promise<void> {
  if (env.SIM !== '1') throw new Error('Simulation is opt-in: set SIM=1.');
  if (env.SIM_ESTIMATE === '1') return estimate();
  const database = env.SIM_POSTGRES_DATABASE ?? '';
  if (
    !/^agentcore_[a-z0-9_]+$/u.test(database) ||
    database === env.POSTGRES_DATABASE ||
    database === 'agentcore_test'
  )
    throw new Error(
      'SIM_POSTGRES_DATABASE must be a dedicated agentcore_* database (not the dev database, not agentcore_test).',
    );
  const { provider, label, pricingVersion, paid } = buildProvider();
  const budgetUsd = Number(env.SIM_BUDGET_USD ?? '0');
  if (paid && !(budgetUsd > 0 && budgetUsd <= 5))
    throw new Error('Paid runs need 0 < SIM_BUDGET_USD <= 5.');
  const k = int('SIM_K', 1);
  const languages = list('SIM_LANGUAGES') as SimLanguage[] | undefined;
  const packs = list('SIM_PACKS');
  const scenarios = loadScenarios(resolve(root, 'eval/scenarios')).filter(
    (s) =>
      (!env.SIM_FILTER || s.id.includes(env.SIM_FILTER)) &&
      (!packs || packs.includes(s.pack)),
  );
  const units = scenarios
    .flatMap((s) =>
      s.languages
        .filter((l) => (languages ?? [...SIM_LANGUAGES]).includes(l))
        .map((language) => ({ scenario: s, language })),
    )
    .slice(0, int('SIM_MAX_UNITS', 10_000));
  const customerKind = env.SIM_CUSTOMER === 'llm' ? 'llm' : 'scripted';
  const db = new PrismaClient({
    adapter: createPostgresAdapter({ ...env, POSTGRES_DATABASE: database }),
  });
  const settings = simulationSettings({
    LLM_PRICING_VERSION: pricingVersion,
    ...(paid ? {} : { LLM_TURN_BUDGET_USD: '0.02' }),
  });
  process.stdout.write(
    `Simulation: ${label}, customer ${customerKind}, k=${k}, ${units.length} units, database ${database}. Synthetic data only.\n`,
  );
  const runs: RunResult[] = [];
  const transcripts: string[] = [];
  let spentNano = 0n;
  let providerFailuresInARow = 0;
  const startedAt = Date.now();
  try {
    outer: for (const { scenario, language } of units)
      for (let run = 1; run <= k; run += 1) {
        const customer: SimulatedCustomer =
          customerKind === 'llm'
            ? new LlmCustomer(provider, scenario, language)
            : new ScriptedCustomer(scenario, language);
        const result = await runScenario({
          db,
          scenario,
          language,
          run,
          provider,
          customer,
          settings,
        });
        runs.push(result);
        transcripts.push(
          JSON.stringify({
            id: scenario.id,
            language,
            run,
            status: result.status,
            transcript: result.transcript,
          }),
        );
        spentNano += result.metrics?.agentCostNano ?? 0n;
        process.stdout.write(
          `${result.passed ? 'PASS' : result.status === 'completed' ? 'FAIL' : result.status.toUpperCase()} ${scenario.id} ${language} #${run}${result.reason ? ` (${result.reason})` : ''}\n`,
        );
        if (paid && Number(spentNano) / 1e9 >= budgetUsd) {
          process.stdout.write(`Budget $${budgetUsd} reached; stopping.\n`);
          break outer;
        }
        providerFailuresInARow =
          result.metrics && providerFailed(result.metrics)
            ? providerFailuresInARow + 1
            : 0;
        if (providerFailuresInARow >= 3) {
          process.stdout.write(
            'Three runs in a row failed at the model provider (quota, rate limit or outage); stopping (partial report).\n',
          );
          break outer;
        }
        if (
          result.status === 'error' &&
          /quota|rate|LLM_QUOTA|429/iu.test(result.reason ?? '')
        ) {
          process.stdout.write(
            'Provider quota or rate limit reached; stopping (partial report).\n',
          );
          break outer;
        }
      }
  } finally {
    await db.$disconnect();
  }
  const report = buildReport({
    label: `v1 baseline (${label})`,
    agentModel: label,
    customer: customerKind,
    runsPerScenario: k,
    runs,
    simulatorCostUsd: 0,
  });
  const dir = resolve(root, 'eval/reports');
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, '-');
  writeFileSync(
    resolve(dir, `sim-${stamp}.json`),
    JSON.stringify(
      report,
      (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v),
      2,
    ),
  );
  writeFileSync(resolve(dir, `sim-${stamp}.md`), renderMarkdown(report));
  writeFileSync(
    resolve(dir, `sim-${stamp}-transcripts.jsonl`),
    `${transcripts.join('\n')}\n`,
  );
  process.stdout.write(
    `\n${renderMarkdown(report)}\nWritten eval/reports/sim-${stamp}.{json,md} and -transcripts.jsonl; ${Math.round((Date.now() - startedAt) / 1000)} s.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Simulation failed'}\n`,
  );
  process.exitCode = 1;
});
