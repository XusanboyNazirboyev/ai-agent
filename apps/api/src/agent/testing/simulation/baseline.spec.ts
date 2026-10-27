import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { laneCoverage, renderLaneReport } from './baseline-report.js';
import {
  BaselineLedger,
  laneSlug,
  runKey,
  suiteHash,
  type Lane,
  type LedgerRun,
} from './ledger.js';
import { loadScenarios } from './scenario.js';
import { fullUnits, loadSubset, subsetHash } from './subsets.js';

const root = resolve(import.meta.dirname, '../../../../../..');
const scenarioRoot = resolve(root, 'eval/scenarios');
const scenarios = loadScenarios(scenarioRoot);
const lane: Lane = {
  provider: 'groq',
  fast: 'openai/gpt-oss-20b',
  strong: 'openai/gpt-oss-120b',
};

const run = (
  unitId: string,
  k: number,
  cls: LedgerRun['class'],
  passed = false,
  reason?: string,
): LedgerRun => ({
  type: 'run',
  unitId,
  k,
  class: cls,
  passed,
  reason,
  customerTurns: 1,
  finishedAt: '2026-10-26T00:00:00.000Z',
});

describe('baseline ledger (amendment 1)', () => {
  it('keys files by lane, commit and scenario set, and resumes only missing or INFRA runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const ledger = BaselineLedger.open(
      dir,
      lane,
      'a'.repeat(40),
      'b'.repeat(64),
    );
    expect(ledger.file).toContain(laneSlug(lane));
    ledger.append(run('edu-01/en', 1, 'AGENT', true));
    ledger.append(run('edu-02/en', 1, 'INFRA', false, 'quota:per-day'));
    ledger.append(run('edu-03/en', 1, 'MODEL_FORMAT', false, 'json_schema'));
    const reopened = BaselineLedger.open(
      dir,
      lane,
      'a'.repeat(40),
      'b'.repeat(64),
    );
    expect(
      reopened.pending(['edu-01/en', 'edu-02/en', 'edu-03/en', 'edu-04/en'], 1),
    ).toEqual([
      { unitId: 'edu-02/en', k: 1 },
      { unitId: 'edu-04/en', k: 1 },
    ]);
    // A later successful retry of an INFRA run replaces it.
    reopened.append(run('edu-02/en', 1, 'AGENT', false));
    expect(reopened.latest().get(runKey('edu-02/en', 1))?.class).toBe('AGENT');
  });

  it('never mixes results: another commit or scenario set is another file; a forged header is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const a = BaselineLedger.open(dir, lane, 'a'.repeat(40), 'b'.repeat(64));
    const b = BaselineLedger.open(dir, lane, 'c'.repeat(40), 'b'.repeat(64));
    const c = BaselineLedger.open(dir, lane, 'a'.repeat(40), 'd'.repeat(64));
    const d = BaselineLedger.open(
      dir,
      lane,
      'a'.repeat(40),
      'b'.repeat(64),
      'eduflow-nocurrency',
    );
    expect(d.file).not.toBe(a.file);
    expect(d.header.profile).toBe('eduflow-nocurrency');
    writeFileSync(
      d.file,
      `${JSON.stringify({ type: 'header', lane, commit: 'a'.repeat(40), suiteHash: 'b'.repeat(64), createdAt: 'x' })}\n`,
    );
    expect(() =>
      BaselineLedger.open(
        dir,
        lane,
        'a'.repeat(40),
        'b'.repeat(64),
        'eduflow-nocurrency',
      ),
    ).toThrow(/refusing to mix/u);
    expect(new Set([a.file, b.file, c.file]).size).toBe(3);
    writeFileSync(
      a.file,
      `${JSON.stringify({ type: 'header', lane, commit: 'e'.repeat(40), suiteHash: 'b'.repeat(64), createdAt: 'x' })}\n`,
    );
    expect(() =>
      BaselineLedger.open(dir, lane, 'a'.repeat(40), 'b'.repeat(64)),
    ).toThrow(/refusing to mix/u);
    const otherLane: Lane = { ...lane, strong: 'openai/gpt-oss-20b' };
    expect(
      BaselineLedger.fileFor(dir, otherLane, 'a'.repeat(40), 'b'.repeat(64)),
    ).not.toBe(a.file);
  });

  it('hashes the scenario set deterministically and ignores subset files', () => {
    expect(suiteHash(scenarioRoot)).toMatch(/^[0-9a-f]{64}$/u);
    expect(suiteHash(scenarioRoot)).toBe(suiteHash(scenarioRoot));
  });
});

describe('core-30 subset (amendment 5)', () => {
  const subset = loadSubset(scenarioRoot, 'core-30', scenarios);

  it('is the recorded list with its recorded hash', () => {
    expect(subset.units).toHaveLength(30);
    expect(subsetHash(subset.units)).toBe(subset.sha256);
    expect(subset.sha256).toBe(
      'b9b7d28cb774b5edf541e7bbb913bfff6875142081adf216e266119c6cdbc6f3',
    );
  });

  it('is stratified by vertical, language and scenario type', () => {
    const pack = (u: string): string => u.split('-')[0];
    const language = (u: string): string => u.split('/')[1];
    expect(subset.units.filter((u) => pack(u) === 'edu')).toHaveLength(20);
    expect(subset.units.filter((u) => pack(u) === 'tour')).toHaveLength(10);
    const byLanguage = Object.fromEntries(
      ['uz-Latn', 'uz-Cyrl', 'ru', 'en'].map((l) => [
        l,
        subset.units.filter((u) => language(u) === l).length,
      ]),
    );
    expect(byLanguage).toEqual({ 'uz-Latn': 9, 'uz-Cyrl': 2, ru: 9, en: 10 });
    const categories = new Set(
      subset.units.map(
        (u) => scenarios.find((s) => s.id === u.split('/')[0])!.category,
      ),
    );
    for (const c of [
      'search',
      'correction',
      'negotiation',
      'handover',
      'regulated',
      'follow_up',
      'price',
      'alternatives',
      'objection',
      'action_confirm',
      'action_decline',
      'injection',
      'stuck',
      'high_value',
      'complaint',
    ])
      expect(categories.has(c), c).toBe(true);
  });

  it('the full suite is the 130 runnable units (retail excluded)', () => {
    expect(fullUnits(scenarios)).toHaveLength(130);
  });
});

describe('lane coverage report (amendment 2)', () => {
  const units = Array.from(
    { length: 10 },
    (_, i) => `edu-${String(i + 1).padStart(2, '0')}/en`,
  );
  const latest = (records: LedgerRun[]): Map<string, LedgerRun> =>
    new Map(records.map((r) => [runKey(r.unitId, r.k), r]));

  it('counts attempted, completed, INFRA, MODEL-FORMAT and AGENT; pass rate excludes INFRA', () => {
    const c = laneCoverage(
      latest([
        run(units[0], 1, 'AGENT', true),
        run(units[1], 1, 'AGENT', false),
        run(units[2], 1, 'MODEL_FORMAT'),
        run(units[3], 1, 'INFRA', false, 'throttle'),
      ]),
      units,
      1,
    );
    expect(c).toMatchObject({
      runsExpected: 10,
      attempted: 4,
      completed: 3,
      infraExcluded: 1,
      modelFormat: 1,
      agent: 2,
      agentPassed: 1,
      notYetRun: 6,
      incomplete: false,
    });
    expect(c.passRate).toBeCloseTo(1 / 3, 6);
  });

  it('prints INCOMPLETE - no pass rate when INFRA exceeds 20% of runs', () => {
    const records = [
      run(units[0], 1, 'AGENT', true),
      ...units
        .slice(1, 4)
        .map((u) => run(u, 1, 'INFRA', false, 'quota:per-day')),
    ];
    const c = laneCoverage(latest(records), units, 1);
    expect(c.incomplete).toBe(true);
    expect(c.passRate).toBeUndefined();
    const md = renderLaneReport(
      {
        header: {
          type: 'header',
          lane,
          commit: 'a'.repeat(40),
          suiteHash: 'b'.repeat(64),
          createdAt: 'x',
        },
        subset: { name: 'core-30', sha256: 'c'.repeat(64) },
        k: 1,
        pricingVersion: 'routing-free-2026-10-23',
        limitsSources: ['https://example.invalid/limits (read 2026-10-26)'],
        generatedAt: 'now',
      },
      latest(records),
      units,
    );
    expect(md).toContain('**MEASUREMENT ONLY — not a gate.**');
    expect(md).toContain('**INCOMPLETE - no pass rate**');
    expect(md).toContain('INFRA reasons: quota:per-day x3');
    expect(md).toContain(
      'fast `openai/gpt-oss-20b`, strong `openai/gpt-oss-120b`',
    );
  });
});
