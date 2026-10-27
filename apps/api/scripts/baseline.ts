/**
 * Free-tier baseline runs (ADR 026 slice 1c). MEASUREMENT ONLY, not a gate.
 *
 *   SIM=1 SIM_POSTGRES_DATABASE=agentcore_slice1 pnpm baseline run    # Groq lane, core-30 first, then the full suite
 *   SIM=1 pnpm baseline report                                         # rebuild the lane report from the ledger
 *
 * Environment (names only; keys are read from .env and never printed):
 * - SIM_LANE: groq (only lane allowed to run until the owner reviews it; amendment 6)
 * - SIM_UNITS: core-30 (default: core-30 first, then the rest of the full suite) | core-30-only
 * - SIM_K: 1 (default; k=3 later)
 * - SIM_POSTGRES_DATABASE: dedicated `agentcore_*` database (not the dev one, not agentcore_test)
 * - SIM_MAX_WAIT_MS: longest per-minute throttle wait (default 20000; must stay below the 60 s turn timeout)
 * Results: eval/reports/baselines/<lane>/<commit>-<suite>.jsonl (append-only, resumable).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  renderLaneReport,
  type Provenance,
} from '../src/agent/testing/simulation/baseline-report.js';
import { ScriptedCustomer } from '../src/agent/testing/simulation/customer.js';
import {
  BaselineLedger,
  laneId,
  suiteHash,
  type Lane,
} from '../src/agent/testing/simulation/ledger.js';
import {
  classifyRun,
  LaneTraffic,
} from '../src/agent/testing/simulation/provider-traffic.js';
import { runScenario } from '../src/agent/testing/simulation/runner.js';
import {
  loadScenarios,
  type SimLanguage,
} from '../src/agent/testing/simulation/scenario.js';
import {
  fullUnits,
  loadSubset,
} from '../src/agent/testing/simulation/subsets.js';
import { simulationSettings } from '../src/agent/testing/simulation/world.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { OpenAiCompatibleLlmProvider } from '../src/llm/openai-compatible/openai-compatible-provider.js';
import { presetFor } from '../src/llm/provider-presets.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';

const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env'), quiet: true });
const env = process.env;
const scenarioRoot = resolve(root, 'eval/scenarios');
const ledgerRoot = resolve(root, 'eval/reports/baselines');

/** Official limit sources read 2026-10-26 (free-plan numbers unverified unless stated). */
const LIMIT_SOURCES: Record<string, string[]> = {
  groq: [
    'live x-ratelimit-* response headers (per-day requests, per-minute tokens) and retry-after',
    'https://console.groq.com/docs/rate-limits (read 2026-10-26; table not confirmed as the free plan: unverified)',
    'https://console.groq.com/docs/errors (read 2026-10-26)',
  ],
};

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function agentCommit(): string {
  const dirty = git([
    'status',
    '--porcelain',
    '--',
    'apps/api/src',
    'packages/shared/src',
    'eval/scenarios',
  ]);
  if (dirty)
    throw new Error(
      'Agent or scenario code has uncommitted changes; commit first (the commit is part of the result identity).',
    );
  return git(['rev-parse', 'HEAD']);
}

function laneFromEnv(): Lane {
  const id = env.SIM_LANE ?? 'groq';
  if (id !== 'groq')
    throw new Error(
      `Lane ${id}: only the Groq lane may run until the owner has reviewed it (amendment 6); other lanes: smoke checks only.`,
    );
  const preset = presetFor(id);
  return {
    provider: id,
    fast: preset.defaultModels?.FAST ?? '',
    strong: preset.defaultModels?.STRONG ?? '',
  };
}

async function main(): Promise<void> {
  if (env.SIM !== '1') throw new Error('Baseline runs are opt-in: set SIM=1.');
  const command = process.argv[2] ?? 'run';
  const lane = laneFromEnv();
  const commit = agentCommit();
  const suite = suiteHash(scenarioRoot);
  const scenarios = loadScenarios(scenarioRoot);
  const core = loadSubset(scenarioRoot, 'core-30', scenarios);
  const all = fullUnits(scenarios);
  const coreOnly = env.SIM_UNITS === 'core-30-only';
  const units = coreOnly
    ? core.units
    : [...core.units, ...all.filter((u) => !core.units.includes(u))];
  const k = Number(env.SIM_K ?? '1');
  if (!Number.isInteger(k) || k < 1 || k > 3)
    throw new Error('SIM_K must be 1, 2 or 3.');
  const ledger = BaselineLedger.open(ledgerRoot, lane, commit, suite);
  const provenance = (
    subsetUnits: readonly string[],
    name: 'core-30' | 'full',
  ): Provenance => ({
    header: ledger.header,
    subset:
      name === 'core-30'
        ? { name, sha256: core.sha256 }
        : { name, units: subsetUnits.length },
    k,
    pricingVersion: 'routing-free-2026-10-23',
    limitsSources: LIMIT_SOURCES[lane.provider] ?? ['preset (unverified)'],
    generatedAt: new Date().toISOString(),
  });
  const writeReports = (): string => {
    const coreReport = renderLaneReport(
      provenance(core.units, 'core-30'),
      ledger.latest(),
      core.units,
    );
    const fullReport = renderLaneReport(
      provenance(all, 'full'),
      ledger.latest(),
      all,
    );
    const base = ledger.file.replace(/\.jsonl$/u, '');
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}-core-30.md`, coreReport);
    writeFileSync(`${base}-full.md`, fullReport);
    return `${coreReport}\n${fullReport}`;
  };
  if (command === 'report') {
    process.stdout.write(writeReports());
    return;
  }
  if (command !== 'run') throw new Error('command must be run or report');

  const database = env.SIM_POSTGRES_DATABASE ?? '';
  if (
    !/^agentcore_[a-z0-9_]+$/u.test(database) ||
    database === env.POSTGRES_DATABASE ||
    database === 'agentcore_test'
  )
    throw new Error(
      'SIM_POSTGRES_DATABASE must be a dedicated agentcore_* database (not the dev database, not agentcore_test).',
    );
  const preset = presetFor(lane.provider);
  const apiKey = preset.apiKeyEnvVar ? env[preset.apiKeyEnvVar] : undefined;
  if (preset.apiKeyRequired && !apiKey)
    throw new Error(`${preset.apiKeyEnvVar} is required (never printed).`);
  const traffic = new LaneTraffic({
    provider: lane.provider,
    maxWaitMs: Number(env.SIM_MAX_WAIT_MS ?? '20000'),
  });
  // Retries are owned by the pacing layer (maxRetries 0), so 429s are not handled twice.
  const provider = new OpenAiCompatibleLlmProvider({
    baseUrl: preset.baseUrl,
    apiKey,
    models: { FAST: lane.fast, STRONG: lane.strong },
    structuredOutput:
      preset.capabilities[lane.fast]?.structured === 'json_object'
        ? 'json_object'
        : 'json_schema',
    maxTokensParam: preset.maxTokensParam,
    requestTimeoutMs: 45_000,
    maxRetries: 0,
    fetch: traffic.fetch,
  });
  const pending = ledger.pending(units, k);
  process.stdout.write(
    `Baseline lane ${laneId(lane)} | commit ${commit.slice(0, 12)} | suite ${suite.slice(0, 12)} | ${pending.length} runs pending of ${units.length * k} | MEASUREMENT ONLY\n`,
  );
  const db = new PrismaClient({
    adapter: createPostgresAdapter({ ...env, POSTGRES_DATABASE: database }),
  });
  const settings = simulationSettings({
    LLM_PRICING_VERSION: 'routing-free-2026-10-23',
  });
  try {
    for (const { unitId, k: index } of pending) {
      const [scenarioId, language] = unitId.split('/') as [string, SimLanguage];
      const scenario = scenarios.find((s) => s.id === scenarioId)!;
      traffic.takeEvents();
      const result = await runScenario({
        db,
        scenario,
        language,
        run: index,
        provider,
        customer: new ScriptedCustomer(scenario, language),
        settings,
      });
      const events = traffic.takeEvents();
      const m = result.metrics;
      const verdict =
        result.status === 'completed'
          ? classifyRun(result.passed, events, m?.turnFailureCodes)
          : classifyRun(
              false,
              events.length
                ? events
                : [
                    {
                      kind: 'transient',
                      final: true,
                      at: Date.now(),
                      code: 'harness_error',
                    },
                  ],
            );
      ledger.append({
        type: 'run',
        unitId,
        k: index,
        class: verdict.class,
        passed: result.passed,
        reason: verdict.reason,
        goalCompleted: m?.goalCompleted,
        handoverReasons: m?.handoverReasons,
        inventedFacts: m?.inventedFacts.length,
        falseSuccessClaims: m?.falseSuccessClaims,
        languageMatched: m?.languageMatched,
        languageChecked: m?.languageChecked,
        customerTurns: result.customerTurns,
        agentInputTokens: m?.agentInputTokens,
        agentOutputTokens: m?.agentOutputTokens,
        latenciesMs: m?.latenciesMs,
        blockedNumberClasses: m?.blockedNumberClasses,
        finishedAt: new Date().toISOString(),
      });
      process.stdout.write(
        `${verdict.class.padEnd(12)} ${result.passed ? 'PASS' : 'FAIL'} ${unitId} #${index}${verdict.reason ? ` (${verdict.reason})` : ''}\n`,
      );
      if (traffic.exhausted) {
        process.stdout.write(
          `Lane stopped: ${traffic.exhausted.kind} (${traffic.exhausted.window ?? 'unknown'} window${traffic.exhausted.code ? `, code ${traffic.exhausted.code}` : ''}). Partial results kept; rerun later to resume.\n`,
        );
        break;
      }
    }
  } finally {
    await db.$disconnect();
  }
  process.stdout.write(`\n${writeReports()}`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Baseline failed'}\n`,
  );
  process.exitCode = 1;
});
