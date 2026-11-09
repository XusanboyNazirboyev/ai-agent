import { describe, expect, it } from 'vitest';
import { createVoiceLlmProvider } from './voice-llm.js';

function capture(): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fake = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(
        'data: {"choices":[{"delta":{"content":"Ha."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
  };
  return { fetch: fake as typeof fetch, calls };
}

const REQUEST = {
  tier: 'FAST' as const,
  purpose: 'respond' as const,
  system: 's',
  messages: [{ role: 'user' as const, text: 'salom' }],
  tools: [],
  maxOutputTokens: 50,
};

describe('createVoiceLlmProvider', () => {
  it('defaults to the groq preset and its FAST model, streaming', async () => {
    const { fetch, calls } = capture();
    const { provider, config } = createVoiceLlmProvider(
      { GROQ_API_KEY: 'test-placeholder' },
      { fetch },
    );
    expect(config).toEqual({ presetId: 'groq', model: 'openai/gpt-oss-20b' });
    expect(provider.streamWithTools).toBeDefined();
    const result = await provider.streamWithTools!(REQUEST, () => undefined);
    expect(result.text).toBe('Ha.');
    expect(calls[0]!.url).toBe(
      'https://api.groq.com/openai/v1/chat/completions',
    );
    expect(calls[0]!.body).toMatchObject({
      model: 'openai/gpt-oss-20b',
      stream: true,
    });
  });

  it('takes another preset and model from the environment', () => {
    const { config } = createVoiceLlmProvider({
      VOICE_LLM_PRESET: 'gemini',
      VOICE_LLM_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_API_KEY: 'test-placeholder',
    });
    expect(config).toEqual({
      presetId: 'gemini',
      model: 'gemini-3.5-flash-lite',
    });
  });

  it('names the missing key variable, never a value', () => {
    expect(() => createVoiceLlmProvider({})).toThrow(/GROQ_API_KEY/u);
  });

  it('rejects an out-of-range timeout', () => {
    expect(() =>
      createVoiceLlmProvider({
        GROQ_API_KEY: 'test-placeholder',
        VOICE_LLM_TIMEOUT_MS: '50',
      }),
    ).toThrow(/VOICE_LLM_TIMEOUT_MS/u);
  });
});
