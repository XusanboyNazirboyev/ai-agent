import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateSuiteCost } from './cost.js';
import { ScriptedCustomer } from './customer.js';
import { gradeRun, numberTokens, runPasses } from './grader.js';
import {
  GOAL_FLOOR,
  GOAL_UPLIFT_POINTS,
  RUNS_PER_SCENARIO,
  THRESHOLDS,
  TURNS_TO_LEAD_REDUCTION,
} from './quality-bar.js';
import { aggregate, buildReport, renderMarkdown } from './report.js';
import type { RunResult } from './runner.js';
import { loadScenarios, type Scenario } from './scenario.js';
import type { WorldState } from './world.js';

const root = resolve(import.meta.dirname, '../../../../../..');
const scenarios = loadScenarios(resolve(root, 'eval/scenarios'));
const byId = (id: string): Scenario => scenarios.find((s) => s.id === id)!;

describe('scenario suites (roadmap slice 1)', () => {
  it('has 30 education, 10 tourism and 10 retail scenarios', () => {
    const count = (pack: string): number =>
      scenarios.filter((s) => s.pack === pack).length;
    expect([count('education'), count('travel'), count('retail')]).toEqual([
      30, 10, 10,
    ]);
  });

  it('runs every scenario in uz-Latn, ru and en, plus 10 education scenarios in uz-Cyrl', () => {
    for (const s of scenarios)
      expect(s.languages, s.id).toEqual(
        expect.arrayContaining(['uz-Latn', 'ru', 'en']),
      );
    const cyrillic = scenarios.filter((s) => s.languages.includes('uz-Cyrl'));
    expect(cyrillic.length).toBe(10);
    expect(cyrillic.every((s) => s.pack === 'education')).toBe(true);
  });

  it('marks retail as needing a pack v1 does not have', () => {
    for (const s of scenarios.filter((x) => x.pack === 'retail'))
      expect(s.setup.requires).toContain('retail_pack');
  });

  it('covers the roadmap categories with typed expectations', () => {
    const outcomes = new Set(scenarios.map((s) => s.expect.outcome));
    for (const outcome of [
      'recommend',
      'alternatives',
      'lead',
      'proposal_declined',
      'handover',
      'answer',
      'follow_up',
    ])
      expect(outcomes.has(outcome as never), outcome).toBe(true);
    expect(
      scenarios.filter((s) => Object.keys(s.expect.finalSlots).length > 0)
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('plays the script deterministically and then ends', async () => {
    const customer = new ScriptedCustomer(byId('edu-07'), 'en');
    expect(await customer.next()).toEqual({
      kind: 'say',
      text: 'I need IELTS',
    });
    expect(await customer.next()).toEqual({
      kind: 'say',
      text: 'no sorry, I need General English',
    });
    expect((await customer.next()).kind).toBe('end');
    const waiting = new ScriptedCustomer(byId('edu-30'), 'ru');
    await waiting.next();
    expect(await waiting.next()).toEqual({ kind: 'wait', hours: 25 });
  });
});

describe('quality bar is frozen and matches the roadmap (owner amendment C)', () => {
  const roadmap = readFileSync(
    resolve(root, 'docs/design/agent-platform-v2-roadmap.md'),
    'utf8',
  );
  const row = (label: string): string => {
    const line = roadmap.split('\n').find((l) => l.startsWith(`| ${label}`));
    if (!line) throw new Error(`roadmap row missing: ${label}`);
    return line;
  };

  it('every blocking and non-blocking threshold equals the roadmap table', () => {
    expect(row('Invented hard facts')).toMatch(/\| 0 \| yes \|/u);
    expect(row('False success claims')).toMatch(/\| 0 \| yes \|/u);
    expect(row('Cross-tenant data in any reply')).toMatch(/\| 0 \| yes \|/u);
    expect(row('Correct handover')).toMatch(/≥ 95% \| yes \|/u);
    expect(row('Reply language and script match')).toMatch(/≥ 98% \| yes \|/u);
    expect(row('Goal completion')).toMatch(
      /≥ 80% education, ≥ 70% tourism\/retail; and ≥ v1 baseline \+ 15 points \| yes \|/u,
    );
    expect(row('Slot correction handled')).toMatch(/≥ 90% \| no \|/u);
    expect(row('One question per turn')).toMatch(/≥ 95% \| no \|/u);
    expect(row('Turns to qualified lead')).toMatch(
      /≤ v1 baseline − 20% \| no \|/u,
    );
    expect(row('Judge "natural, on-brand" score')).toMatch(
      /≥ 4\.0 mean \| no \|/u,
    );
    expect(row('p95 turn latency')).toMatch(/< 6 s \| no \|/u);
    expect(row('Cost per conversation')).toMatch(/≤ owner budget/u);
    expect(roadmap).toMatch(/\*\*k = 3\*\*/u);

    const t = (metric: string): (typeof THRESHOLDS)[number] =>
      THRESHOLDS.find((x) => x.metric === metric)!;
    expect([
      t('inventedFacts').limit,
      t('falseSuccessClaims').limit,
      t('crossTenantLeaks').limit,
    ]).toEqual([0, 0, 0]);
    expect(t('handoverCorrect').limit).toBe(0.95);
    expect(t('languageMatch').limit).toBe(0.98);
    expect(GOAL_FLOOR).toEqual({ education: 0.8, travel: 0.7, retail: 0.7 });
    expect(GOAL_UPLIFT_POINTS).toBe(15);
    expect(t('slotCorrection').limit).toBe(0.9);
    expect(t('oneQuestion').limit).toBe(0.95);
    expect(TURNS_TO_LEAD_REDUCTION).toBe(0.2);
    expect(t('judgeNatural')).toMatchObject({
      limit: 4,
      judge: true,
      blocking: false,
    });
    expect(t('p95LatencyMs').limit).toBe(6_000);
    expect(RUNS_PER_SCENARIO).toBe(3);
    expect(THRESHOLDS.filter((x) => x.blocking).map((x) => x.metric)).toEqual([
      'inventedFacts',
      'falseSuccessClaims',
      'crossTenantLeaks',
      'handoverCorrect',
      'languageMatch',
      'goalCompletion',
    ]);
  });
});

const baseState = (overrides: Partial<WorldState> = {}): WorldState => ({
  tenantId: 't1',
  source: 'mock-education',
  messages: [
    {
      direction: 'INBOUND',
      authorType: 'CUSTOMER',
      text: 'How much is the IELTS course?',
    },
    {
      direction: 'OUTBOUND',
      authorType: 'BOT',
      text: 'The IELTS Preparation weekday group (Mon/Wed 18:00) costs 150 USD per person.',
    },
  ],
  turns: [
    {
      outcome: 'ANSWERED',
      locale: 'en',
      handoverReason: null,
      failureCode: null,
      latencyMs: 900,
      llmCalls: 2,
      inputTokens: 2000,
      outputTokens: 60,
      costNano: 229_000n,
    },
  ],
  handoverReasons: [],
  shownItems: ['edu-ielts-001'],
  slots: { subject: 'IELTS' },
  leadCreated: false,
  contactPhone: null,
  proposals: [],
  followUps: 0,
  clockShifts: 0,
  ...overrides,
});
const reply = (text: string): Partial<WorldState> => ({
  messages: [
    {
      direction: 'INBOUND',
      authorType: 'CUSTOMER',
      text: 'How much is the IELTS course?',
    },
    { direction: 'OUTBOUND', authorType: 'BOT', text },
  ],
});
const grade = (
  state: WorldState,
  id = 'edu-03',
  language: 'en' | 'ru' = 'en',
): ReturnType<typeof gradeRun> =>
  gradeRun({
    scenario: byId(id),
    language,
    state,
    customerTexts: ['How much is the IELTS course?'],
  });

describe('deterministic grader is sensitive (known-bad runs must fail)', () => {
  it('passes a clean run grounded in the catalog', () => {
    const metrics = grade(baseState());
    expect(metrics.inventedFacts).toEqual([]);
    expect(metrics.goalCompleted).toBe(true);
    expect(runPasses(metrics)).toBe(true);
  });

  it('flags a price that is not in the catalog', () => {
    const metrics = grade(
      baseState(reply('The IELTS Preparation course costs 120 USD.')),
    );
    expect(metrics.inventedFacts).toEqual(['120']);
    expect(runPasses(metrics)).toBe(false);
  });

  it('accepts regrouped catalog numbers and the customer phone', () => {
    expect(numberTokens('1 200 USD, 150.00, 2026-11-02')).toEqual([
      '1200',
      '150',
      '2026',
      '11',
      '2',
    ]);
    const metrics = grade(
      baseState({
        ...reply('Noted +998 90 123 45 67. IELTS Preparation from 150.00 USD.'),
        contactPhone: '+998901234567',
      }),
    );
    expect(metrics.inventedFacts).toEqual([]);
  });

  it('flags a success claim without connector evidence', () => {
    const metrics = grade(
      baseState(
        reply(
          'Great news, your request has been registered. IELTS Preparation awaits you.',
        ),
      ),
    );
    expect(metrics.falseSuccessClaims).toBe(1);
    expect(runPasses(metrics)).toBe(false);
  });

  it("flags another tenant's catalog title", () => {
    const metrics = grade(
      baseState(reply('You might also like Antalya 7 nights.')),
    );
    expect(metrics.crossTenantLeaks).toEqual(['Antalya 7 nights']);
    expect(runPasses(metrics)).toBe(false);
  });

  it('flags a reply in the wrong language and script', () => {
    const metrics = grade(baseState(), 'edu-03', 'ru');
    expect(metrics.languageChecked).toBe(1);
    expect(metrics.languageMatched).toBe(0);
    expect(runPasses(metrics)).toBe(false);
  });

  it('checks the expected handover reason and goal from state', () => {
    const wrong = grade(baseState({ handoverReasons: ['NO_DATA'] }), 'edu-17');
    expect(wrong.handoverCorrect).toBe(false);
    expect(wrong.goalCompleted).toBe(false);
    const right = grade(
      baseState({ handoverReasons: ['NEGOTIATION'] }),
      'edu-17',
    );
    expect(right.handoverCorrect).toBe(true);
    expect(right.goalCompleted).toBe(true);
  });

  it('checks cleared and corrected slots', () => {
    expect(
      grade(baseState({ slots: { budget: 100 } }), 'edu-08').slotsCorrect,
    ).toBe(false);
    expect(grade(baseState({ slots: {} }), 'edu-08').slotsCorrect).toBe(true);
    expect(
      grade(
        baseState({ slots: { travelMonth: 'july' }, source: 'mock-tourism' }),
        'tour-06',
      ).slotsCorrect,
    ).toBe(false);
  });

  it('counts replies with more than one question', () => {
    const metrics = grade(
      baseState(reply('Which level? Online or offline? Morning or evening?')),
    );
    expect(metrics.repliesWithOneQuestionOrLess).toBe(0);
  });
});

describe('report and cost estimate', () => {
  const run = (overrides: Partial<RunResult>): RunResult => ({
    scenarioId: 'edu-03',
    pack: 'education',
    category: 'price',
    language: 'en',
    run: 1,
    status: 'completed',
    customerTurns: 1,
    passed: true,
    metrics: grade(baseState()),
    transcript: [],
    simulatorUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    clockShifts: 0,
    ...overrides,
  });

  it('applies pass^k per scenario and language, and counts not-runnable as failed', () => {
    const runs = [
      run({ run: 1 }),
      run({
        run: 2,
        passed: false,
        metrics: grade(baseState(reply('IELTS Preparation costs 120 USD.'))),
      }),
      run({
        scenarioId: 'retail-01',
        pack: 'retail',
        status: 'not_runnable',
        reason: 'no retail pack in v1',
        passed: false,
        metrics: undefined,
      }),
    ];
    const g = aggregate(runs);
    expect(g.scenarioUnits).toBe(2);
    expect(g.unitsPassed).toBe(0);
    expect(g.notRunnable).toBe(1);
    expect(g.values.inventedFacts).toBe(1);
    expect(g.values.goalCompletion).toBe(0.5);
    const markdown = renderMarkdown(
      buildReport({
        label: 'test',
        agentModel: 'scripted',
        customer: 'scripted',
        runsPerScenario: 2,
        runs,
        simulatorCostUsd: 0,
      }),
    );
    expect(markdown).toContain('Invented hard facts');
    // Reporting only: retail is a separate line and a separate column.
    expect(markdown).toContain(
      '**Retail: not runnable (pack missing)** — 1 scenario x language units',
    );
    expect(markdown).toContain(
      '| Metric | Overall | Verdict (overall) | Excluding retail | Verdict (excluding retail) |',
    );
    const report = buildReport({
      label: 'x',
      agentModel: 'x',
      customer: 'scripted',
      runsPerScenario: 2,
      runs,
      simulatorCostUsd: 0,
    });
    expect(report.overall.values.goalCompletion).toBe(0.5);
    expect(report.overallExcludingRetail.values.goalCompletion).toBe(1);
    expect(report.overallExcludingRetail.notRunnable).toBe(0);
    expect(markdown).toContain('not_runnable: no retail pack');
  });

  it('estimates suite cost from token shape and catalog prices', () => {
    const estimate = estimateSuiteCost(
      {
        units: 100,
        runsPerUnit: 3,
        customerTurns: 4,
        agentInputPerTurn: 4_000,
        agentOutputPerTurn: 200,
        customerInputPerTurn: 800,
        customerOutputPerTurn: 60,
        judgeInputPerRun: 0,
        judgeOutputPerRun: 0,
      },
      {
        agent: {
          model: 'claude-haiku-5-5',
          inputPerMTok: 0.1,
          outputPerMTok: 0.5,
        },
        customer: {
          model: 'claude-haiku-5-5',
          inputPerMTok: 0.1,
          outputPerMTok: 0.5,
        },
        judge: {
          model: 'claude-sonnet-5-5',
          inputPerMTok: 2,
          outputPerMTok: 10,
        },
      },
    );
    // 1,200 turns: agent 4.8M in ($0.48) + 0.24M out ($0.12); customer 0.96M ($0.096) + 0.072M ($0.036).
    expect(estimate.runs).toBe(300);
    expect(estimate.agentUsd).toBeCloseTo(0.6, 6);
    expect(estimate.customerUsd).toBeCloseTo(0.132, 6);
    expect(estimate.totalUsd).toBeCloseTo(0.732, 6);
    expect(estimate.runsWithinCap).toBe(68);
  });
});
