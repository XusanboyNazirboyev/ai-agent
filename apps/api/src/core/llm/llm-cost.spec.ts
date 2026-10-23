import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BudgetExhaustedError,
  TurnBudget,
  type BudgetLimits,
} from './budget.js';
import { LlmError, type LlmUsage } from './llm-provider.js';
import {
  estimateRequest,
  MeteredLlm,
  type LlmUsageEntry,
} from './metered-llm.js';
import {
  costOfUsage,
  nanoToUsd,
  parsePricingConfig,
  perMTokToNanoPerToken,
  pricingAgeDays,
  PricingCatalog,
  pricingFor,
  usdToNano,
  worstCaseCost,
} from './pricing.js';
import { MOCK_MODEL, ScriptedLlmProvider } from './scripted-llm-provider.js';

const usage = (input: number, output: number, cacheRead = 0): LlmUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});

/** Generic two-tier test card (not a real provider price list). */
const TEST_PRICING = parsePricingConfig({
  version: 'test-2026-01-01',
  provider: 'test',
  asOf: '2026-01-01',
  sourceUrl: 'https://example.invalid/pricing',
  models: {
    tiered: {
      inputPerMTok: '0.10',
      cacheWrite5mPerMTok: '0.125',
      cacheWrite1hPerMTok: '0.20',
      cacheReadPerMTok: '0.01',
      outputPerMTok: '0.50',
      toolUseSystemPromptTokens: 286,
      longPrompt: {
        thresholdTokens: 100_000,
        inputPerMTok: '0.50',
        cacheWrite5mPerMTok: '0.625',
        cacheWrite1hPerMTok: '1',
        cacheReadPerMTok: '0.05',
        outputPerMTok: '2.50',
      },
    },
    flat: {
      inputPerMTok: '2',
      cacheWrite5mPerMTok: '2.50',
      cacheWrite1hPerMTok: '4',
      cacheReadPerMTok: '0.10',
      outputPerMTok: '10',
    },
    [MOCK_MODEL]: {
      inputPerMTok: '0.10',
      cacheWrite5mPerMTok: '0.125',
      cacheWrite1hPerMTok: '0.20',
      cacheReadPerMTok: '0.01',
      outputPerMTok: '0.50',
      longPrompt: {
        thresholdTokens: 2_000,
        inputPerMTok: '0.50',
        cacheWrite5mPerMTok: '0.625',
        cacheWrite1hPerMTok: '1',
        cacheReadPerMTok: '0.05',
        outputPerMTok: '2.50',
      },
    },
  },
});

describe('pricing config and cost math', () => {
  const tiered = pricingFor(TEST_PRICING, 'tiered');

  it('converts decimal USD/MTok strings to integer nano-USD per token exactly', () => {
    expect(perMTokToNanoPerToken('0.10')).toBe(100);
    expect(perMTokToNanoPerToken('0.125')).toBe(125);
    expect(perMTokToNanoPerToken('0.625')).toBe(625);
    expect(perMTokToNanoPerToken('2.50')).toBe(2_500);
    expect(perMTokToNanoPerToken('0.0100')).toBe(10);
    expect(perMTokToNanoPerToken('15')).toBe(15_000);
    // Not representable as whole nano-USD per token: rejected, never rounded.
    expect(() => perMTokToNanoPerToken('0.0125')).toThrow(/whole number/);
    expect(() => perMTokToNanoPerToken('1e-3')).toThrow(/Invalid price/);
    expect(() => parsePricingConfig({ version: 'x', models: {} })).toThrow();
  });

  it('prices standard-tier usage exactly in nano-USD', () => {
    // 10,000 input at $0.10/MTok + 1,000 output at $0.50/MTok = $0.0015
    expect(costOfUsage(tiered, usage(10_000, 1_000))).toBe(usdToNano('0.0015'));
    // cache reads at $0.01/MTok; 100K tokens stays on the standard tier
    expect(costOfUsage(tiered, usage(0, 0, 100_000))).toBe(usdToNano('0.001'));
  });

  it('applies the long-prompt tier above the threshold, counting cache reads', () => {
    expect(costOfUsage(tiered, usage(100_000, 0))).toBe(usdToNano('0.01'));
    expect(costOfUsage(tiered, usage(100_001, 0))).toBe(usdToNano('0.0500005'));
    // 1M cached tokens is a long prompt: $0.05/MTok cache-read rate
    expect(costOfUsage(tiered, usage(0, 0, 1_000_000))).toBe(usdToNano('0.05'));
    expect(costOfUsage(tiered, usage(50_000, 2_000, 60_000))).toBe(
      50_000 * 500 + 2_000 * 2_500 + 60_000 * 50,
    );
  });

  it('reserves the worst case at the tier the prompt falls in', () => {
    // Standard tier: max(input, 5m write, 1h write) = 200 nUSD + output 500.
    expect(worstCaseCost(tiered, 1_000, 1_024)).toBe(1_000 * 200 + 1_024 * 500);
    expect(worstCaseCost(tiered, 100_001, 10)).toBe(
      100_001 * 1_000 + 10 * 2_500,
    );
    expect(worstCaseCost(pricingFor(TEST_PRICING, 'flat'), 10, 10)).toBe(
      10 * 4_000 + 10 * 10_000,
    );
  });

  it('refuses unpriced models, unknown and duplicate versions', () => {
    expect(() => pricingFor(TEST_PRICING, 'other-model')).toThrow(/No pricing/);
    const catalog = new PricingCatalog([]);
    expect(catalog.has('test-2026-01-01')).toBe(false);
    expect(() => catalog.snapshot('test-2026-01-01')).toThrow(
      /Unknown pricing/,
    );
    const raw = {
      version: 'dup-1',
      provider: 'test',
      asOf: '2026-01-01',
      sourceUrl: 'https://example.invalid/p',
      models: {},
    };
    expect(() => new PricingCatalog([raw, raw])).toThrow(/Duplicate/);
  });

  it('reports pricing age in whole days', () => {
    expect(pricingAgeDays(TEST_PRICING, new Date('2026-01-31T23:59:00Z'))).toBe(
      30,
    );
    expect(pricingAgeDays(TEST_PRICING, new Date('2026-02-01T00:00:00Z'))).toBe(
      31,
    );
  });

  it('converts USD strings exactly', () => {
    expect(usdToNano('0.02')).toBe(20_000_000);
    expect(usdToNano('12.000000001')).toBe(12_000_000_001);
    expect(nanoToUsd(20_000_000)).toBe('0.02');
    expect(() => usdToNano('-1')).toThrow();
    expect(() => usdToNano('1e3')).toThrow();
  });
});

const LIMITS: BudgetLimits = {
  maxTurnCostNano: 1_000,
  maxConversationCostNano: 5_000,
  maxCallsPerTurn: 3,
  maxToolRoundsPerTurn: 1,
  maxToolCallsPerTurn: 2,
  maxOutputTokensPerCall: 100,
  maxInputBytesPerCall: 1_000,
};

describe('TurnBudget', () => {
  const budget = (prior = 0, limits: Partial<BudgetLimits> = {}): TurnBudget =>
    new TurnBudget(
      { ...LIMITS, ...limits },
      { conversationSpentNano: prior, tenantMonthSpentNano: prior },
    );

  it('reserves worst case, then settles the actual cost', () => {
    const turn = budget();
    const reservation = turn.reserve(600, 10);
    expect(() => turn.reserve(500, 10)).toThrow(BudgetExhaustedError);
    turn.settle(reservation, 100);
    expect(turn.snapshot).toMatchObject({
      spentNano: 100,
      reservedNano: 0,
      remainingTurnNano: 900,
    });
    expect(() => turn.reserve(500, 10)).not.toThrow();
  });

  it('enforces conversation, tenant-monthly, call, input and tool limits', () => {
    expect(() => budget(4_800).reserve(300, 10)).toThrow(
      expect.objectContaining({ reason: 'CONVERSATION_COST_LIMIT' }),
    );
    expect(() =>
      budget(100, { tenantMonthlyBudgetNano: 200 }).reserve(150, 10),
    ).toThrow(expect.objectContaining({ reason: 'TENANT_MONTHLY_LIMIT' }));
    expect(() => budget().reserve(1, 1_001)).toThrow(
      expect.objectContaining({ reason: 'INPUT_TOO_LARGE' }),
    );
    const calls = budget();
    for (let i = 0; i < 3; i++) calls.release(calls.reserve(1, 1));
    expect(() => calls.reserve(1, 1)).toThrow(
      expect.objectContaining({ reason: 'CALL_LIMIT' }),
    );
    const rounds = budget();
    rounds.beginToolRound();
    expect(() => rounds.beginToolRound()).toThrow(
      expect.objectContaining({ reason: 'TOOL_ROUND_LIMIT' }),
    );
    rounds.countToolCall();
    rounds.countToolCall();
    expect(() => rounds.countToolCall()).toThrow(
      expect.objectContaining({ reason: 'TOOL_CALL_LIMIT' }),
    );
    expect(rounds.snapshot.stopReason).toBe('TOOL_ROUND_LIMIT');
  });

  it('records an input underestimate as overshoot', () => {
    const turn = budget();
    turn.settle(turn.reserve(100, 1), 150);
    expect(turn.snapshot.overshootNano).toBe(50);
  });
});

describe('MeteredLlm', () => {
  const request = {
    tier: 'FAST' as const,
    purpose: 'extract' as const,
    system: 'system',
    messages: [{ role: 'user' as const, text: 'hello' }],
    schemaName: 'x',
    jsonSchema: { type: 'object' },
    schema: z.object({ ok: z.boolean() }),
    maxOutputTokens: 5_000,
  };

  function metered(
    provider: ScriptedLlmProvider,
    limits: Partial<BudgetLimits> = {},
  ): { llm: MeteredLlm; entries: LlmUsageEntry[]; budget: TurnBudget } {
    const entries: LlmUsageEntry[] = [];
    const budget = new TurnBudget(
      {
        ...LIMITS,
        maxTurnCostNano: 10_000_000,
        maxConversationCostNano: 10_000_000,
        ...limits,
      },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = new MeteredLlm(
      provider,
      TEST_PRICING,
      budget,
      {
        record: async (entry): Promise<void> => void entries.push(entry),
      },
      { tenantId: 't1', conversationId: 'c1', turnKey: 'turn' },
    );
    return { llm, entries, budget };
  }

  it('clamps output, settles actual usage and records it', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'structured', value: { ok: true } },
    ]);
    const { llm, entries, budget } = metered(provider);
    const result = await llm.structured(request);
    expect(result.value).toEqual({ ok: true });
    const sent = provider.calls[0];
    expect(sent.request.maxOutputTokens).toBe(100);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenantId: 't1',
      purpose: 'extract',
      model: 'mock-deterministic',
    });
    expect(budget.snapshot.spentNano).toBe(entries[0].costNano);
  });

  it('releases the reservation when the provider fails without a response', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'error', error: new LlmError('LLM_RATE_LIMITED', 'busy', true) },
    ]);
    const { llm, entries, budget } = metered(provider);
    await expect(llm.structured(request)).rejects.toBeInstanceOf(LlmError);
    expect(entries).toHaveLength(0);
    expect(budget.snapshot).toMatchObject({
      spentNano: 0,
      reservedNano: 0,
      calls: 1,
    });
  });

  it('never calls the provider when the reservation does not fit', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'structured', value: { ok: true } },
    ]);
    const { llm } = metered(provider, { maxTurnCostNano: 10 });
    await expect(llm.structured(request)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('keeps counting cost when usage persistence fails', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'structured', value: { ok: true } },
    ]);
    const onError = vi.fn();
    const budget = new TurnBudget(
      {
        ...LIMITS,
        maxTurnCostNano: 10_000_000,
        maxConversationCostNano: 10_000_000,
      },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = new MeteredLlm(
      provider,
      TEST_PRICING,
      budget,
      {
        record: async (): Promise<void> => {
          throw new Error('db down');
        },
      },
      { tenantId: 't1', turnKey: 'turn' },
      onError,
    );
    await llm.structured(request);
    expect(onError).toHaveBeenCalledOnce();
    expect(budget.snapshot.spentNano).toBeGreaterThan(0);
  });

  it('refuses a prompt over the long-prompt threshold before calling', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'structured', value: { ok: true } },
    ]);
    // The test mock card switches tier at 2,000 prompt tokens.
    const { llm } = metered(provider, { maxInputBytesPerCall: 1_000_000 });
    await expect(
      llm.structured({
        ...request,
        messages: [{ role: 'user', text: 'x'.repeat(2_100) }],
      }),
    ).rejects.toMatchObject({ reason: 'INPUT_TOO_LARGE' });
    expect(provider.calls).toHaveLength(0);
  });

  it('passes the turn deadline signal to the provider', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'structured', value: { ok: true } },
    ]);
    const controller = new AbortController();
    const budget = new TurnBudget(
      {
        ...LIMITS,
        maxTurnCostNano: 10_000_000,
        maxConversationCostNano: 10_000_000,
      },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = new MeteredLlm(
      provider,
      TEST_PRICING,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId: 't1', turnKey: 'turn', signal: controller.signal },
    );
    await llm.structured(request);
    expect(provider.calls[0].request.signal).toBe(controller.signal);
  });

  it('estimates request size from UTF-8 bytes (Cyrillic counts double)', () => {
    expect(estimateRequest({ system: 'abc', messages: [] }).bytes).toBe(3);
    expect(estimateRequest({ system: 'абв', messages: [] }).bytes).toBe(6);
  });
});
