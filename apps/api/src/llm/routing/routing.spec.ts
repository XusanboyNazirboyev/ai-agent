import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TurnBudget } from '../../core/llm/budget.js';
import { LlmError } from '../../core/llm/llm-provider.js';
import { MeteredLlm } from '../../core/llm/metered-llm.js';
import { parsePricingConfig } from '../../core/llm/pricing.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import { PRICING_CATALOG } from '../pricing-catalog.js';
import {
  capabilityFor,
  PROVIDER_PRESETS,
  PresetError,
  resolvePreset,
} from '../provider-presets.js';
import { buildRoutedProvider, RoutingConfigError } from './routing-factory.js';
import { DEFAULT_ROUTING_POLICY } from './routing-policy.js';
import {
  RoutingLlmProvider,
  reservationModel,
  type RoutedCandidate,
} from './routing-provider.js';

const routing = PRICING_CATALOG.snapshot('routing-free-2026-10-23');
/** Free test models used by the router fixtures. */
const snapshot = parsePricingConfig({
  version: 'router-fixture-1',
  provider: 't',
  asOf: '2026-01-01',
  sourceUrl: 'https://example.invalid/p',
  models: Object.fromEntries(
    ['ma', 'mb', 'mc', 'm1', 'm2', 'mq', 'mq2', 'mo', 'openai/gpt-oss-20b'].map(
      (m) => [m, { free: true }],
    ),
  ),
});
const ok = (text = 'ok'): ScriptStep => ({ kind: 'tools', text });
const fail = (
  code: ConstructorParameters<typeof LlmError>[0],
  retryAfterMs?: number,
): ScriptStep => ({
  kind: 'error',
  error: new LlmError(code, 'x', false, retryAfterMs),
});

function candidate(
  providerId: string,
  model: string,
  steps: ScriptStep[] | ((n: number) => ScriptStep),
  capability: RoutedCandidate['capability'] = {
    tools: 'yes',
    structured: 'json_schema',
  },
): RoutedCandidate & { scripted: ScriptedLlmProvider } {
  let n = 0;
  const scripted = new ScriptedLlmProvider(
    typeof steps === 'function' ? (): ScriptStep => steps(n++) : steps,
    model,
  );
  return { providerId, model, provider: scripted, capability, scripted };
}

const toolRequest = {
  tier: 'FAST' as const,
  purpose: 'respond' as const,
  system: 's',
  messages: [{ role: 'user' as const, text: 'hi' }],
  tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  maxOutputTokens: 50,
};
const BREAKER = {
  breaker: {
    rateLimitCooldownMs: 60_000,
    providerCooldownMs: 900_000,
    transientCooldownMs: 30_000,
    transientFailures: 2,
  },
};

function router(
  fast: RoutedCandidate[],
  strong: RoutedCandidate[] = fast,
  now: () => number = () => 0,
): RoutingLlmProvider {
  return new RoutingLlmProvider(
    { FAST: fast, STRONG: strong },
    BREAKER,
    snapshot,
    now,
  );
}

describe('provider presets', () => {
  it('are explicit, untrusted, AgentCore-only and secret-free', () => {
    expect([...PROVIDER_PRESETS.keys()].sort()).toEqual([
      'gemini',
      'groq',
      'llm7',
      'mistral',
      'openrouter',
    ]);
    for (const preset of PROVIDER_PRESETS.values()) {
      expect(preset.trusted).toBe(false);
      expect(preset.integrationTarget).toBe('agentcore-llm-provider');
      expect(preset.protocol).toBe('openai-chat');
      expect(preset.apiKeyEnvVar).toMatch(/^[A-Z0-9_]+$/u);
      expect(JSON.stringify(preset)).not.toMatch(/sk-|AIza|Bearer /u);
    }
    expect(PROVIDER_PRESETS.get('openrouter')!.apiKeyEnvVar).toBe(
      'OPEN_ROUTER_API_KEY',
    );
  });

  it('reports a missing key or model by variable name only', () => {
    expect(() => resolvePreset('groq', {})).toThrow(/GROQ_API_KEY is not set/u);
    expect(() => resolvePreset('nope', {})).toThrow(PresetError);
    expect(() =>
      resolvePreset('openrouter', { OPEN_ROUTER_API_KEY: 'k' }),
    ).toThrow(/no default model/u);
    const resolved = resolvePreset('groq', { GROQ_API_KEY: 'secret-value' });
    expect(resolved.models.STRONG).toBe('openai/gpt-oss-120b');
    expect(() => resolvePreset('groq', {})).not.toThrow(/secret-value/u);
  });

  it('keeps unverified facts unverified and LLM7 json_object only', () => {
    const llm7 = PROVIDER_PRESETS.get('llm7')!;
    expect(capabilityFor(llm7, 'anything')).toMatchObject({
      tools: 'unknown',
      structured: 'json_object',
      status: 'unverified',
    });
    expect(
      capabilityFor(PROVIDER_PRESETS.get('groq')!, 'llama-3.1-8b-instant')
        .structured,
    ).toBe('json_object');
    expect(
      capabilityFor(PROVIDER_PRESETS.get('groq')!, 'openai/gpt-oss-20b')
        .structured,
    ).toBe('json_schema');
  });

  it('every default routed model is priced', () => {
    for (const tier of ['FAST', 'STRONG'] as const)
      for (const ref of DEFAULT_ROUTING_POLICY.tiers[tier])
        expect(routing.models[ref.model], ref.model).toBeDefined();
  });
});

describe('RoutingLlmProvider', () => {
  it('uses the first healthy capable candidate, per tier', async () => {
    const a = candidate('a', 'ma', [ok('from a')]);
    const b = candidate('b', 'mb', [ok('from b')]);
    const strongOnly = candidate('c', 'mc', [ok('from c')]);
    const r = new RoutingLlmProvider(
      { FAST: [a, b], STRONG: [strongOnly] },
      BREAKER,
      snapshot,
    );
    expect((await r.generateWithTools(toolRequest)).text).toBe('from a');
    expect(
      (await r.generateWithTools({ ...toolRequest, tier: 'STRONG' })).text,
    ).toBe('from c');
    expect(b.scripted.calls).toHaveLength(0);
  });

  it('skips candidates lacking tools or structured output, never calling them', async () => {
    const noTools = candidate('a', 'ma', [ok('x')], {
      tools: 'no',
      structured: 'json_schema',
    });
    const good = candidate('b', 'mb', [ok('b')]);
    const r = router([noTools, good]);
    expect((await r.generateWithTools(toolRequest)).text).toBe('b');
    expect(noTools.scripted.calls).toHaveLength(0);
    const onlyNoTools = router([noTools]);
    await expect(
      onlyNoTools.generateWithTools(toolRequest),
    ).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
  });

  it.each([
    'LLM_RATE_LIMITED',
    'LLM_QUOTA_EXHAUSTED',
    'LLM_UNAVAILABLE',
    'LLM_TIMEOUT',
    'LLM_UNSUPPORTED_FEATURE',
    'LLM_AUTHENTICATION',
  ] as const)('fails over on %s and sums attempts', async (code) => {
    const a = candidate('a', 'ma', [fail(code)]);
    const b = candidate('b', 'mb', [ok('b')]);
    const r = router([a, b]);
    const result = await r.generateWithTools(toolRequest);
    expect(result.text).toBe('b');
    expect(result.attempts).toBe(2);
    expect(r.stats.failovers).toBe(1);
  });

  it('never fails over on invalid requests or cancellation, nor after a billed result', async () => {
    for (const code of ['LLM_INVALID_REQUEST', 'LLM_CANCELLED'] as const) {
      const a = candidate('a', 'ma', [fail(code)]);
      const b = candidate('b', 'mb', [ok('b')]);
      await expect(
        router([a, b]).generateWithTools(toolRequest),
      ).rejects.toMatchObject({ code });
      expect(b.scripted.calls).toHaveLength(0);
    }
    const bad = candidate('a', 'ma', [
      { kind: 'structured', failure: 'malformed' },
    ]);
    const next = candidate('b', 'mb', [
      { kind: 'structured', value: { ok: true } },
    ]);
    const result = await router([bad, next]).generateStructured({
      tier: 'FAST',
      purpose: 'extract',
      system: 's',
      messages: [{ role: 'user', text: 'x' }],
      schemaName: 'x',
      jsonSchema: { type: 'object' },
      schema: z.object({ ok: z.boolean() }),
      maxOutputTokens: 50,
    });
    expect(result.failure).toBe('malformed');
    expect(next.scripted.calls).toHaveLength(0);
  });

  it('opens breakers: quota closes the provider, rate limit one pair, then reopens', async () => {
    let t = 0;
    const a1 = candidate('a', 'm1', (n) =>
      n === 0 ? fail('LLM_RATE_LIMITED', 5_000) : ok('a1'),
    );
    const a2 = candidate('a', 'm2', [ok('a2'), ok('a2')]);
    const b = candidate('b', 'mb', () => ok('b'));
    const r = router([a1, a2, b], [b], () => t);
    expect((await r.generateWithTools(toolRequest)).text).toBe('a2'); // a/m1 limited
    expect((await r.generateWithTools(toolRequest)).text).toBe('a2'); // a/m1 still open
    expect(a1.scripted.calls).toHaveLength(1);
    t = 61_000; // cooldown over: a/m1 is tried again
    expect((await r.generateWithTools(toolRequest)).text).toBe('a1');

    const q = candidate('q', 'mq', [fail('LLM_QUOTA_EXHAUSTED')]);
    const q2 = candidate('q', 'mq2', [ok('never')]);
    const other = candidate('o', 'mo', () => ok('o'));
    const r2 = router([q, q2, other], [other], () => t);
    expect((await r2.generateWithTools(toolRequest)).text).toBe('o');
    expect(q2.scripted.calls).toHaveLength(0); // whole provider q is open
  });

  it('opens a pair after consecutive transient failures only', async () => {
    const a = candidate('a', 'ma', () => fail('LLM_UNAVAILABLE'));
    const b = candidate('b', 'mb', () => ok('b'));
    const r = router([a, b], [b]);
    await r.generateWithTools(toolRequest);
    await r.generateWithTools(toolRequest); // 2nd failure trips the breaker
    await r.generateWithTools(toolRequest);
    expect(a.scripted.calls).toHaveLength(2);
  });

  it('fails with the last error when every candidate fails (handover path)', async () => {
    const r = router([
      candidate('a', 'ma', [fail('LLM_QUOTA_EXHAUSTED')]),
      candidate('b', 'mb', [fail('LLM_RATE_LIMITED')]),
    ]);
    await expect(r.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
    });
    expect(r.stats.exhausted).toBe(1);
  });

  it('keeps provider-native content with the provider that made it', async () => {
    const a = candidate('a', 'ma', [
      { kind: 'tools', toolCalls: [{ name: 't', input: {} }] },
      ok('done'),
    ]);
    const r = router([a]);
    const first = await r.generateWithTools(toolRequest);
    expect(first.providerContent).toBeUndefined(); // scripted has none
    const foreign = {
      role: 'assistant' as const,
      text: '',
      toolCalls: [],
      providerContent: { routedBy: 'zzz/other', inner: 'thinking' },
    };
    await r.generateWithTools({
      ...toolRequest,
      messages: [...toolRequest.messages, foreign],
    });
    const sent = a.scripted.calls[1].request.messages.at(-1) as {
      providerContent?: unknown;
    };
    expect(sent.providerContent).toBeUndefined();
  });

  it('prices the most expensive candidate and refuses a lower long-prompt ceiling', () => {
    const priced = parsePricingConfig({
      version: 'router-test-1',
      provider: 't',
      asOf: '2026-01-01',
      sourceUrl: 'https://example.invalid/p',
      models: {
        cheap: {
          inputPerMTok: '0.1',
          outputPerMTok: '0.5',
          cacheReadPerMTok: '0.01',
          cacheWrite5mPerMTok: '0.125',
          cacheWrite1hPerMTok: '0.2',
        },
        dear: {
          inputPerMTok: '2',
          outputPerMTok: '10',
          cacheReadPerMTok: '0.1',
          cacheWrite5mPerMTok: '2.5',
          cacheWrite1hPerMTok: '4',
        },
        tiered: {
          inputPerMTok: '1',
          outputPerMTok: '5',
          cacheReadPerMTok: '0.1',
          cacheWrite5mPerMTok: '1.25',
          cacheWrite1hPerMTok: '2',
          longPrompt: {
            thresholdTokens: 1000,
            inputPerMTok: '2',
            outputPerMTok: '10',
            cacheReadPerMTok: '0.2',
            cacheWrite5mPerMTok: '2.5',
            cacheWrite1hPerMTok: '4',
          },
        },
      },
    });
    const c = (model: string): RoutedCandidate => candidate('p', model, []);
    expect(reservationModel([c('cheap'), c('dear')], priced)).toBe('dear');
    expect(() => reservationModel([c('dear'), c('tiered')], priced)).toThrow(
      /long-prompt ceiling/u,
    );
    const mixed = parsePricingConfig({
      version: 'router-test-2',
      provider: 't',
      asOf: '2026-01-01',
      sourceUrl: 'https://example.invalid/p',
      models: {
        cheapIn: {
          inputPerMTok: '1',
          outputPerMTok: '10',
          cacheReadPerMTok: '0.1',
          cacheWrite5mPerMTok: '1.25',
          cacheWrite1hPerMTok: '2',
        },
        cheapOut: {
          inputPerMTok: '5',
          outputPerMTok: '2',
          cacheReadPerMTok: '0.1',
          cacheWrite5mPerMTok: '6',
          cacheWrite1hPerMTok: '10',
        },
      },
    });
    expect(() =>
      reservationModel([c('cheapIn'), c('cheapOut')], mixed),
    ).toThrow(/dominates/u);
  });

  it('works under MeteredLlm: token budget stops a free-model loop, usage is unchanged', async () => {
    const a = candidate('a', 'openai/gpt-oss-20b', () => ok('again'));
    const r = router([a]);
    const budget = new TurnBudget(
      {
        maxTurnCostNano: 1_000_000,
        maxConversationCostNano: 1_000_000,
        maxCallsPerTurn: 50,
        maxToolRoundsPerTurn: 5,
        maxToolCallsPerTurn: 5,
        maxOutputTokensPerCall: 100,
        maxInputBytesPerCall: 10_000,
        maxTurnTokens: 1_000,
      },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const llm = new MeteredLlm(
      r,
      snapshot,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId: 't', turnKey: 'k' },
    );
    let stop: unknown;
    for (let i = 0; i < 50 && !stop; i++)
      await llm.withTools(toolRequest).catch((e: unknown) => {
        stop = e;
      });
    expect(stop).toMatchObject({ reason: 'TURN_TOKEN_LIMIT' });
    expect(budget.snapshot.spentNano).toBe(0);
  });
});

describe('buildRoutedProvider', () => {
  const base = {
    policy: DEFAULT_ROUTING_POLICY,
    snapshot: routing,
    requestTimeoutMs: 500,
    maxRetries: 2,
  };
  const reply = (provider: string): typeof fetch =>
    (async () =>
      new Response(
        JSON.stringify({
          id: `id-${provider}`,
          model: 'm',
          choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

  it('skips providers whose key variable is unset and names the variable only', () => {
    const built = buildRoutedProvider({
      ...base,
      env: { GROQ_API_KEY: 'k1' },
      trustedProviders: ['mock'],
      fetch: reply('x'),
    });
    expect(built.skipped.map((s) => s.reason)).toEqual([
      'GEMINI_API_KEY not set',
      'GEMINI_API_KEY not set',
    ]);
    expect(JSON.stringify(built.skipped)).not.toContain('k1');
  });

  it('refuses to boot when a tier has no usable candidate', () => {
    expect(() =>
      buildRoutedProvider({ ...base, env: {}, trustedProviders: ['mock'] }),
    ).toThrow(RoutingConfigError);
  });

  it('never routes to a provider outside the trusted list once the router is trusted', () => {
    expect(() =>
      buildRoutedProvider({
        ...base,
        env: { GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' },
        trustedProviders: ['mock', 'routed'],
      }),
    ).toThrow(/no usable candidate/u);
    const built = buildRoutedProvider({
      ...base,
      env: { GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' },
      trustedProviders: ['mock', 'routed', 'groq'],
      fetch: reply('groq'),
    });
    expect(
      built.skipped.every((s) => s.reason === 'provider not trusted'),
    ).toBe(true);
  });

  it('refuses an input ceiling above a candidate long-prompt threshold', () => {
    const tiered = parsePricingConfig({
      version: 'router-test-3',
      provider: 't',
      asOf: '2026-01-01',
      sourceUrl: 'https://example.invalid/p',
      models: {
        'openai/gpt-oss-20b': {
          inputPerMTok: '1',
          outputPerMTok: '5',
          cacheReadPerMTok: '0.1',
          cacheWrite5mPerMTok: '1.25',
          cacheWrite1hPerMTok: '2',
          longPrompt: {
            thresholdTokens: 10_000,
            inputPerMTok: '2',
            outputPerMTok: '10',
            cacheReadPerMTok: '0.2',
            cacheWrite5mPerMTok: '2.5',
            cacheWrite1hPerMTok: '4',
          },
        },
        'openai/gpt-oss-120b': { free: true },
        'gemini-3.5-flash-lite': { free: true },
        'gemini-3.8-flash': { free: true },
      },
    });
    expect(() =>
      buildRoutedProvider({
        ...base,
        snapshot: tiered,
        env: { GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' },
        trustedProviders: ['mock'],
        maxInputBytes: 48_000,
      }),
    ).toThrow(/long-prompt tier/u);
  });

  it('skips unpriced models', () => {
    const built = buildRoutedProvider({
      ...base,
      policy: {
        ...DEFAULT_ROUTING_POLICY,
        tiers: {
          FAST: [
            { provider: 'groq', model: 'openai/gpt-oss-20b' },
            { provider: 'groq', model: 'unpriced-model' },
          ],
          STRONG: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }],
        },
      },
      env: { GROQ_API_KEY: 'k' },
      trustedProviders: ['mock'],
      fetch: reply('groq'),
    });
    expect(built.skipped).toEqual([
      { candidate: 'groq/unpriced-model', reason: 'model not priced' },
    ]);
  });

  it('routes a request through the adapter and fails over on a 429 then 200', async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('groq'))
        return new Response('{}', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      return reply('g')(url);
    }) as unknown as typeof fetch;
    const onFailover = vi.fn();
    const built = buildRoutedProvider({
      ...base,
      maxRetries: 0,
      env: { GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' },
      trustedProviders: ['mock'],
      fetch: f,
      onFailover,
    });
    const result = await built.provider.generateWithTools({
      ...toolRequest,
      tools: [],
    });
    expect(result).toMatchObject({ text: 'hello', providerId: 'gemini' });
    expect(onFailover).toHaveBeenCalledWith({
      tier: 'FAST',
      from: 'groq/openai/gpt-oss-20b',
      code: 'LLM_RATE_LIMITED',
    });
    expect(calls[0]).toContain('api.groq.com');
  });
});

describe('model policy is preserved', () => {
  const root = resolve(process.cwd(), '../..');
  it('keeps the Sonnet default and no Fable/best/Mythos selection', () => {
    const settings = JSON.parse(
      readFileSync(resolve(root, '.claude/settings.json'), 'utf8'),
    ) as { model: string };
    expect(settings.model).toBe('sonnet');
    for (const file of readdirSync(resolve(root, '.claude/agents'))) {
      const model = /^model:\s*(\S+)/mu.exec(
        readFileSync(resolve(root, '.claude/agents', file), 'utf8'),
      )?.[1];
      expect(['haiku', 'sonnet', 'opus']).toContain(model);
    }
  });
});

describe('smoke test module (fake transport)', () => {
  it('detects tools and json_schema, never exposes the key', async () => {
    const { smokeProvider, renderStatus } = await import('../smoke.js');
    const answers = [
      {
        choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c',
                  type: 'function',
                  function: { name: 'ping', arguments: '{"value":"x"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      },
      {
        choices: [
          { finish_reason: 'stop', message: { content: '{"ok":true}' } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
    ];
    const f = (async () =>
      new Response(JSON.stringify({ id: 'x', ...answers.shift() }), {
        status: 200,
      })) as unknown as typeof fetch;
    const result = await smokeProvider({
      preset: PROVIDER_PRESETS.get('groq')!,
      model: 'openai/gpt-oss-20b',
      apiKey: 'secret-key-value',
      fetch: f,
    });
    expect(result).toMatchObject({
      chat: 'ok',
      tools: 'yes',
      jsonSchema: 'yes',
      inputTokens: 35,
      outputTokens: 13,
      usageReported: true,
    });
    const text = renderStatus(
      [result, { provider: 'llm7', skipped: 'LLM7 model not set' }],
      '2026-10-23',
    );
    expect(text).toContain('| groq | openai/gpt-oss-20b | ok | yes | yes |');
    expect(text).not.toContain('secret-key-value');
  });

  it('records typed errors instead of throwing', async () => {
    const { smokeProvider } = await import('../smoke.js');
    const f = (async () =>
      new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const result = await smokeProvider({
      preset: PROVIDER_PRESETS.get('gemini')!,
      model: 'gemini-3.1-flash-lite',
      apiKey: 'k',
      fetch: f,
    });
    expect(result).toMatchObject({
      chat: 'LLM_RATE_LIMITED',
      tools: 'LLM_RATE_LIMITED',
      jsonSchema: 'LLM_RATE_LIMITED',
    });
  });
});
