import { describe, expect, it } from 'vitest';
import { TurnBudget } from '../../core/llm/budget.js';
import {
  LlmError,
  type LlmErrorCode,
  type LlmProvider,
  type LlmStreamEvent,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../../core/llm/metered-llm.js';
import { parsePricingConfig } from '../../core/llm/pricing.js';
import {
  ClientRateLimiter,
  RateLimitedLlmProvider,
} from '../rate-limited-provider.js';
import { RoutingLlmProvider } from './routing-provider.js';

/** Streaming through the router, the rate limiter and the meter (ADR 045). */

const snapshot = parsePricingConfig({
  version: 'stream-fixture-1',
  provider: 't',
  asOf: '2026-01-01',
  sourceUrl: 'https://example.invalid/p',
  models: { ma: { free: true }, mb: { free: true } },
});

const REQUEST: ToolGenerationRequest = {
  tier: 'FAST',
  purpose: 'respond',
  system: 's',
  messages: [{ role: 'user', text: 'salom' }],
  tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  maxOutputTokens: 50,
};

type Step =
  | { kind: 'ok'; deltas: string[] }
  | { kind: 'fail'; deltas: string[]; code: LlmErrorCode };

/** A provider that streams the deltas of each step, then ends or fails. */
function streaming(
  providerId: string,
  model: string,
  steps: Step[],
): LlmProvider & { calls: number } {
  const provider = {
    providerId,
    calls: 0,
    modelFor: (): string => model,
    generateStructured: (): Promise<never> =>
      Promise.reject(new Error('unused')),
    generateWithTools: (): Promise<never> =>
      Promise.reject(new Error('streaming only')),
    streamWithTools(
      _request: ToolGenerationRequest,
      onEvent: (event: LlmStreamEvent) => void,
    ): Promise<ToolGenerationResult> {
      provider.calls += 1;
      const step = steps.shift();
      if (!step) return Promise.reject(new Error('no step left'));
      for (const delta of step.deltas) onEvent({ type: 'text', delta });
      if (step.kind === 'fail')
        return Promise.reject(new LlmError(step.code, 'x', false));
      return Promise.resolve({
        providerId,
        model,
        responseId: `${providerId}-r${provider.calls}`,
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        },
        stopReason: 'end',
        durationMs: 1,
        attempts: 1,
        text: step.deltas.join(''),
        toolCalls: [],
        providerContent: undefined,
      });
    },
  };
  return provider;
}

function router(...providers: LlmProvider[]): RoutingLlmProvider {
  const candidates = providers.map((provider) => ({
    providerId: provider.providerId,
    model: provider.modelFor('FAST'),
    provider,
    capability: { tools: 'yes' as const, structured: 'json_schema' as const },
  }));
  return new RoutingLlmProvider(
    { FAST: candidates, STRONG: candidates },
    {
      breaker: {
        rateLimitCooldownMs: 60_000,
        providerCooldownMs: 900_000,
        transientCooldownMs: 30_000,
        transientFailures: 2,
      },
    },
    snapshot,
    () => 0,
  );
}

function collect(): {
  events: LlmStreamEvent[];
  onEvent: (e: LlmStreamEvent) => void;
} {
  const events: LlmStreamEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe('RoutingLlmProvider.streamWithTools', () => {
  it('fails over when the first provider fails before any output', async () => {
    const a = streaming('a', 'ma', [
      { kind: 'fail', deltas: [], code: 'LLM_UNAVAILABLE' },
    ]);
    const b = streaming('b', 'mb', [{ kind: 'ok', deltas: ['Sa', 'lom'] }]);
    const { events, onEvent } = collect();
    const result = await router(a, b).streamWithTools(REQUEST, onEvent);
    expect(result.text).toBe('Salom');
    expect(result.attempts).toBe(2);
    expect(events.map((e) => e.type === 'text' && e.delta)).toEqual([
      'Sa',
      'lom',
    ]);
  });

  it('never fails over once output started: the reply is not repeated', async () => {
    const a = streaming('a', 'ma', [
      { kind: 'fail', deltas: ['Albatta, '], code: 'LLM_STREAM_INTERRUPTED' },
    ]);
    const b = streaming('b', 'mb', [{ kind: 'ok', deltas: ['Albatta, ha.'] }]);
    const { events, onEvent } = collect();
    await expect(
      router(a, b).streamWithTools(REQUEST, onEvent),
    ).rejects.toMatchObject({ code: 'LLM_STREAM_INTERRUPTED' });
    expect(b.calls).toBe(0);
    expect(events).toEqual([{ type: 'text', delta: 'Albatta, ' }]);
  });

  it('passes through the client rate limiter', async () => {
    const a = streaming('a', 'ma', [{ kind: 'ok', deltas: ['Ha'] }]);
    const limited = new RateLimitedLlmProvider(
      a,
      new ClientRateLimiter(
        {
          requestsPerMinute: 10,
          tokensPerMinute: 100_000,
          requestsPerDay: 100,
          maxWaitMs: 0,
        },
        () => 0,
        () => Promise.resolve(),
      ),
    );
    const { events, onEvent } = collect();
    const result = await limited.streamWithTools(REQUEST, onEvent);
    expect(result.text).toBe('Ha');
    expect(events).toHaveLength(1);
  });
});

describe('MeteredLlm.streamWithTools', () => {
  function metered(provider: LlmProvider): {
    llm: MeteredLlm;
    entries: LlmUsageEntry[];
  } {
    const entries: LlmUsageEntry[] = [];
    const budget = new TurnBudget(
      {
        maxTurnCostNano: 1_000_000,
        maxConversationCostNano: 1_000_000,
        maxCallsPerTurn: 10,
        maxToolRoundsPerTurn: 5,
        maxToolCallsPerTurn: 5,
        maxOutputTokensPerCall: 100,
        maxInputBytesPerCall: 10_000,
        maxTurnTokens: 10_000,
      },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = new MeteredLlm(
      provider,
      snapshot,
      budget,
      {
        record: (entry): Promise<void> => {
          entries.push(entry);
          return Promise.resolve();
        },
      },
      { tenantId: 't', turnKey: 'k' },
    );
    return { llm, entries };
  }

  it('records the reported usage of a finished stream', async () => {
    const { llm, entries } = metered(
      streaming('a', 'ma', [{ kind: 'ok', deltas: ['Ha'] }]),
    );
    const { onEvent } = collect();
    await llm.streamWithTools(REQUEST, onEvent);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageBasis: 'reported',
      outcome: 'end',
    });
  });

  it('accounts an interrupted stream as unknown usage (it may be billed)', async () => {
    const { llm, entries } = metered(
      streaming('a', 'ma', [
        { kind: 'fail', deltas: ['Al'], code: 'LLM_STREAM_INTERRUPTED' },
      ]),
    );
    const { onEvent } = collect();
    await expect(llm.streamWithTools(REQUEST, onEvent)).rejects.toMatchObject({
      code: 'LLM_STREAM_INTERRUPTED',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageBasis: 'unknown',
      outcome: 'unknown_usage:LLM_STREAM_INTERRUPTED',
    });
  });
});
