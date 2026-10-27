import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Free-tier baseline results (ADR 026 slice 1c). A lane is one provider with
 * one fast and one strong model; baselines are only ever compared within a
 * lane. Results are append-only JSONL, one file per (lane, agent commit,
 * scenario-set hash): runs of a different commit or scenario set can never
 * be mixed, they go to another file. A run's identity is
 * (lane, unit id, k index, scenario-set hash, agent commit).
 */
export interface Lane {
  readonly provider: string;
  readonly fast: string;
  readonly strong: string;
}

export const laneId = (lane: Lane): string =>
  `${lane.provider}:${lane.fast}|${lane.strong}`;

/** File-system-safe lane name. */
export const laneSlug = (lane: Lane): string =>
  laneId(lane).replace(/[^A-Za-z0-9._-]+/gu, '_');

/** Classification of one run (amendment 2). */
export type RunClass = 'AGENT' | 'MODEL_FORMAT' | 'INFRA';

export interface LedgerHeader {
  readonly type: 'header';
  readonly lane: Lane;
  readonly commit: string;
  readonly suiteHash: string;
  /** Simulated connector profile; absent = the default mock. */
  readonly profile?: string;
  readonly createdAt: string;
}

export interface LedgerRun {
  readonly type: 'run';
  readonly unitId: string;
  readonly k: number;
  readonly class: RunClass;
  /** Only meaningful for AGENT and MODEL_FORMAT runs. */
  readonly passed: boolean;
  /** Why INFRA/MODEL_FORMAT (e.g. "quota:per-day", "throttle", "5xx", "json_schema"). */
  readonly reason?: string;
  readonly goalCompleted?: boolean;
  readonly handoverReasons?: readonly string[];
  readonly inventedFacts?: number;
  readonly falseSuccessClaims?: number;
  readonly languageMatched?: number;
  readonly languageChecked?: number;
  readonly customerTurns: number;
  readonly agentInputTokens?: number;
  readonly agentOutputTokens?: number;
  readonly latenciesMs?: readonly number[];
  /** Flagged-number classes of blocked drafts (ADR 029 diagnostics). */
  readonly blockedNumberClasses?: Readonly<Record<string, number>>;
  readonly finishedAt: string;
}

/** SHA-256 over the sorted scenario files (path + content). */
export function suiteHash(scenarioRoot: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.json')
          ? [join(dir, entry.name)]
          : [],
    );
  for (const file of walk(scenarioRoot)
    .filter((f) => !f.includes(`${'/'}subsets${'/'}`))
    .sort()) {
    hash.update(file.slice(scenarioRoot.length));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export const runKey = (unitId: string, k: number): string => `${unitId}#${k}`;

export class BaselineLedger {
  private constructor(
    readonly file: string,
    readonly header: LedgerHeader,
    private readonly runs: LedgerRun[],
  ) {}

  /**
   * The file a (lane, commit, suite, connector profile) identity lives in.
   * The default mock keeps the original name, so earlier ledgers stay valid.
   */
  static fileFor(
    root: string,
    lane: Lane,
    commit: string,
    suite: string,
    profile = 'mock',
  ): string {
    const suffix = profile === 'mock' ? '' : `-${profile}`;
    return join(
      root,
      laneSlug(lane),
      `${commit.slice(0, 12)}-${suite.slice(0, 12)}${suffix}.jsonl`,
    );
  }

  /**
   * Opens the ledger of this identity, creating it if needed. Refuses a file
   * whose header names another lane, commit or scenario set (amendment 1).
   */
  static open(
    root: string,
    lane: Lane,
    commit: string,
    suite: string,
    profile = 'mock',
  ): BaselineLedger {
    const file = BaselineLedger.fileFor(root, lane, commit, suite, profile);
    const header: LedgerHeader = {
      type: 'header',
      lane,
      commit,
      suiteHash: suite,
      ...(profile === 'mock' ? {} : { profile }),
      createdAt: new Date().toISOString(),
    };
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(header)}\n`);
      return new BaselineLedger(file, header, []);
    }
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const stored = JSON.parse(lines[0] ?? '{}') as LedgerHeader;
    if (
      stored.type !== 'header' ||
      laneId(stored.lane) !== laneId(lane) ||
      stored.commit !== commit ||
      stored.suiteHash !== suite ||
      (stored.profile ?? 'mock') !== profile
    )
      throw new Error(
        `ledger ${file} belongs to another lane/commit/scenario set/profile; refusing to mix results`,
      );
    const runs = lines.slice(1).map((line) => JSON.parse(line) as LedgerRun);
    return new BaselineLedger(file, stored, runs);
  }

  append(run: LedgerRun): void {
    appendFileSync(this.file, `${JSON.stringify(run)}\n`);
    this.runs.push(run);
  }

  /** Latest record per run identity. */
  latest(): Map<string, LedgerRun> {
    const out = new Map<string, LedgerRun>();
    for (const run of this.runs) out.set(runKey(run.unitId, run.k), run);
    return out;
  }

  /** Runs still to do: never recorded, or whose latest record is INFRA. */
  pending(
    units: readonly string[],
    k: number,
  ): { unitId: string; k: number }[] {
    const latest = this.latest();
    const todo: { unitId: string; k: number }[] = [];
    for (let index = 1; index <= k; index += 1)
      for (const unitId of units) {
        const last = latest.get(runKey(unitId, index));
        if (!last || last.class === 'INFRA') todo.push({ unitId, k: index });
      }
    return todo;
  }
}
