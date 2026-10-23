import { describe, expect, it } from 'vitest';
import {
  interruptedTurnResult,
  type AgentTurnInput,
} from '../core/agent/agent-turn.js';
import { FactStore } from '../core/agent/facts.js';
import { detectLanguage } from '../core/agent/language.js';
import { redactedSummary, redactPii } from '../core/agent/redaction.js';
import { AgentTools, TOOL_SIDE_EFFECTS } from '../core/agent/tools.js';
import { TurnBudget } from '../core/llm/budget.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { MockConnector } from '../connectors/mock/mock-connector.js';
import type { MockItemFixture } from '../connectors/mock/mock-fixtures.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import {
  INITIAL_LOCALE_PACKS,
  UZ_CYRL,
  UZ_LATN,
} from '../locales/locale-packs.js';
import {
  handoverSummary,
  turnMetrics,
} from '../channels/telegram/telegram-agent-pipeline.js';
import type { ComputedTurn } from './agent-conversation.service.js';
import {
  agentModePolicy,
  assertAgentModeAllowed,
  effectiveAgentMode,
  liveModeRefusal,
  shadowModeRefusal,
  type AgentModePolicy,
} from './agent-mode.js';
import {
  extraction,
  LOCALES,
  runTurn,
  TEST_LIMITS,
} from './testing/agent-harness.js';
import { INJECTED_DESCRIPTION } from './testing/eval-runner.js';

const production: AgentModePolicy = {
  nodeEnv: 'production',
  operatorNotifierConfigured: false,
  providerTrusted: true,
  allowRealCustomerData: false,
};
const real = { isTestAccount: false };
const testBot = { isTestAccount: true };

describe('agent mode policy', () => {
  it('refuses LIVE without an operator notifier outside local development', () => {
    expect(liveModeRefusal(production)).toMatch(/Phase 5/);
    expect(() => assertAgentModeAllowed('LIVE', production, real)).toThrow(
      /operator handover notifier/,
    );
    expect(() =>
      assertAgentModeAllowed('LIVE', { ...production, nodeEnv: 'test' }, real),
    ).toThrow();
    expect(() =>
      assertAgentModeAllowed('SHADOW', production, real),
    ).not.toThrow();
    expect(() => assertAgentModeAllowed('OFF', production, real)).not.toThrow();
  });

  it('allows LIVE in local development or with a notifier', () => {
    expect(
      liveModeRefusal({ ...production, nodeEnv: 'development' }),
    ).toBeUndefined();
    expect(
      liveModeRefusal({ ...production, operatorNotifierConfigured: true }),
    ).toBeUndefined();
  });

  it('degrades a refused LIVE row to SHADOW at processing time', () => {
    expect(effectiveAgentMode('LIVE', production, real)).toMatchObject({
      mode: 'SHADOW',
      refusal: expect.any(String),
    });
    expect(effectiveAgentMode('SHADOW', production, real)).toEqual({
      mode: 'SHADOW',
    });
    expect(effectiveAgentMode('OFF', production, real)).toEqual({
      mode: 'OFF',
    });
  });
});

describe('data-protection guard (untrusted LLM provider)', () => {
  const untrusted: AgentModePolicy = {
    ...production,
    nodeEnv: 'development',
    providerTrusted: false,
  };

  it('never allows LIVE, even in local development or with the override', () => {
    expect(liveModeRefusal(untrusted)).toMatch(/untrusted/);
    expect(() =>
      assertAgentModeAllowed(
        'LIVE',
        { ...untrusted, allowRealCustomerData: true },
        testBot,
      ),
    ).toThrow(/untrusted/);
  });

  it('allows SHADOW on a real account only with the explicit override', () => {
    expect(shadowModeRefusal(untrusted, real)).toMatch(
      /LLM_ALLOW_REAL_CUSTOMER_DATA/,
    );
    expect(() => assertAgentModeAllowed('SHADOW', untrusted, real)).toThrow();
    expect(() =>
      assertAgentModeAllowed('SHADOW', untrusted, testBot),
    ).not.toThrow();
    expect(() =>
      assertAgentModeAllowed(
        'SHADOW',
        { ...untrusted, allowRealCustomerData: true },
        real,
      ),
    ).not.toThrow();
  });

  it('holds (no model call, no reply) instead of falling back to the echo', () => {
    expect(effectiveAgentMode('SHADOW', untrusted, real)).toMatchObject({
      mode: 'HOLD',
    });
    expect(effectiveAgentMode('LIVE', untrusted, real)).toMatchObject({
      mode: 'HOLD',
    });
    expect(effectiveAgentMode('LIVE', untrusted, testBot)).toMatchObject({
      mode: 'SHADOW',
    });
  });

  it('builds the policy from configuration (only mock trusted by default)', () => {
    const policy = agentModePolicy({
      NODE_ENV: 'production',
      LLM_PROVIDER: 'openai-compatible',
      LLM_TRUSTED_PROVIDERS: ['mock'],
      LLM_ALLOW_REAL_CUSTOMER_DATA: false,
    });
    expect(policy).toMatchObject({
      providerTrusted: false,
      allowRealCustomerData: false,
      operatorNotifierConfigured: false,
    });
  });
});

describe('PII redaction for records', () => {
  it('redacts phones, emails, card-like and document-like numbers', () => {
    expect(redactPii('call +998 90 123-45-67 please')).toBe(
      'call [phone] please',
    );
    expect(redactPii('mail me at ali@example.uz')).toBe('mail me at [email]');
    expect(redactPii('card 4111 1111 1111 1111')).toBe('card [number]');
    expect(redactPii('passport AB1234567')).toBe('passport [document]');
    expect(redactPii('key sk-ant-abcdefghijklmnop')).toBe('key [secret]');
    expect(redactPii('IELTS')).toBe('IELTS');
    expect(redactPii('x'.repeat(300)).length).toBeLessThanOrEqual(201);
  });

  it('keeps record ids but redacts free text in summaries', () => {
    expect(
      redactedSummary({
        offerId: 'mock:offer:1',
        query: 'IELTS +998901234567',
        limit: 3,
        nested: { a: 1 },
      }),
    ).toEqual({
      offerId: 'mock:offer:1',
      query: 'IELTS [phone]',
      limit: '3',
      nested: '[object]',
    });
  });
});

function tools(
  items: MockItemFixture[] | undefined,
  now = new Date('2026-10-23T10:00:00Z'),
): AgentTools {
  const connector = new MockConnector(
    { tenantId: 't', connectorKey: 'mock' },
    {
      sourceSystem: 'mock-education',
      items: items ?? [],
    },
  );
  return new AgentTools({
    connector,
    pack: EDUCATION_PACK,
    facts: new FactStore(),
    budget: new TurnBudget(TEST_LIMITS, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    }),
    timeoutMs: 200,
    now: () => now,
  });
}

const item = (
  sourceEntityId: string,
  title: string,
  extra: Partial<MockItemFixture> = {},
): MockItemFixture => ({
  sourceEntityId,
  itemType: 'course',
  title,
  attributes: {},
  offers: [
    {
      sourceEntityId: `${sourceEntityId}-o`,
      price: { amount: '10.00', currency: 'USD' },
      availabilityStatus: 'AVAILABLE',
      attributes: {},
    },
  ],
  ...extra,
});

describe('tool outcomes, side effects and untrusted data', () => {
  it('declares every tool READ-only', () => {
    expect(new Set(Object.values(TOOL_SIDE_EFFECTS))).toEqual(
      new Set(['READ']),
    );
  });

  it('reports typed outcomes with redacted input', async () => {
    const agentTools = tools([item('a', 'Alpha')]);
    const found = await agentTools.run('search_catalog', { query: 'Alpha' });
    expect(found).toMatchObject({ ok: true, outcome: 'FOUND' });
    const empty = await agentTools.run('search_catalog', {
      query: 'Zeta +998901234567',
    });
    expect(empty).toMatchObject({ ok: true, outcome: 'NOT_FOUND' });
    const rejected = await agentTools.run('get_quote', { offerId: 'nope' });
    expect(rejected).toMatchObject({ ok: false, outcome: 'REJECTED' });
    expect(agentTools.trace.map((t) => t.outcome)).toEqual([
      'FOUND',
      'NOT_FOUND',
      'REJECTED',
    ]);
    expect(agentTools.trace[1].input).toEqual({ query: 'Zeta [phone]' });
  });

  it('marks expired offers STALE and issues no price fact for them', async () => {
    const agentTools = tools([
      item('a', 'Alpha', {
        offers: [
          {
            sourceEntityId: 'a-o',
            price: { amount: '10.00', currency: 'USD' },
            validUntil: '2026-10-01T00:00:00Z',
            attributes: {},
          },
        ],
      }),
    ]);
    await agentTools.run('search_catalog', { query: 'Alpha' });
    const offers = await agentTools.run('list_offers', {
      itemId: 'mock-education:a',
    });
    expect(offers).toMatchObject({ ok: true, outcome: 'STALE' });
    expect(offers.summary).toContain('"stale":true');
    expect(offers.summary).not.toContain('10.00');
    const quote = await agentTools.run('get_quote', {
      offerId: 'mock-education:offer:a-o',
    });
    expect(quote).toMatchObject({ ok: false, code: 'STALE', outcome: 'STALE' });
  });

  it('escapes markup in CRM text so it cannot close prompt delimiters', async () => {
    const agentTools = tools([
      item('a', 'Alpha', { description: INJECTED_DESCRIPTION }),
    ]);
    const result = await agentTools.run('search_catalog', { query: 'Alpha' });
    expect(result.summary).not.toContain('</catalog_context>');
    expect(result.summary).not.toContain('<system>');
    // Still valid JSON carrying the same (inert) text.
    const parsed = JSON.parse(result.summary) as {
      items: Array<{ description: string }>;
    };
    expect(parsed.items[0].description).toBe(INJECTED_DESCRIPTION);
  });

  it('keeps items distinct when their titles transliterate to the same key', async () => {
    const agentTools = tools([item('cyr', 'Анталия'), item('lat', 'Antaliya')]);
    await agentTools.run('search_catalog', { query: 'Анталия' });
    await agentTools.run('search_catalog', { query: 'Antaliya' });
    const ids = agentTools.trace.map((t) => t.outcome);
    expect(ids).toEqual(['FOUND', 'FOUND']);
    const facts = (
      agentTools as unknown as { context: { facts: FactStore } }
    ).context.facts
      .list()
      .filter((fact) => fact.value.kind === 'title');
    expect(facts.map((fact) => fact.provenance.sourceEntityId)).toEqual([
      'cyr',
      'lat',
    ]);
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(2);
  });
});

describe('language and script on mixed input', () => {
  it('does not treat a Latin acronym or a mixed-script message as a script choice', () => {
    expect(detectLanguage('IELTS бошланғич гуруҳ керак')).toMatchObject({
      script: 'Cyrl',
    });
    expect(
      detectLanguage('IELTS boshlang‘ich гуруҳ керак').confidence,
    ).toBeLessThan(0.6);
  });
});

describe('agent turn: disclosure, empty drafts, interrupted turns', () => {
  it('answers a bot question truthfully in the conversation script', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({}, 'ai_question', 'uz', 'Cyrl'),
      ]),
      text: 'Сиз ботмисиз?',
      input: { conversationLocale: 'uz-Cyrl' },
    });
    expect(result).toMatchObject({ outcome: 'ANSWERED', locale: 'uz-Cyrl' });
    expect(result.reply).toBe(UZ_CYRL.templates.aiDisclosure);
  });

  it('falls back to code-rendered options when the draft is empty', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }),
        { kind: 'tools', text: '   ' },
      ]),
      text: 'IELTS',
    });
    expect(result.outcome).toBe('FALLBACK');
    expect(result.reply).toContain('• IELTS Preparation');
    expect(result.regenerated).toBe(false);
  });

  it('builds a LLM_UNAVAILABLE handover for a turn cut off by its deadline', () => {
    const input: AgentTurnInput = {
      turnKey: 't',
      customerText: 'IELTS kerak',
      history: [],
      slots: { subject: { value: 'IELTS', source: 'customer' } },
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      defaultLocale: 'uz-Latn',
      timeZone: 'Asia/Tashkent',
    };
    const budget = new TurnBudget(TEST_LIMITS, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    const result = interruptedTurnResult(
      input,
      LOCALES,
      budget.snapshot,
      'LLM_UNAVAILABLE',
      'TURN_TIMEOUT',
    );
    expect(result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'LLM_UNAVAILABLE',
      llmFailure: 'TURN_TIMEOUT',
      slots: input.slots,
    });
    expect(result.reply).toBe(UZ_LATN.templates.handover.LLM_UNAVAILABLE);
  });

  it('never lets a handover template promise a reply or acceptance', () => {
    const promises =
      /tez orada|тез орада|скоро|shortly|soon|accepted|принят|qabul qilindi/iu;
    for (const pack of INITIAL_LOCALE_PACKS)
      for (const text of Object.values(pack.templates.handover))
        expect(text).not.toMatch(promises);
  });
});

describe('turn record mapping', () => {
  it('stores counts, costs, redacted tools and a structured summary', async () => {
    const run = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'negotiation'),
      ]),
      text: 'IELTS chegirma +998901234567',
    });
    const computed: ComputedTurn = {
      result: run.result,
      slotsBefore: {},
      usage: run.usage,
      latencyMs: 12,
      providerId: 'mock',
      pricingVersion: 'anthropic-2026-10-23',
      promptVersion: 'p',
      packRef: 'education@1',
      timedOut: false,
    };
    const metrics = turnMetrics(computed);
    expect(metrics).toMatchObject({
      outcome: 'HANDOVER',
      handoverReason: 'NEGOTIATION',
      provider: 'mock',
      llmCalls: 1,
      latencyMs: 12,
      draftText: run.result.reply,
    });
    expect(metrics.actualCostNano).toBe(BigInt(run.usage[0].costNano));
    expect(metrics.estimatedCostNano).toBe(BigInt(run.usage[0].reservedNano));
    expect(
      JSON.stringify(metrics, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('998901234567');
    const summary = handoverSummary(computed);
    expect(summary.customerClaims).toEqual(['subject=IELTS']);
    expect(summary.unknowns).toContain('reason=NEGOTIATION');
  });
});
