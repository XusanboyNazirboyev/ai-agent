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
  DEFAULT_PRICING_VERSION,
  nanoToUsd,
  pricingFor,
  usdToNano,
  worstCaseCost,
} from './pricing.js';
import { ScriptedLlmProvider } from './scripted-llm-provider.js';

const usage = (input: number, output: number, cacheRead = 0): LlmUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});

describe('pricing snapshot', () => {
  const haiku = pricingFor(DEFAULT_PRICING_VERSION, 'claude-haiku-5-5');

  it('prices Claude Haiku 5.5 exactly in nano-USD', () => {
    // 10,000 input at $0.10/MTok + 1,000 output at $0.50/MTok = $0.0015
    expect(costOfUsage(haiku, usage(10_000, 1_000))).toBe(1_500_000);
    // cache reads at $0.01/MTok (100K tokens stays on the standard card)
    expect(costOfUsage(haiku, usage(0, 0, 100_000))).toBe(usdToNano('0.001'));
    // cache reads count toward prompt length: 1M cached tokens is long context
    expect(costOfUsage(haiku, usage(0, 0, 1_000_000))).toBe(usdToNano('0.05'));
  });

  it('applies the long-context card above 100K prompt tokens', () => {
    expect(costOfUsage(haiku, usage(100_000, 0))).toBe(usdToNano('0.01'));
    expect(costOfUsage(haiku, usage(100_001, 0))).toBe(100_001 * 500);
  });

  it('records the Sonnet/Opus 5.5 cache-read multiplier of 0.05x', () => {
    expect(
      pricingFor(DEFAULT_PRICING_VERSION, 'claude-sonnet-5-5').standard
        .cacheRead,
    ).toBe(100);
    expect(
      pricingFor(DEFAULT_PRICING_VERSION, 'claude-opus-5-5').standard.cacheRead,
    ).toBe(200);
  });

  it('bounds worst case by the most expensive input rate and full output', () => {
    expect(worstCaseCost(haiku, 1_000, 1_024)).toBe(1_000 * 125 + 1_024 * 500);
  });

  it('refuses unpriced models and unknown versions', () => {
    expect(() => pricingFor(DEFAULT_PRICING_VERSION, 'gpt-anything')).toThrow(
      /No pricing/,
    );
    expect(() => pricingFor('2020-01-01', 'claude-haiku-5-5')).toThrow(
      /Unknown pricing/,
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
      DEFAULT_PRICING_VERSION,
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
      DEFAULT_PRICING_VERSION,
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

  it('estimates request size from UTF-8 bytes (Cyrillic counts double)', () => {
    expect(estimateRequest({ system: 'abc', messages: [] }).bytes).toBe(3);
    expect(estimateRequest({ system: 'абв', messages: [] }).bytes).toBe(6);
  });
});
