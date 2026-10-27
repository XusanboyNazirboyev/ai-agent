import { laneId, runKey, type LedgerHeader, type LedgerRun } from './ledger.js';

/** INFRA-excluded units above this share make the pass rate meaningless. */
export const INFRA_INCOMPLETE_SHARE = 0.2;

export interface LaneCoverage {
  readonly unitsSelected: number;
  readonly runsExpected: number;
  /** Runs with any record. */
  readonly attempted: number;
  /** Runs whose latest record is AGENT or MODEL_FORMAT. */
  readonly completed: number;
  readonly infraExcluded: number;
  readonly modelFormat: number;
  readonly agent: number;
  readonly agentPassed: number;
  readonly notYetRun: number;
  /** Units (over all k) whose latest record is INFRA, as a share of selected runs. */
  readonly infraShare: number;
  readonly incomplete: boolean;
  /** Passed AGENT runs / (AGENT + MODEL_FORMAT); undefined when incomplete. */
  readonly passRate?: number;
}

export function laneCoverage(
  latest: ReadonlyMap<string, LedgerRun>,
  units: readonly string[],
  k: number,
): LaneCoverage {
  const keys = units.flatMap((u) =>
    Array.from({ length: k }, (_, i) => runKey(u, i + 1)),
  );
  const records = keys
    .map((key) => latest.get(key))
    .filter((r): r is LedgerRun => r !== undefined);
  const infraExcluded = records.filter((r) => r.class === 'INFRA').length;
  const modelFormat = records.filter((r) => r.class === 'MODEL_FORMAT').length;
  const agentRuns = records.filter((r) => r.class === 'AGENT');
  const infraShare = keys.length ? infraExcluded / keys.length : 0;
  const incomplete = infraShare > INFRA_INCOMPLETE_SHARE;
  const counted = agentRuns.length + modelFormat;
  return {
    unitsSelected: units.length,
    runsExpected: keys.length,
    attempted: records.length,
    completed: agentRuns.length + modelFormat,
    infraExcluded,
    modelFormat,
    agent: agentRuns.length,
    agentPassed: agentRuns.filter((r) => r.passed).length,
    notYetRun: keys.length - records.length,
    infraShare,
    incomplete,
    passRate:
      incomplete || counted === 0
        ? undefined
        : agentRuns.filter((r) => r.passed).length / counted,
  };
}

export interface Provenance {
  readonly header: LedgerHeader;
  readonly subset:
    { name: string; sha256: string } | { name: 'full'; units: number };
  readonly k: number;
  readonly pricingVersion: string;
  /** Where the pacing limits came from: official URL + date, or "preset (unverified)". */
  readonly limitsSources: readonly string[];
  readonly generatedAt: string;
}

const pct = (v: number | undefined): string =>
  v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;

export function renderLaneReport(
  provenance: Provenance,
  latest: ReadonlyMap<string, LedgerRun>,
  units: readonly string[],
): string {
  const c = laneCoverage(latest, units, provenance.k);
  const runs = units
    .flatMap((u) =>
      Array.from({ length: provenance.k }, (_, i) =>
        latest.get(runKey(u, i + 1)),
      ),
    )
    .filter((r): r is LedgerRun => r !== undefined && r.class !== 'INFRA');
  const sum = (f: (r: LedgerRun) => number): number =>
    runs.reduce((a, r) => a + f(r), 0);
  const subset =
    provenance.subset.name === 'full'
      ? `full suite (${'units' in provenance.subset ? provenance.subset.units : units.length} units, retail excluded)`
      : `${provenance.subset.name} (sha256 ${'sha256' in provenance.subset ? provenance.subset.sha256.slice(0, 12) : ''})`;
  const lines = [
    `# Free-tier baseline — ${laneId(provenance.header.lane)}`,
    '',
    '**MEASUREMENT ONLY — not a gate.** Thresholds are untouched; no pass/fail verdict is drawn from a free-tier run until a paid run exists.',
    '',
    `- Lane: provider \`${provenance.header.lane.provider}\`, fast \`${provenance.header.lane.fast}\`, strong \`${provenance.header.lane.strong}\``,
    `- Agent commit \`${provenance.header.commit}\`; scenario-set sha256 \`${provenance.header.suiteHash}\``,
    `- Units: ${subset}; k = ${provenance.k}; pricing ${provenance.pricingVersion}`,
    `- Pacing limits from: ${provenance.limitsSources.join('; ')}`,
    `- Generated ${provenance.generatedAt}; ledger started ${provenance.header.createdAt}`,
    '',
    '| Coverage | Runs |',
    '|---|---|',
    `| Expected (units x k) | ${c.runsExpected} |`,
    `| Attempted | ${c.attempted} |`,
    `| Completed (AGENT + MODEL-FORMAT) | ${c.completed} |`,
    `| INFRA-excluded (quota, throttle, timeout, 5xx, network) | ${c.infraExcluded} (${pct(c.infraShare)}) |`,
    `| MODEL-FORMAT (provider rejected the model output format; counted as failed) | ${c.modelFormat} |`,
    `| AGENT (passed / total) | ${c.agentPassed} / ${c.agent} |`,
    `| Not yet run | ${c.notYetRun} |`,
    '',
    c.incomplete
      ? `**INCOMPLETE - no pass rate** (INFRA-excluded ${pct(c.infraShare)} > ${pct(INFRA_INCOMPLETE_SHARE)} of runs).`
      : c.notYetRun > 0
        ? `Pass rate so far: ${pct(c.passRate)} of ${c.completed} completed runs (**partial**: ${c.notYetRun} runs not yet run).`
        : `Pass rate: ${pct(c.passRate)} of ${c.completed} completed runs (INFRA-excluded runs left out).`,
    '',
    `Completed runs: invented facts ${sum((r) => r.inventedFacts ?? 0)}, false success claims ${sum((r) => r.falseSuccessClaims ?? 0)}, language/script ${sum((r) => r.languageMatched ?? 0)}/${sum((r) => r.languageChecked ?? 0)}, goal reached ${runs.filter((r) => r.goalCompleted).length}/${runs.length}.`,
  ];
  const infra = [...latest.values()].filter(
    (r) => r.class === 'INFRA' && units.includes(r.unitId),
  );
  if (infra.length) {
    const reasons = new Map<string, number>();
    for (const r of infra)
      reasons.set(
        r.reason ?? 'unknown',
        (reasons.get(r.reason ?? 'unknown') ?? 0) + 1,
      );
    lines.push(
      '',
      `INFRA reasons: ${[...reasons].map(([k, v]) => `${k} x${v}`).join(', ')}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
