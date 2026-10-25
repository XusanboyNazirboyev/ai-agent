import { providerFailed } from './grader.js';
import type { RunResult } from './runner.js';
import { GOAL_FLOOR, THRESHOLDS, type MetricKey } from './quality-bar.js';

/** Aggregated metric values for one group of runs (a pack, a language, all). */
export interface GroupMetrics {
  readonly runs: number;
  readonly completed: number;
  readonly errors: number;
  readonly notRunnable: number;
  /** Completed runs where the model provider failed (LLM_UNAVAILABLE/BUDGET_EXCEEDED handover). */
  readonly providerFailures: number;
  readonly scenarioUnits: number;
  /** Units (scenario x language) that passed in every run (pass^k). */
  readonly unitsPassed: number;
  readonly values: Partial<Record<MetricKey, number>>;
}

export interface SimulationReport {
  readonly generatedAt: string;
  readonly label: string;
  readonly agentModel: string;
  readonly customer: 'scripted' | 'llm';
  readonly runsPerScenario: number;
  readonly overall: GroupMetrics;
  /** Same metrics without retail, which has no v1 pack (reporting only; thresholds unchanged). */
  readonly overallExcludingRetail: GroupMetrics;
  /** Scenario x language units that could not run because their pack is missing. */
  readonly packMissingUnits: number;
  readonly byPack: Record<string, GroupMetrics>;
  readonly byPackLanguage: Record<string, GroupMetrics>;
  readonly runs: readonly Omit<RunResult, 'transcript'>[];
  readonly costUsd: { agent: number; simulator: number };
}

const NANO = 1_000_000_000;

function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

export function aggregate(runs: readonly RunResult[]): GroupMetrics {
  const done = runs.filter((r) => r.status === 'completed' && r.metrics);
  const m = done.map((r) => r.metrics!);
  const sum = (f: (x: (typeof m)[number]) => number): number =>
    m.reduce((a, x) => a + f(x), 0);
  const rate = (hits: number, total: number): number | undefined =>
    total ? hits / total : undefined;
  const units = new Map<string, RunResult[]>();
  for (const r of runs) {
    const key = `${r.scenarioId}/${r.language}`;
    units.set(key, [...(units.get(key) ?? []), r]);
  }
  const unitList = [...units.values()];
  const handover = m.filter((x) => x.handoverCorrect !== undefined);
  const slots = m.filter((x) => x.slotsCorrect !== undefined);
  const leads = m.filter((x) => x.turnsToLead !== undefined);
  const values: Partial<Record<MetricKey, number>> = {
    inventedFacts: sum((x) => x.inventedFacts.length),
    falseSuccessClaims: sum((x) => x.falseSuccessClaims),
    crossTenantLeaks: sum((x) => x.crossTenantLeaks.length),
    handoverCorrect: rate(
      handover.filter((x) => x.handoverCorrect).length,
      handover.length,
    ),
    languageMatch: rate(
      sum((x) => x.languageMatched),
      sum((x) => x.languageChecked),
    ),
    // A unit completes its goal only if every run (including not runnable) did.
    goalCompletion: rate(
      unitList.filter((u) => u.every((r) => r.metrics?.goalCompleted === true))
        .length,
      unitList.length,
    ),
    slotCorrection: rate(
      slots.filter((x) => x.slotsCorrect).length,
      slots.length,
    ),
    oneQuestion: rate(
      sum((x) => x.repliesWithOneQuestionOrLess),
      sum((x) => x.repliesChecked),
    ),
    turnsToLead: leads.length
      ? leads.reduce((a, x) => a + x.turnsToLead!, 0) / leads.length
      : undefined,
    p95LatencyMs: percentile(
      m.flatMap((x) => x.latenciesMs),
      95,
    ),
    costPerConversationUsd: m.length
      ? Number(m.reduce((a, x) => a + x.agentCostNano, 0n)) / NANO / m.length
      : undefined,
  };
  for (const key of Object.keys(values) as MetricKey[])
    if (values[key] === undefined) delete values[key];
  return {
    runs: runs.length,
    completed: done.length,
    errors: runs.filter((r) => r.status === 'error').length,
    notRunnable: runs.filter((r) => r.status === 'not_runnable').length,
    providerFailures: m.filter((x) => providerFailed(x)).length,
    scenarioUnits: unitList.length,
    unitsPassed: unitList.filter((u) => u.every((r) => r.passed)).length,
    values,
  };
}

function groupBy(
  runs: readonly RunResult[],
  key: (r: RunResult) => string,
): Record<string, GroupMetrics> {
  const groups = new Map<string, RunResult[]>();
  for (const r of runs) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return Object.fromEntries(
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, aggregate(v)]),
  );
}

export function buildReport(options: {
  label: string;
  agentModel: string;
  customer: 'scripted' | 'llm';
  runsPerScenario: number;
  runs: readonly RunResult[];
  simulatorCostUsd: number;
}): SimulationReport {
  const overall = aggregate(options.runs);
  const overallExcludingRetail = aggregate(
    options.runs.filter((r) => r.pack !== 'retail'),
  );
  const packMissingUnits = new Set(
    options.runs
      .filter((r) => r.status === 'not_runnable')
      .map((r) => `${r.scenarioId}/${r.language}`),
  ).size;
  return {
    generatedAt: new Date().toISOString(),
    label: options.label,
    agentModel: options.agentModel,
    customer: options.customer,
    runsPerScenario: options.runsPerScenario,
    overall,
    overallExcludingRetail,
    packMissingUnits,
    byPack: groupBy(options.runs, (r) => r.pack),
    byPackLanguage: groupBy(options.runs, (r) => `${r.pack}/${r.language}`),
    runs: options.runs.map(({ transcript: _t, ...rest }) => rest),
    costUsd: {
      agent:
        Number(
          options.runs.reduce(
            (a, r) => a + (r.metrics?.agentCostNano ?? 0n),
            0n,
          ),
        ) / NANO,
      simulator: options.simulatorCostUsd,
    },
  };
}

function fmt(metric: MetricKey, value: number | undefined): string {
  if (value === undefined) return 'n/a';
  if (
    [
      'handoverCorrect',
      'languageMatch',
      'goalCompletion',
      'slotCorrection',
      'oneQuestion',
    ].includes(metric)
  )
    return `${(value * 100).toFixed(1)}%`;
  if (metric === 'p95LatencyMs') return `${Math.round(value)} ms`;
  if (metric === 'costPerConversationUsd') return `$${value.toFixed(5)}`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Absolute check against the frozen bar (relative v1 comparisons come later). */
export function verdict(
  metric: MetricKey,
  value: number | undefined,
  pack?: string,
): string {
  const threshold = THRESHOLDS.find((t) => t.metric === metric)!;
  if (threshold.judge) return 'not gating (judge uncalibrated)';
  if (value === undefined) return 'not measured';
  const limit =
    metric === 'goalCompletion' && pack && pack in GOAL_FLOOR
      ? GOAL_FLOOR[pack as keyof typeof GOAL_FLOOR]
      : threshold.limit;
  if (!Number.isFinite(limit)) return 'relative to v1 baseline';
  const ok = threshold.kind === 'max' ? value <= limit : value >= limit;
  return `${ok ? 'meets' : 'BELOW'} ${threshold.kind === 'max' ? '<=' : '>='} ${fmt(metric, limit)}${threshold.blocking ? ' (blocking)' : ''}`;
}

export function renderMarkdown(report: SimulationReport): string {
  const lines: string[] = [];
  const o = report.overall;
  lines.push(
    `# Simulation report — ${report.label}`,
    '',
    `Generated ${report.generatedAt}. Agent model: \`${report.agentModel}\`. Customer: ${report.customer}. Runs per scenario: ${report.runsPerScenario}.`,
    `Runs ${o.runs} (completed ${o.completed}, errors ${o.errors}, not runnable ${o.notRunnable}, **provider failures ${o.providerFailures}** — runs where the model provider failed and v1 handed over with LLM_UNAVAILABLE; they measure the provider, not the agent); scenario x language units ${o.scenarioUnits}, passed in every run ${o.unitsPassed}.`,
    `Cost: agent $${report.costUsd.agent.toFixed(4)}, simulator $${report.costUsd.simulator.toFixed(4)}.`,
    '',
    `**Retail: not runnable (pack missing)** — ${report.packMissingUnits} scenario x language units. They count as failed in "Overall"; "Excluding retail" leaves them out. Thresholds are unchanged (reporting only).`,
    '',
    '| Metric | Overall | Verdict (overall) | Excluding retail | Verdict (excluding retail) |',
    '|---|---|---|---|---|',
  );
  for (const t of THRESHOLDS)
    lines.push(
      `| ${t.label} | ${fmt(t.metric, o.values[t.metric])} | ${verdict(t.metric, o.values[t.metric])} | ${fmt(t.metric, report.overallExcludingRetail.values[t.metric])} | ${verdict(t.metric, report.overallExcludingRetail.values[t.metric])} |`,
    );
  lines.push(
    '',
    '| Pack / language | Units | Passed (pass^k) | Goal | Language | Handover | Invented | False claims | Errors | Not runnable |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const [key, g] of Object.entries(report.byPackLanguage))
    lines.push(
      `| ${key} | ${g.scenarioUnits} | ${g.unitsPassed} | ${fmt('goalCompletion', g.values.goalCompletion)} | ${fmt('languageMatch', g.values.languageMatch)} | ${fmt('handoverCorrect', g.values.handoverCorrect)} | ${fmt('inventedFacts', g.values.inventedFacts)} | ${fmt('falseSuccessClaims', g.values.falseSuccessClaims)} | ${g.errors} | ${g.notRunnable} |`,
    );
  const failing = report.runs.filter(
    (r) => !r.passed && r.status === 'completed',
  );
  if (failing.length) {
    lines.push('', '## Failed runs (first 60)', '');
    for (const r of failing.slice(0, 60)) {
      const m = r.metrics!;
      const why = [
        !m.goalCompleted && 'goal not reached',
        m.handoverCorrect === false && 'wrong/missing handover',
        m.languageMatched < m.languageChecked &&
          `language ${m.languageMatched}/${m.languageChecked}`,
        m.inventedFacts.length && `invented ${m.inventedFacts.join(',')}`,
        m.falseSuccessClaims && 'false success claim',
        m.crossTenantLeaks.length && 'cross-tenant title',
      ].filter(Boolean);
      lines.push(
        `- ${r.scenarioId} ${r.language} #${r.run}: ${why.join('; ')} (ended: ${r.endedBy})`,
      );
    }
  }
  const errors = report.runs.filter((r) => r.status !== 'completed');
  if (errors.length) {
    lines.push('', '## Not completed', '');
    const seen = new Set<string>();
    for (const r of errors) {
      const line = `- ${r.status}: ${r.reason}`;
      if (!seen.has(line)) lines.push(line);
      seen.add(line);
    }
  }
  return `${lines.join('\n')}\n`;
}
