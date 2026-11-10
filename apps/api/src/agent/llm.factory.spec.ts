import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import {
  createLlmProvider,
  routedEffortByProvider,
  llmEnvironment,
  type LlmEnvironment,
} from './llm.factory.js';

/**
 * Latency audit 2026-11-10: `llmEnvironment` listed every LLM setting except
 * LLM_REASONING_EFFORT, so the application never sent the configured
 * thinking level (only the live-eval script, which reads process.env, did).
 */
function config(
  values: Record<string, unknown>,
): ConfigService<AppEnvironment, true> {
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
}

const ROUTED: Record<string, unknown> = {
  LLM_PROVIDER: 'routed',
  LLM_ROUTING_POLICY_FILE: 'builtin:gemini-primary',
  LLM_PRICING_VERSION: 'routing-gemini-paid-2026-11-09',
  LLM_TRUSTED_PROVIDERS: ['routed', 'gemini', 'groq', 'mistral', 'openrouter'],
  LLM_REQUEST_TIMEOUT_MS: 1_000,
  LLM_MAX_RETRIES: 0,
  LLM_MAX_INPUT_BYTES: 48_000,
};

async function effortsSent(
  environment: LlmEnvironment,
): Promise<Array<{ tier: string; effort: unknown }>> {
  const seen: Array<{ tier: string; effort: unknown }> = [];
  let tier = '';
  const transport = ((_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as {
      reasoning_effort?: unknown;
    };
    seen.push({ tier, effort: parsed.reasoning_effort });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'x',
          model: 'gemini-3.8-flash',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
  const provider = createLlmProvider(environment, transport, {
    GEMINI_API_KEY: 'k',
  });
  for (const next of ['FAST', 'STRONG'] as const) {
    tier = next;
    await provider.generateWithTools({
      tier: next,
      purpose: 'respond',
      system: 's',
      messages: [{ role: 'user', text: 'salom' }],
      tools: [],
      maxOutputTokens: 50,
    });
  }
  return seen;
}

describe('llmEnvironment reads the reasoning settings', () => {
  it('passes LLM_REASONING_EFFORT and LLM_FAST_REASONING_EFFORT through', () => {
    const environment = llmEnvironment(
      config({
        ...ROUTED,
        LLM_REASONING_EFFORT: 'low',
        LLM_FAST_REASONING_EFFORT: 'minimal',
      }),
    );
    expect(environment.LLM_REASONING_EFFORT).toBe('low');
    expect(environment.LLM_FAST_REASONING_EFFORT).toBe('minimal');
  });

  it('the routed app provider sends the configured effort to Gemini', async () => {
    const seen = await effortsSent(
      llmEnvironment(config({ ...ROUTED, LLM_REASONING_EFFORT: 'low' })),
    );
    expect(seen).toEqual([
      { tier: 'FAST', effort: 'low' },
      { tier: 'STRONG', effort: 'low' },
    ]);
  });

  it('LLM_FAST_REASONING_EFFORT changes extraction only', async () => {
    const seen = await effortsSent(
      llmEnvironment(
        config({
          ...ROUTED,
          LLM_REASONING_EFFORT: 'low',
          LLM_FAST_REASONING_EFFORT: 'minimal',
        }),
      ),
    );
    expect(seen).toEqual([
      { tier: 'FAST', effort: 'minimal' },
      { tier: 'STRONG', effort: 'low' },
    ]);
  });

  it('unset, nothing is sent (default unchanged)', async () => {
    const seen = await effortsSent(llmEnvironment(config(ROUTED)));
    expect(seen).toEqual([
      { tier: 'FAST', effort: undefined },
      { tier: 'STRONG', effort: undefined },
    ]);
  });

  it('a minimal effort fails over to Groq without sending it minimal', async () => {
    const seen: Array<{ host: string; effort: unknown }> = [];
    const transport = ((url: string | URL | Request, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const parsed = JSON.parse(String(init?.body)) as {
        reasoning_effort?: unknown;
      };
      seen.push({ host, effort: parsed.reasoning_effort });
      return Promise.resolve(
        host === 'api.groq.com'
          ? new Response(
              JSON.stringify({
                id: 'x',
                model: 'openai/gpt-oss-20b',
                choices: [
                  { finish_reason: 'stop', message: { content: 'ok' } },
                ],
                usage: { prompt_tokens: 3, completion_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response('{}', { status: 503 }),
      );
    }) as typeof fetch;
    const provider = createLlmProvider(
      llmEnvironment(config({ ...ROUTED, LLM_REASONING_EFFORT: 'minimal' })),
      transport,
      { GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k' },
    );
    await provider.generateWithTools({
      tier: 'FAST',
      purpose: 'respond',
      system: 's',
      messages: [{ role: 'user', text: 'salom' }],
      tools: [],
      maxOutputTokens: 50,
    });
    expect(seen).toEqual([
      { host: 'generativelanguage.googleapis.com', effort: 'minimal' },
      { host: 'api.groq.com', effort: undefined },
    ]);
  });

  it('never sends minimal to Groq, which rejects it', () => {
    expect(routedEffortByProvider('minimal')).toEqual({ gemini: 'minimal' });
    expect(routedEffortByProvider('low')).toEqual({
      gemini: 'low',
      groq: 'low',
    });
  });
});
