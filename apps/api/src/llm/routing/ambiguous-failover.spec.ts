import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TurnBudget, type BudgetLimits } from '../../core/llm/budget.js';
import type { BudgetLedger } from '../../core/llm/budget-ledger.js';
import {
  LlmError,
  type LlmProvider,
  type ToolGenerationResult,
} from '../../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../../core/llm/metered-llm.js';
import { parsePricingConfig } from '../../core/llm/pricing.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import {
  RoutingLlmProvider,
  type RoutedCandidate,
} from './routing-provider.js';

const snapshot = parsePricingConfig({
  version: 'ambiguous-fixture-1',
  provider: 't',
  asOf: '2026-01-01',
  sourceUrl: 'https://example.invalid/p',
  models: {
    ...Object.fromEntries(['ma', 'mb'].map((m) => [m, { free: true }])),
    ...Object.fromEntries(
      ['pa', 'pb'].map((m) => [
        m,
        {
          inputPerMTok: '1.00',
          outputPerMTok: '2.00',
          cacheReadPerMTok: '0.10',
          cacheWrite5mPerMTok: '1.25',
          cacheWrite1hPerMTok: '2.00',
        },
      ]),
    ),
  },
});
const BREAKER = {
  breaker: {
    rateLimitCooldownMs: 60_000,
    providerCooldownMs: 900_000,
    transientCooldownMs: 30_000,
    transientFailures: 5,
  },
};
const request = {
  tier: 'FAST' as const,
  purpose: 'respond' as const,
  system: 's',
  messages: [{ role: 'user' as const, text: 'hi' }],
  tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  maxOutputTokens: 50,
};
const timeout: ScriptStep = {
  kind: 'error',
  error: new LlmError('LLM_TIMEOUT', 'x', false),
};
const rateLimited: ScriptStep = {
  kind: 'error',
  error: new LlmError('LLM_RATE_LIMITED', 'x', false),
};
const ok: ScriptStep = { kind: 'tools', text: 'ok' };

function candidate(
  providerId: string,
  model: string,
  steps: ScriptStep[],
): RoutedCandidate & { scripted: ScriptedLlmProvider } {
  const scripted = new ScriptedLlmProvider(steps, model);
  return {
    providerId,
    model,
    provider: scripted,
    capability: { tools: 'yes', structured: 'json_schema' },
    scripted,
  };
}

/** One call reserves about 350 tokens (prompt + tools preamble + output). */
function metered(
  fast: RoutedCandidate[],
  limits: Partial<BudgetLimits>,
  turnKey = 'turn-1',
): { llm: MeteredLlm; budget: TurnBudget; entries: LlmUsageEntry[] } {
  const budget = new TurnBudget(
    {
      maxTurnCostNano: 1_000_000,
      maxConversationCostNano: 1_000_000,
      maxCallsPerTurn: 10,
      maxToolRoundsPerTurn: 5,
      maxToolCallsPerTurn: 5,
      maxOutputTokensPerCall: 100,
      maxInputBytesPerCall: 10_000,
      ...limits,
    },
    { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
  );
  const entries: LlmUsageEntry[] = [];
  const router = new RoutingLlmProvider(
    { FAST: fast, STRONG: fast },
    BREAKER,
    snapshot,
    () => 0,
  );
  const llm = new MeteredLlm(
    router,
    snapshot,
    budget,
    { record: async (entry): Promise<void> => void entries.push(entry) },
    { tenantId: 't', turnKey },
  );
  return { llm, budget, entries };
}

/** Token reservation of one `request`, measured instead of assumed. */
async function reservationTokens(): Promise<number> {
  let reserved = 0;
  class Spy extends TurnBudget {
    override reserve(
      ...args: Parameters<TurnBudget['reserve']>
    ): ReturnType<TurnBudget['reserve']> {
      const reservation = super.reserve(...args);
      reserved = reservation.worstCaseTokens;
      return reservation;
    }
  }
  const llm = new MeteredLlm(
    new ScriptedLlmProvider([{ kind: 'tools', text: 'ok' }], 'ma'),
    snapshot,
    new Spy(
      {
        maxTurnCostNano: 1_000_000,
        maxConversationCostNano: 1_000_000,
        maxCallsPerTurn: 10,
        maxToolRoundsPerTurn: 5,
        maxToolCallsPerTurn: 5,
        maxOutputTokensPerCall: 100,
        maxInputBytesPerCall: 10_000,
      },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    ),
    { record: async (): Promise<void> => undefined },
    { tenantId: 't', turnKey: 'probe' },
  );
  await llm.withTools(request);
  return reserved;
}

describe('ambiguous (timeout) usage accounting', () => {
  let R = 0;
  beforeAll(async () => {
    R = await reservationTokens();
    expect(R).toBeGreaterThan(50);
  });

  it('does not fail over after a timeout when the budget cannot absorb a second billable call', async () => {
    const a = candidate('a', 'ma', [timeout]);
    const b = candidate('b', 'mb', [ok]);
    const { llm, budget, entries } = metered([a, b], {
      maxTurnTokens: Math.floor(R * 1.5),
    });
    await expect(llm.withTools(request)).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
    expect(b.scripted.calls).toHaveLength(0);
    expect(budget.snapshot.unknownExposureNano).toBe(0); // free model: 0 nano
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageBasis: 'unknown',
      outcome: 'unknown_usage:LLM_TIMEOUT',
      costNano: 0,
      providerId: 'a',
    });
    expect(entries[0].reservedNano).toBeGreaterThanOrEqual(0);
  });

  it('fails over after a timeout when the budget has room, recording both attempts', async () => {
    const a = candidate('a', 'ma', [timeout]);
    const b = candidate('b', 'mb', [ok]);
    const { llm, entries } = metered([a, b], { maxTurnTokens: R * 10 });
    const result = await llm.withTools(request);
    expect(result.text).toBe('ok');
    expect(b.scripted.calls).toHaveLength(1);
    expect(entries.map((e) => [e.model, e.usageBasis])).toEqual([
      ['ma', 'unknown'],
      ['mb', 'reported'],
    ]);
    expect(new Set(entries.map((e) => e.responseId)).size).toBe(2);
    expect(entries[0].responseId).toBe('unknown:turn-1:0:1');
  });

  it('gives a retried turn the same audit id, so persistence deduplicates it', async () => {
    const ids: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { llm, entries } = metered(
        [candidate('a', 'ma', [timeout]), candidate('b', 'mb', [ok])],
        { maxTurnTokens: R * 10 },
        'turn-retry',
      );
      await llm.withTools(request);
      ids.push(entries[0].responseId);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it('counts the unknown attempt against the turn: the next call is refused, not silently allowed', async () => {
    const { llm } = metered(
      [candidate('a', 'ma', [timeout, ok, ok]), candidate('b', 'mb', [ok])],
      { maxTurnTokens: Math.floor(R * 1.5) },
    );
    await expect(llm.withTools(request)).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
    await expect(llm.withTools(request)).rejects.toMatchObject({
      reason: 'TURN_TOKEN_LIMIT',
    });
  });

  it('still fails over immediately on errors that are certainly unbilled', async () => {
    const a = candidate('a', 'ma', [rateLimited]);
    const b = candidate('b', 'mb', [ok]);
    const { llm, entries } = metered([a, b], {
      maxTurnTokens: Math.floor(R * 1.5),
    });
    await expect(llm.withTools(request)).resolves.toMatchObject({ text: 'ok' });
    expect(entries.map((e) => e.usageBasis)).toEqual(['reported']);
  });

  it('keeps unknown usage when every candidate fails after a timeout', async () => {
    const a = candidate('a', 'ma', [timeout]);
    const b = candidate('b', 'mb', [rateLimited]);
    const { llm, entries } = metered([a, b], { maxTurnTokens: R * 10 });
    await expect(llm.withTools(request)).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
    });
    expect(entries.map((e) => e.usageBasis)).toEqual(['unknown']);
  });

  it('marks adapter-estimated usage as estimated, not reported', async () => {
    const stub: LlmProvider = {
      providerId: 'stub',
      modelFor: () => 'ma',
      generateStructured: () => Promise.reject(new Error('unused')),
      generateWithTools: (): Promise<ToolGenerationResult> =>
        Promise.resolve({
          providerId: 'stub',
          model: 'ma',
          responseId: 'r1',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            estimated: true,
          },
          stopReason: 'end',
          durationMs: 1,
          attempts: 1,
          text: 'ok',
          toolCalls: [],
          providerContent: undefined,
        }),
    };
    const entries: LlmUsageEntry[] = [];
    const llm = new MeteredLlm(
      stub,
      snapshot,
      new TurnBudget(
        {
          maxTurnCostNano: 1_000_000,
          maxConversationCostNano: 1_000_000,
          maxCallsPerTurn: 5,
          maxToolRoundsPerTurn: 5,
          maxToolCallsPerTurn: 5,
          maxOutputTokensPerCall: 100,
          maxInputBytesPerCall: 10_000,
        },
        { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
      ),
      { record: async (e): Promise<void> => void entries.push(e) },
      { tenantId: 't', turnKey: 'k' },
    );
    await llm.withTools(request);
    expect(entries[0].usageBasis).toBe('estimated');
  });
});

describe('router stays out of policy and handover', () => {
  it('imports no agent, safety, language or handover logic', () => {
    const files = readdirSync(resolve(__dirname)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    );
    for (const file of files) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      expect(source, file).not.toMatch(
        /core\/agent|core\/locales|handover|operator|LOW_LANG|display-gate/iu,
      );
    }
  });
});

describe('persisted exposure of unknown usage', () => {
  const limits = {
    maxTurnCostNano: 1e12,
    maxConversationCostNano: 1e12,
    maxCallsPerTurn: 20,
    maxToolRoundsPerTurn: 5,
    maxToolCallsPerTurn: 5,
    maxOutputTokensPerCall: 100,
    maxInputBytesPerCall: 10_000,
  };
  /** Worst-case nano of one paid call, measured. */
  async function reservationNano(): Promise<number> {
    let reserved = 0;
    class Spy extends TurnBudget {
      override reserve(
        ...args: Parameters<TurnBudget['reserve']>
      ): ReturnType<TurnBudget['reserve']> {
        const r = super.reserve(...args);
        reserved = r.worstCaseNano;
        return r;
      }
    }
    const llm = new MeteredLlm(
      new ScriptedLlmProvider([ok], 'pa'),
      snapshot,
      new Spy(limits, { conversationSpentNano: 0, tenantMonthSpentNano: 0 }),
      { record: async (): Promise<void> => undefined },
      { tenantId: 't', turnKey: 'probe' },
    );
    await llm.withTools(request);
    return reserved;
  }
  function paid(
    steps: ScriptStep[],
    budget: TurnBudget,
    sink: (e: LlmUsageEntry) => Promise<boolean | void> = async () => undefined,
    turnKey = 'k',
  ): MeteredLlm {
    const c = candidate('a', 'pa', steps);
    return new MeteredLlm(
      new RoutingLlmProvider(
        { FAST: [c], STRONG: [c] },
        BREAKER,
        snapshot,
        () => 0,
      ),
      snapshot,
      budget,
      { record: sink },
      { tenantId: 't', turnKey },
    );
  }
  let N = 0;
  let T = 0;
  beforeAll(async () => {
    T = await reservationTokens();
    N = await reservationNano();
    expect(N).toBeGreaterThan(0);
  });

  it('counts persisted exposure against the conversation budget without calling it spend', async () => {
    const budget = new TurnBudget(
      { ...limits, maxConversationCostNano: Math.floor(N * 1.5) },
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        conversationExposureNano: N,
      },
    );
    await expect(paid([ok], budget).withTools(request)).rejects.toMatchObject({
      reason: 'CONVERSATION_COST_LIMIT',
    });
    expect(budget.snapshot.spentNano).toBe(0);
  });

  it('counts persisted exposure against the tenant monthly budget', async () => {
    const budget = new TurnBudget(
      { ...limits, tenantMonthlyBudgetNano: Math.floor(N * 1.5) },
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        tenantMonthExposureNano: N,
      },
    );
    await expect(paid([ok], budget).withTools(request)).rejects.toMatchObject({
      reason: 'TENANT_MONTHLY_LIMIT',
    });
  });

  it('does not fail over after a timeout when persisted exposure leaves no room', async () => {
    const budget = new TurnBudget(
      { ...limits, maxConversationCostNano: Math.floor(N * 2.5) },
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        conversationExposureNano: N,
      },
    );
    const a = candidate('a', 'pa', [timeout]);
    const b = candidate('b', 'pb', [ok]);
    const llm = new MeteredLlm(
      new RoutingLlmProvider(
        { FAST: [a, b], STRONG: [a, b] },
        BREAKER,
        snapshot,
        () => 0,
      ),
      snapshot,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId: 't', turnKey: 'k' },
    );
    await expect(llm.withTools(request)).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
    expect(b.scripted.calls).toHaveLength(0);
  });

  it('accumulates repeated timeouts as bounded exposure until the budget refuses', async () => {
    const budget = new TurnBudget(
      { ...limits, maxConversationCostNano: Math.floor(N * 3.5) },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = paid([timeout, timeout, timeout, ok], budget);
    for (let i = 0; i < 3; i++)
      await expect(llm.withTools(request)).rejects.toMatchObject({
        code: 'LLM_TIMEOUT',
      });
    expect(budget.snapshot.unknownExposureNano).toBe(3 * N);
    expect(budget.snapshot.spentNano).toBe(0);
    await expect(llm.withTools(request)).rejects.toMatchObject({
      reason: 'CONVERSATION_COST_LIMIT',
    });
  });

  it('counts unknown token exposure separately from confirmed usage, and reserves it again for the next call', async () => {
    const budget = new TurnBudget(
      { ...limits, maxTurnTokens: Math.floor(T * 1.5) },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = paid([timeout, ok], budget);
    await expect(llm.withTools(request)).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
    expect(budget.snapshot.unknownExposureTokens).toBe(T);
    expect(budget.snapshot.tokensUsed).toBe(0);
    await expect(llm.withTools(request)).rejects.toMatchObject({
      reason: 'TURN_TOKEN_LIMIT',
    });
  });

  it('counts persisted unknown tokens against the conversation token budget', () => {
    const budget = new TurnBudget(
      { ...limits, maxConversationTokens: 1_000 },
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        conversationExposureTokens: 900,
      },
    );
    expect(() => budget.reserve(0, 10, 200)).toThrow(/CONVERSATION_TOKEN/u);
    expect(budget.canReserve(0, 50)).toBe(true);
    expect(budget.canReserve(0, 200)).toBe(false);
    expect(budget.snapshot.tokensUsed).toBe(0);
  });

  it('denies the call when the durable ledger refuses, and releases the in-memory reservation', async () => {
    const budget = new TurnBudget(limits, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    const c = candidate('a', 'pa', [ok]);
    const refusing: BudgetLedger = {
      reserve: async () => ({
        granted: false,
        reason: 'TENANT_MONTHLY_LIMIT',
      }),
      settle: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
    };
    const llm = new MeteredLlm(
      new RoutingLlmProvider(
        { FAST: [c], STRONG: [c] },
        BREAKER,
        snapshot,
        () => 0,
      ),
      snapshot,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId: 't', turnKey: 'k' },
      undefined,
      refusing,
    );
    await expect(llm.withTools(request)).rejects.toMatchObject({
      reason: 'TENANT_MONTHLY_LIMIT',
    });
    expect(c.scripted.calls).toHaveLength(0);
    expect(budget.snapshot.reservedNano).toBe(0);
    expect(budget.snapshot.stopReason).toBe('TENANT_MONTHLY_LIMIT');
  });

  it('fails closed when the ledger cannot persist a reservation', async () => {
    const c = candidate('a', 'pa', [ok]);
    const broken: BudgetLedger = {
      reserve: async () => {
        throw new Error('db down');
      },
      settle: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
    };
    const budget = new TurnBudget(limits, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    const llm = new MeteredLlm(
      c.scripted,
      snapshot,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId: 't', turnKey: 'k' },
      undefined,
      broken,
    );
    await expect(llm.withTools(request)).rejects.toThrow('db down');
    expect(c.scripted.calls).toHaveLength(0);
    expect(budget.snapshot.reservedNano).toBe(0);
  });

  it('still counts exposure when persisting the row fails', async () => {
    const budget = new TurnBudget(limits, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    await paid([timeout], budget, async () => {
      throw new Error('db down');
    })
      .withTools(request)
      .catch(() => undefined);
    expect(budget.snapshot.unknownExposureNano).toBe(N);
  });

  it('admits concurrent reservations atomically: never more than the budget allows', async () => {
    const budget = new TurnBudget(
      { ...limits, maxTurnCostNano: Math.floor(N * 3.5) },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = paid([ok, ok, ok, ok, ok, ok], budget);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => llm.withTools(request)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' &&
          (r.reason as { reason?: string }).reason === 'TURN_COST_LIMIT',
      ),
    ).toHaveLength(3);
    expect(budget.snapshot.reservedNano).toBe(0);
  });
});
