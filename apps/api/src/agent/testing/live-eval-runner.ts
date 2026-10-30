import type { BudgetLimits } from '../../core/llm/budget.js';
import type { LlmProvider } from '../../core/llm/llm-provider.js';
import { nanoToUsd } from '../../core/llm/pricing.js';
import {
  runCase,
  type EvalCase,
  type EvalDiagnostics,
  type EvalOutcome,
} from './eval-runner.js';

/**
 * Model-comparison evaluation (AGENTS.md §12). Runs the same cases against
 * one or more configured models and reports quality, validity, latency and
 * cost per model. The spending cap is shared by the whole run and checked
 * before every model call, so a run can never exceed it; cases left over
 * once the cap is reached are reported as not run.
 */

export interface EvaluatedModel {
  /** Provider id and model name, printed in the report for comparison. */
  readonly provider: string;
  readonly model: string;
  /** Pricing snapshot covering this model (default: Anthropic snapshot). */
  readonly pricingVersion?: string;
  /** Provider for a case: one shared live client, or a script per case. */
  readonly providerFor: (evalCase: EvalCase) => LlmProvider;
}

export interface ModelRun {
  readonly provider: string;
  readonly model: string;
  readonly outcomes: readonly EvalOutcome[];
  readonly notRun: number;
}

export interface Rate {
  readonly passed: number;
  readonly total: number;
}

export interface ModelReport {
  readonly provider: string;
  readonly model: string;
  readonly cases: number;
  readonly notRun: number;
  readonly passRate: Rate;
  readonly byLocale: Readonly<Record<string, Rate>>;
  readonly byCategory: Readonly<Record<string, Rate>>;
  readonly toolCallValidity: Rate;
  readonly structuredOutputValidity: Rate;
  /** Unsourced facts that reached a reply; the gate requires 0. */
  readonly hardFactViolations: number;
  /** Fact violations caught by the guardrail before sending. */
  readonly blockedFactViolations: number;
  readonly handoverCorrectness: Rate;
  readonly languageScriptMatch: Rate;
  /** Expected slots that ended with the expected value, over all cases. */
  readonly slotExtractionAccuracy: Rate;
  /** Mean tool rounds per turn. */
  readonly avgToolRounds: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: string;
  /** Every run case with the typed reasons it ended as it did. */
  readonly caseResults: readonly CaseResult[];
}

export interface CaseResult {
  readonly id: string;
  readonly category: string;
  readonly locale: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly diagnostics: EvalDiagnostics;
}

export interface EvaluationReport {
  readonly mode: 'scripted' | 'live';
  readonly generatedAt: string;
  readonly budgetUsd: string;
  readonly spentUsd: string;
  readonly models: readonly ModelReport[];
}

export async function runEvaluation(options: {
  readonly cases: readonly EvalCase[];
  readonly models: readonly EvaluatedModel[];
  readonly budgetNano: number;
  /** Optional whole-run token cap, checked before every call. */
  readonly budgetTokens?: number;
  readonly mode: 'scripted' | 'live';
  readonly onCase?: (model: EvaluatedModel, outcome: EvalOutcome) => void;
  /** Per-turn limit overrides, e.g. output ceiling and calls per turn. */
  readonly limits?: Partial<BudgetLimits>;
  /**
   * Hard bounds checked BEFORE each case: a case is started only if a full
   * turn (`limits.maxCallsPerTurn`) still fits in `maxCalls` and the runtime
   * is under `maxRuntimeMs`.
   */
  readonly maxCalls?: number;
  readonly maxRuntimeMs?: number;
  readonly clock?: () => number;
}): Promise<{
  runs: ModelRun[];
  spentNano: number;
  spentTokens: number;
  calls: number;
  stoppedBy: 'calls' | 'runtime' | 'budget' | undefined;
}> {
  let spent = 0;
  let tokens = 0;
  let calls = 0;
  let stoppedBy: 'calls' | 'runtime' | 'budget' | undefined;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const perTurn = options.limits?.maxCallsPerTurn ?? 6;
  const runs: ModelRun[] = [];
  for (const model of options.models) {
    const outcomes: EvalOutcome[] = [];
    let stopped = false;
    for (const evalCase of options.cases) {
      if (stopped) break;
      if (
        options.maxCalls !== undefined &&
        calls + perTurn > options.maxCalls
      ) {
        stoppedBy = 'calls';
        break;
      }
      if (
        options.maxRuntimeMs !== undefined &&
        clock() - started >= options.maxRuntimeMs
      ) {
        stoppedBy = 'runtime';
        break;
      }
      const outcome = await runCase(
        evalCase,
        model.providerFor(evalCase),
        options.mode,
        {
          ...(model.pricingVersion
            ? { pricingVersion: model.pricingVersion }
            : {}),
          ...(options.limits ? { limits: options.limits } : {}),
          runBudget: {
            capNano: options.budgetNano,
            spentNano: spent,
            capTokens: options.budgetTokens,
            spentTokens: tokens,
          },
        },
      );
      spent += outcome.costNano;
      tokens += outcome.inputTokens + outcome.outputTokens;
      calls += outcome.providerCalls;
      if (outcome.budgetStopped) {
        // The cap refused a call: this case is incomplete, stop the run.
        stopped = true;
        stoppedBy = 'budget';
        continue;
      }
      outcomes.push(outcome);
      options.onCase?.(model, outcome);
    }
    runs.push({
      provider: model.provider,
      model: model.model,
      outcomes,
      notRun: options.cases.length - outcomes.length,
    });
  }
  return { runs, spentNano: spent, spentTokens: tokens, calls, stoppedBy };
}

function rate(values: readonly (boolean | undefined)[]): Rate {
  const defined = values.filter((value) => value !== undefined);
  return {
    passed: defined.filter(Boolean).length,
    total: defined.length,
  };
}

function groupRate(
  outcomes: readonly EvalOutcome[],
  key: (outcome: EvalOutcome) => string,
): Record<string, Rate> {
  const groups: Record<string, EvalOutcome[]> = {};
  for (const outcome of outcomes) (groups[key(outcome)] ??= []).push(outcome);
  return Object.fromEntries(
    Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => [name, rate(list.map((o) => o.passed))]),
  );
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function modelReport(run: ModelRun): ModelReport {
  const o = run.outcomes;
  const totalTools = o.reduce((sum, x) => sum + x.modelToolCalls, 0);
  const invalidTools = o.reduce((sum, x) => sum + x.invalidToolCalls, 0);
  return {
    provider: run.provider,
    model: run.model,
    cases: o.length,
    notRun: run.notRun,
    passRate: rate(o.map((x) => x.passed)),
    byLocale: groupRate(o, (x) => x.locale),
    byCategory: groupRate(o, (x) => x.category),
    toolCallValidity: { passed: totalTools - invalidTools, total: totalTools },
    structuredOutputValidity: rate(o.map((x) => x.structuredOk)),
    hardFactViolations: o.reduce((sum, x) => sum + x.hardFactViolations, 0),
    blockedFactViolations: o.reduce(
      (sum, x) => sum + x.blockedFactViolations,
      0,
    ),
    handoverCorrectness: rate(o.map((x) => x.handoverOk)),
    languageScriptMatch: rate(o.map((x) => x.localeOk && (x.scriptOk ?? true))),
    slotExtractionAccuracy: {
      passed: o.reduce((sum, x) => sum + x.slotsMatched, 0),
      total: o.reduce((sum, x) => sum + x.slotsExpected, 0),
    },
    avgToolRounds:
      Math.round(
        (1000 * o.reduce((sum, x) => sum + x.toolRounds, 0)) /
          Math.max(1, o.length),
      ) / 1000,
    latencyMs: {
      p50: percentile(
        o.map((x) => x.latencyMs),
        50,
      ),
      p95: percentile(
        o.map((x) => x.latencyMs),
        95,
      ),
    },
    inputTokens: o.reduce((sum, x) => sum + x.inputTokens, 0),
    outputTokens: o.reduce((sum, x) => sum + x.outputTokens, 0),
    costUsd: nanoToUsd(o.reduce((sum, x) => sum + x.costNano, 0)),
    caseResults: o.map((x) => ({
      id: x.id,
      category: x.category,
      locale: x.locale,
      passed: x.passed,
      failures: x.failures,
      diagnostics: x.diagnostics,
    })),
  };
}

export function buildReport(input: {
  readonly mode: 'scripted' | 'live';
  readonly runs: readonly ModelRun[];
  readonly budgetNano: number;
  readonly spentNano: number;
  readonly now?: Date;
}): EvaluationReport {
  return {
    mode: input.mode,
    generatedAt: (input.now ?? new Date()).toISOString(),
    budgetUsd: nanoToUsd(input.budgetNano),
    spentUsd: nanoToUsd(input.spentNano),
    models: input.runs.map(modelReport),
  };
}

const pct = (r: Rate): string =>
  r.total === 0
    ? 'n/a'
    : `${((100 * r.passed) / r.total).toFixed(1)}% (${r.passed}/${r.total})`;

/** Markdown summary; provider and model are always named. */
export function renderMarkdown(report: EvaluationReport): string {
  const lines = [
    `# Agent evaluation (${report.mode})`,
    '',
    `Generated ${report.generatedAt}. Budget $${report.budgetUsd}, spent $${report.spentUsd}.`,
    '',
    '| Provider | Model | Cases | Not run | Pass | Tool calls valid | Structured valid | Hard-fact violations shipped | Fact drafts blocked | Handover correct | Language/script | Slot accuracy | Tool rounds (avg) | p50 ms | p95 ms | Cost USD |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.models.map(
      (m) =>
        `| ${m.provider} | ${m.model} | ${m.cases} | ${m.notRun} | ${pct(m.passRate)} | ${pct(m.toolCallValidity)} | ${pct(m.structuredOutputValidity)} | ${m.hardFactViolations} | ${m.blockedFactViolations} | ${pct(m.handoverCorrectness)} | ${pct(m.languageScriptMatch)} | ${pct(m.slotExtractionAccuracy)} | ${m.avgToolRounds} | ${m.latencyMs.p50} | ${m.latencyMs.p95} | ${m.costUsd} |`,
    ),
  ];
  for (const m of report.models) {
    lines.push(
      '',
      `## ${m.provider} / ${m.model}`,
      '',
      '| Locale | Pass |',
      '|---|---|',
    );
    for (const [name, r] of Object.entries(m.byLocale))
      lines.push(`| ${name} | ${pct(r)} |`);
    lines.push('', '| Category | Pass |', '|---|---|');
    for (const [name, r] of Object.entries(m.byCategory))
      lines.push(`| ${name} | ${pct(r)} |`);
    const failed = m.caseResults.filter((c) => !c.passed);
    if (failed.length > 0) {
      lines.push(
        '',
        '| Failed case | Extraction | Intent | Draft | Turn outcome | Handover |',
        '|---|---|---|---|---|---|',
      );
      for (const c of failed)
        lines.push(
          `| ${c.id} | ${c.diagnostics.extractionFailure ?? 'ok'} | ${c.diagnostics.intent ?? '-'} | ${c.diagnostics.draftFailure ?? 'ok'} | ${c.diagnostics.turnOutcome} | ${c.diagnostics.handover ?? '-'} |`,
        );
    }
  }
  return `${lines.join('\n')}\n`;
}
