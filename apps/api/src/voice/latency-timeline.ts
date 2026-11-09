/**
 * Per-turn stage timestamps and the latency report (ADR 045: target 0.7-1.2 s,
 * hard limit 1.5 s from caller end-of-speech to first audible audio).
 */

export const TURN_STAGES = [
  'callerEndOfSpeech',
  'sttFinal',
  'llmFirstToken',
  'firstSentenceReady',
  'ttsFirstAudio',
  'playbackStart',
] as const;
export type TurnStage = (typeof TURN_STAGES)[number];

/** Duration names: time spent reaching each stage from the previous one. */
export const STAGE_SEGMENTS = [
  'stt',
  'llm',
  'sentence',
  'tts',
  'playback',
] as const;
export type StageSegment = (typeof STAGE_SEGMENTS)[number];

export class VoiceTurnTimeline {
  private readonly marks = new Map<TurnStage, number>();

  constructor(readonly turnIndex: number) {}

  /** First mark of a stage wins (later sentences do not move it). */
  mark(stage: TurnStage, atMs: number): void {
    if (!this.marks.has(stage)) this.marks.set(stage, atMs);
  }

  at(stage: TurnStage): number | undefined {
    return this.marks.get(stage);
  }

  isComplete(): boolean {
    return TURN_STAGES.every((s) => this.marks.has(s));
  }

  /** Per-segment durations; undefined when the turn is incomplete. */
  segments(): Record<StageSegment, number> | undefined {
    if (!this.isComplete()) return undefined;
    const t = (s: TurnStage): number => this.marks.get(s) as number;
    return {
      stt: t('sttFinal') - t('callerEndOfSpeech'),
      llm: t('llmFirstToken') - t('sttFinal'),
      sentence: t('firstSentenceReady') - t('llmFirstToken'),
      tts: t('ttsFirstAudio') - t('firstSentenceReady'),
      playback: t('playbackStart') - t('ttsFirstAudio'),
    };
  }

  endToEndMs(): number | undefined {
    if (!this.isComplete()) return undefined;
    return (
      (this.marks.get('playbackStart') as number) -
      (this.marks.get('callerEndOfSpeech') as number)
    );
  }
}

export interface LatencyBudget {
  /** Upper end of the owner target; p95 above it fails. */
  readonly targetMs: number;
  /** No single turn may exceed this. */
  readonly hardLimitMs: number;
  /** Soft per-segment allowances (p95); they name the stage that blew it. */
  readonly segmentMs: Readonly<Record<StageSegment, number>>;
}

export const OWNER_LATENCY_BUDGET: LatencyBudget = {
  targetMs: 1200,
  hardLimitMs: 1500,
  segmentMs: { stt: 250, llm: 400, sentence: 250, tts: 200, playback: 100 },
};

export interface Stats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentile on a non-empty sample. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function statsOf(values: readonly number[]): Stats {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}

export interface LatencyVerdict {
  readonly pass: boolean;
  /** Human-readable reasons, empty on pass. */
  readonly reasons: readonly string[];
  /** Segments whose p95 is over their allowance, worst overage first. */
  readonly blownStages: readonly StageSegment[];
}

export interface LatencyReport {
  readonly turns: number;
  readonly incompleteTurns: number;
  readonly perStage: Readonly<Record<StageSegment, Stats>>;
  readonly endToEnd: Stats;
  readonly budget: LatencyBudget;
  readonly verdict: LatencyVerdict;
}

export function buildLatencyReport(
  timelines: readonly VoiceTurnTimeline[],
  budget: LatencyBudget = OWNER_LATENCY_BUDGET,
): LatencyReport {
  const complete = timelines.filter((t) => t.isComplete());
  const incompleteTurns = timelines.length - complete.length;
  if (complete.length === 0) {
    const zero: Stats = { p50: 0, p95: 0, max: 0 };
    return {
      turns: 0,
      incompleteTurns,
      perStage: Object.fromEntries(
        STAGE_SEGMENTS.map((s) => [s, zero]),
      ) as Record<StageSegment, Stats>,
      endToEnd: zero,
      budget,
      verdict: {
        pass: false,
        reasons: ['no complete turns were measured'],
        blownStages: [],
      },
    };
  }
  const perStage = Object.fromEntries(
    STAGE_SEGMENTS.map((s) => [
      s,
      statsOf(
        complete.map((t) => (t.segments() as Record<StageSegment, number>)[s]),
      ),
    ]),
  ) as Record<StageSegment, Stats>;
  const endToEnd = statsOf(complete.map((t) => t.endToEndMs() as number));

  const reasons: string[] = [];
  if (endToEnd.max > budget.hardLimitMs) {
    reasons.push(
      `max end-to-end ${endToEnd.max} ms exceeds the hard limit ${budget.hardLimitMs} ms`,
    );
  }
  if (endToEnd.p95 > budget.targetMs) {
    reasons.push(
      `p95 end-to-end ${endToEnd.p95} ms exceeds the target ${budget.targetMs} ms`,
    );
  }
  if (incompleteTurns > 0) {
    reasons.push(`${incompleteTurns} turn(s) never reached first audio`);
  }
  const over = STAGE_SEGMENTS.map((s) => ({
    stage: s,
    overage: perStage[s].p95 - budget.segmentMs[s],
  }))
    .filter((x) => x.overage > 0)
    .sort((a, b) => b.overage - a.overage);
  const failed = reasons.length > 0;
  return {
    turns: complete.length,
    incompleteTurns,
    perStage,
    endToEnd,
    budget,
    // Segment overages are only reported as culprits when the total failed.
    verdict: {
      pass: !failed,
      reasons,
      blownStages: failed ? over.map((x) => x.stage) : [],
    },
  };
}

export function formatLatencyReport(report: LatencyReport): string {
  const row = (name: string, s: Stats, allow?: number): string =>
    `${name.padEnd(12)} p50 ${String(s.p50).padStart(5)}  p95 ${String(s.p95).padStart(5)}  max ${String(s.max).padStart(5)}` +
    (allow === undefined ? '' : `  (allow ${allow})`);
  const lines = [
    `turns measured: ${report.turns} (incomplete: ${report.incompleteTurns})`,
    ...STAGE_SEGMENTS.map((s) =>
      row(s, report.perStage[s], report.budget.segmentMs[s]),
    ),
    row('end-to-end', report.endToEnd),
    `budget: target <= ${report.budget.targetMs} ms (p95), hard limit ${report.budget.hardLimitMs} ms (max)`,
    `verdict: ${report.verdict.pass ? 'PASS' : 'FAIL'}`,
    ...report.verdict.reasons.map((r) => `  - ${r}`),
    ...(report.verdict.blownStages.length > 0
      ? [`  over-budget stages: ${report.verdict.blownStages.join(', ')}`]
      : []),
  ];
  return lines.join('\n');
}
