/**
 * Wall-clock stage timings of one agent turn (latency audit 2026-11-10).
 * Only durations and counts: no text, ids or facts. The stages add up to
 * `totalMs`: `otherMs` is the deterministic code between the named stages
 * (slot merge, intent routing, language-before-facts gate, rendering).
 */
export interface TurnTimings {
  /** runAgentTurn from start to result. */
  readonly totalMs: number;
  /** Tier-0 gates before any model call (language, opt-out, confirmation). */
  readonly gatesMs: number;
  /** The FAST structured extraction call. */
  readonly extractMs: number;
  /** Code-driven catalog, knowledge or scheduling-context search. */
  readonly searchMs: number;
  /** STRONG reply drafting, its tool rounds and the one regeneration. */
  readonly respondMs: number;
  /** Tool executions requested by the model, part of `respondMs`. */
  readonly respondToolMs: number;
  /** Guardrail checks of drafts and of the code-rendered fallback. */
  readonly guardrailMs: number;
  /** Everything else; `totalMs` minus the stages above (except tools). */
  readonly otherMs: number;
  /** STRONG model calls (tool rounds plus the final draft and any retry). */
  readonly respondRounds: number;
  /** Tool executions requested by the model. */
  readonly toolExecutions: number;
}

export type TimedStage =
  'extract' | 'search' | 'respond' | 'respondTool' | 'guardrail';

/** Accumulates stage durations for one turn; never throws. */
export class TurnStopwatch {
  private readonly started: number;
  private gatesEnd: number | undefined;
  private readonly spent: Record<TimedStage, number> = {
    extract: 0,
    search: 0,
    respond: 0,
    respondTool: 0,
    guardrail: 0,
  };
  private rounds = 0;
  private toolRuns = 0;

  constructor(private readonly clock: () => number) {
    this.started = clock();
  }

  /** Ends the tier-0 gate stage (first call wins). */
  gatesDone(): void {
    this.gatesEnd ??= this.clock();
  }

  countRound(): void {
    this.rounds += 1;
  }

  countToolExecution(): void {
    this.toolRuns += 1;
  }

  /** Starts timing a stage; the returned function stops it (once). */
  begin(stage: TimedStage): () => void {
    const start = this.clock();
    let done = false;
    return (): void => {
      if (done) return;
      done = true;
      this.spent[stage] += this.clock() - start;
    };
  }

  async time<T>(stage: TimedStage, work: () => Promise<T>): Promise<T> {
    const start = this.clock();
    try {
      return await work();
    } finally {
      this.spent[stage] += this.clock() - start;
    }
  }

  timeSync<T>(stage: TimedStage, work: () => T): T {
    const start = this.clock();
    try {
      return work();
    } finally {
      this.spent[stage] += this.clock() - start;
    }
  }

  snapshot(): TurnTimings {
    const end = this.clock();
    const totalMs = end - this.started;
    // A turn that ended before extraction spent all its time in the gates.
    const gatesMs = (this.gatesEnd ?? end) - this.started;
    const s = this.spent;
    const named = gatesMs + s.extract + s.search + s.respond + s.guardrail;
    return {
      totalMs: round(totalMs),
      gatesMs: round(gatesMs),
      extractMs: round(s.extract),
      searchMs: round(s.search),
      respondMs: round(s.respond),
      respondToolMs: round(s.respondTool),
      guardrailMs: round(s.guardrail),
      otherMs: round(Math.max(0, totalMs - named)),
      respondRounds: this.rounds,
      toolExecutions: this.toolRuns,
    };
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
