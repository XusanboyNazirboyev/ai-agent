import { describe, expect, it } from 'vitest';
import {
  agentDiagnosticsEnabled,
  validateEnvironment,
} from '../config/environment.js';
import {
  classifyToken,
  containsNumber,
  diagnoseBlockedDraft,
} from '../core/agent/diagnostics.js';
import type { Fact } from '../core/agent/facts.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { extraction, runTurn } from './testing/agent-harness.js';

const provenance = {
  tool: 'list_offers',
  connectorKey: 'mock',
  sourceSystem: 'mock-education',
  sourceEntityId: 'ielts-group-weekday',
  retrievedAt: '2026-10-23T10:00:00Z',
};
const FACTS: Fact[] = [
  {
    id: 'F2',
    value: {
      kind: 'price',
      money: { amount: '150.00', currency: 'USD' },
      confirmedQuote: false,
    },
    provenance,
  },
  { id: 'F4', value: { kind: 'seats', count: 12 }, provenance },
];

describe('blocked-draft diagnostics (ADR 029)', () => {
  it('classifies flagged tokens by shape and context', () => {
    const draft =
      '1. Kechki guruh 18:00 dan, 02.11.2026 boshlanadi, narxi 150 USD, 12 joy, 2026 yil, 77 ta. Tel +998901234567';
    expect(classifyToken('1', draft, FACTS)).toBe('list_marker');
    expect(classifyToken('18:00', draft, FACTS)).toBe('time');
    expect(classifyToken('02.11.2026', draft, FACTS)).toBe('date');
    expect(classifyToken('2026', draft, FACTS)).toBe('date');
    expect(classifyToken('150', draft, FACTS)).toBe('price');
    expect(classifyToken('12', draft, FACTS)).toBe('seats_or_quantity');
    expect(classifyToken('77', draft, FACTS)).toBe('other');
    expect(classifyToken('998901234567', draft, FACTS)).toBe('phone_like');
  });

  it('matches whole numbers only', () => {
    expect(containsNumber('price 150.00 USD', '150')).toBe(false);
    expect(containsNumber('"seatsLeft":12,', '12')).toBe(true);
    expect(containsNumber('Mon/Wed 18:00-20:00', '18:00')).toBe(true);
    expect(containsNumber('1500', '150')).toBe(false);
  });

  it('records where each number could come from, redacts the draft and never stores phone digits', () => {
    const diagnostic = diagnoseBlockedDraft({
      stage: 'first',
      draft: 'Mon/Wed 18:00 guruh, 12 joy. Qo‘ng‘iroq: +998 90 123 45 67',
      violations: ['UNSOURCED_NUMBER'],
      unsourcedNumbers: [
        '18:00',
        '12',
        '998',
        '90',
        '123',
        '45',
        '67',
        '998901234567',
      ],
      facts: FACTS,
      render: (fact) => (fact.value.kind === 'seats' ? '12' : '150 US$'),
      toolTexts: ['{"schedule":"Mon/Wed 18:00-20:00","seatsLeft":12}'],
      customerTexts: ['IELTS kechqurun'],
    });
    expect(diagnostic.draftRedacted).not.toMatch(/90 123 45 67/u);
    expect(diagnostic.draftRedacted).toContain('[phone]');
    const byToken = new Map(diagnostic.tokens.map((t) => [t.token, t]));
    expect(byToken.get('18:00')).toMatchObject({
      class: 'time',
      matchedFactId: null,
      inToolResult: true,
      inCustomerText: false,
    });
    expect(byToken.get('12')).toMatchObject({
      class: 'seats_or_quantity',
      matchedFactId: 'F4',
      matchedFactKind: 'seats',
      inToolResult: true,
    });
    const phone = diagnostic.tokens.find((t) => t.class === 'phone_like');
    expect(phone?.token).toBeNull();
    expect(JSON.stringify(diagnostic)).not.toContain('998901234567');
  });

  it('is on only in development by default and refused in production', () => {
    expect(agentDiagnosticsEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(agentDiagnosticsEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(agentDiagnosticsEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(
      agentDiagnosticsEnabled({ NODE_ENV: 'test', AGENT_DIAGNOSTICS: 'on' }),
    ).toBe(true);
    expect(
      agentDiagnosticsEnabled({
        NODE_ENV: 'development',
        AGENT_DIAGNOSTICS: 'off',
      }),
    ).toBe(false);
    expect(
      agentDiagnosticsEnabled({
        NODE_ENV: 'production',
        AGENT_DIAGNOSTICS: 'on',
      }),
    ).toBe(false);
    expect(() =>
      validateEnvironment({
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: '5432',
        POSTGRES_DATABASE: 'agentcore',
        POSTGRES_USER: 'agentcore',
        POSTGRES_PASSWORD: 'test-only',
        NODE_ENV: 'production',
        AGENT_DIAGNOSTICS: 'on',
      }),
    ).toThrow(/AGENT_DIAGNOSTICS is refused in production/u);
  });
});

describe('diagnostics never change the reply', () => {
  const blocked = (): ScriptedLlmProvider =>
    new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
      { kind: 'tools', text: 'Narxi 99 USD, 18:00 da!' },
      { kind: 'tools', text: '{{F1}} 120 dollar.' },
    ]);
  const passedAfterRetry = (): ScriptedLlmProvider =>
    new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
      { kind: 'tools', text: '{{F1}} kursi 120 dollar turadi.' },
      {
        kind: 'tools',
        text: '{{F1}} kursi bor. Narxini operator tasdiqlaydi.',
      },
    ]);

  it.each([
    ['blocked twice (GUARDRAIL handover)', blocked],
    ['blocked once, accepted after regeneration', passedAfterRetry],
  ])(
    '%s: identical reply, outcome and handover with diagnostics on and off',
    async (_name, provider) => {
      const off = await runTurn({ provider: provider(), text: 'IELTS narxi?' });
      const on = await runTurn({
        provider: provider(),
        text: 'IELTS narxi?',
        diagnostics: true,
      });
      for (const key of [
        'reply',
        'outcome',
        'handover',
        'violations',
        'regenerated',
        'shownFactIds',
        'safety',
      ] as const)
        expect(on.result[key]).toEqual(off.result[key]);
      expect(off.result.diagnostics).toBeUndefined();
      expect(on.result.diagnostics?.blockedDrafts.length).toBeGreaterThan(0);
    },
  );

  it('records both stages when the regeneration is blocked too', async () => {
    const { result } = await runTurn({
      provider: blocked(),
      text: 'IELTS narxi?',
      diagnostics: true,
    });
    const stages = result.diagnostics?.blockedDrafts.map((d) => d.stage);
    expect(stages).toEqual(['first', 'regeneration']);
    const first = result.diagnostics!.blockedDrafts[0]!;
    expect(first.violations).toContain('UNSOURCED_NUMBER');
    expect(first.tokens.map((t) => [t.token, t.class])).toEqual(
      expect.arrayContaining([
        ['99', 'price'],
        ['18:00', 'time'],
      ]),
    );
  });
});
