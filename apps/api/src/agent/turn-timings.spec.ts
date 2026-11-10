import { describe, expect, it } from 'vitest';
import type {
  LlmProvider,
  StructuredGenerationRequest,
  StructuredGenerationResult,
  ToolGenerationRequest,
  ToolGenerationResult,
} from '../core/llm/llm-provider.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import type { TurnTimings } from '../core/agent/turn-timings.js';
import { extraction, runTurn } from './testing/agent-harness.js';

const IELTS = 'mock-education:edu-ielts-001';
const WEEKDAY = 'mock-education:offer:ielts-group-weekday';

/** Delays (or advances a fake clock) around each scripted model call. */
class SlowProvider implements LlmProvider {
  readonly providerId = 'mock';
  constructor(
    private readonly inner: ScriptedLlmProvider,
    private readonly wait: (kind: 'extract' | 'respond') => Promise<void>,
  ) {}

  modelFor(tier: 'FAST' | 'STRONG'): string {
    return this.inner.modelFor(tier);
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    await this.wait('extract');
    return this.inner.generateStructured(request);
  }

  async generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    await this.wait('respond');
    return this.inner.generateWithTools(request);
  }
}

const PRICE_SCRIPT: ScriptStep[] = [
  extraction({ subject: 'IELTS' }, 'price'),
  {
    kind: 'tools',
    toolCalls: [{ name: 'list_offers', input: { itemId: IELTS } }],
  },
  {
    kind: 'tools',
    toolCalls: [{ name: 'get_quote', input: { offerId: WEEKDAY } }],
  },
  {
    kind: 'tools',
    text: '{{F1}} kursi narxi: {{F10}}. Sizga qulay vaqtni ayting.',
  },
];

function stageSum(t: TurnTimings): number {
  return (
    t.gatesMs +
    t.extractMs +
    t.searchMs +
    t.respondMs +
    t.guardrailMs +
    t.otherMs
  );
}

describe('agent turn: stage timings', () => {
  it('attributes model time to extract and respond with rounds and tools (fake clock)', async () => {
    let now = 0;
    const provider = new SlowProvider(
      new ScriptedLlmProvider(PRICE_SCRIPT),
      (kind) => {
        now += kind === 'extract' ? 3_000 : 2_000;
        return Promise.resolve();
      },
    );
    const { result } = await runTurn({
      provider,
      text: 'IELTS kursi narxi qancha?',
      clock: () => now,
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.timings).toEqual({
      totalMs: 9_000,
      gatesMs: 0,
      extractMs: 3_000,
      searchMs: 0,
      respondMs: 6_000,
      respondToolMs: 0,
      guardrailMs: 0,
      otherMs: 0,
      respondRounds: 3,
      toolExecutions: 2,
    });
  });

  it('stages sum to the measured wall-clock latency (real clock)', async () => {
    const provider = new SlowProvider(
      new ScriptedLlmProvider(PRICE_SCRIPT),
      (kind) =>
        new Promise((resolve) =>
          setTimeout(resolve, kind === 'extract' ? 30 : 20),
        ),
    );
    const started = performance.now();
    const { result } = await runTurn({
      provider,
      text: 'IELTS kursi narxi qancha?',
    });
    const latencyMs = performance.now() - started;
    const timings = result.timings!;
    expect(timings).toBeDefined();
    expect(timings.extractMs).toBeGreaterThanOrEqual(25);
    expect(timings.respondMs).toBeGreaterThanOrEqual(55);
    expect(timings.respondToolMs).toBeLessThanOrEqual(timings.respondMs);
    expect(timings.respondRounds).toBe(3);
    expect(timings.toolExecutions).toBe(2);
    // The named stages and the remainder add up to the turn's total
    // (rounding to 0.1 ms per field), and the total is the measured latency
    // minus only the harness setup around the call.
    expect(Math.abs(stageSum(timings) - timings.totalMs)).toBeLessThan(1);
    expect(timings.totalMs).toBeLessThanOrEqual(latencyMs + 0.1);
    expect(latencyMs - timings.totalMs).toBeLessThan(25);
  });

  it('a turn that stops at a tier-0 gate spends its time in the gates', async () => {
    const provider = new ScriptedLlmProvider([]);
    const { result } = await runTurn({ provider, text: '/stop' });
    expect(result.optOut).toBe(true);
    const timings = result.timings!;
    expect(timings.extractMs).toBe(0);
    expect(timings.respondRounds).toBe(0);
    expect(timings.gatesMs).toBe(timings.totalMs);
  });
});
