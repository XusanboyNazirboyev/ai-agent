import { describe, expect, it, vi } from 'vitest';
import {
  LlmError,
  type LlmProvider,
  type LlmStreamEvent,
  streamToolsWithFallback,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../../core/llm/llm-provider.js';
import {
  OpenAiCompatibleLlmProvider,
  type OpenAiCompatibleOptions,
} from './openai-compatible-provider.js';

/**
 * Streaming (`stream: true`) on hand-written `chat.completion.chunk` SSE
 * fixtures shaped after the OpenAI chat streaming reference (read
 * 2026-11-09): `choices[].delta` {content, refusal, tool_calls[{index, id,
 * type, function{name, arguments}}]}, `finish_reason`, `usage` on the last
 * chunk when `stream_options.include_usage`, then `data: [DONE]`.
 */

type StreamReply =
  | { status: number; body: unknown }
  | { events: string[]; breakAfter?: boolean };

function sse(...chunks: unknown[]): string[] {
  return chunks.map((chunk) =>
    chunk === '[DONE]'
      ? 'data: [DONE]\n\n'
      : `data: ${JSON.stringify(chunk)}\n\n`,
  );
}

function transport(replies: StreamReply[]): {
  fetch: typeof fetch;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fake = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies.shift();
    if (!reply) throw new Error('no fixture left');
    if ('status' in reply)
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    const encoder = new TextEncoder();
    // Every event split in two so the parser must buffer partial lines.
    const pieces = reply.events.flatMap((event) => {
      const middle = Math.floor(event.length / 2);
      return [event.slice(0, middle), event.slice(middle)];
    });
    const body = new ReadableStream<Uint8Array>({
      // One piece per read, so a break comes after the reader saw the rest.
      pull(controller): void {
        const piece = pieces.shift();
        if (piece !== undefined) controller.enqueue(encoder.encode(piece));
        else if (reply.breakAfter) controller.error(new Error('socket reset'));
        else controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return { fetch: fake as typeof fetch, bodies };
}

function provider(
  replies: StreamReply[],
  overrides: Partial<OpenAiCompatibleOptions> = {},
): {
  llm: OpenAiCompatibleLlmProvider;
  bodies: Record<string, unknown>[];
} {
  const { fetch, bodies } = transport(replies);
  const llm = new OpenAiCompatibleLlmProvider({
    baseUrl: 'https://llm.example.test/v1',
    apiKey: 'test-placeholder-key',
    models: { FAST: 'fast-model', STRONG: 'strong-model' },
    structuredOutput: 'json_schema',
    maxTokensParam: 'max_tokens',
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    fetch,
    sleep: vi.fn().mockResolvedValue(undefined),
    random: (): number => 0.5,
    ...overrides,
  });
  return { llm, bodies };
}

const REQUEST: ToolGenerationRequest = {
  tier: 'FAST',
  purpose: 'respond',
  system: 'You are a voice agent.',
  messages: [{ role: 'user', text: 'Kurs narxi qancha?' }],
  maxOutputTokens: 200,
  tools: [
    {
      name: 'search_catalog',
      description: 'Find courses',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
};

const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
): Record<string, unknown> => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: 'fast-model-001',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usage = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: 'fast-model-001',
  choices: [],
  usage: {
    prompt_tokens: 50,
    completion_tokens: 9,
    prompt_tokens_details: { cached_tokens: 10 },
  },
};

describe('OpenAiCompatibleLlmProvider.streamWithTools', () => {
  it('emits text deltas in order and returns the whole reply with usage', async () => {
    const { llm, bodies } = provider([
      {
        events: sse(
          chunk({ role: 'assistant', content: 'Albatta, ' }),
          chunk({ content: 'hozir tekshiraman.' }),
          chunk({}, 'stop'),
          usage,
          '[DONE]',
        ),
      },
    ]);
    const events: LlmStreamEvent[] = [];
    const result = await llm.streamWithTools(REQUEST, (e) => events.push(e));

    expect(bodies[0]).toMatchObject({
      model: 'fast-model',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 200,
    });
    expect(events).toEqual([
      { type: 'text', delta: 'Albatta, ' },
      { type: 'text', delta: 'hozir tekshiraman.' },
    ]);
    expect(result).toMatchObject({
      providerId: 'openai-compatible',
      model: 'fast-model-001',
      responseId: 'chatcmpl-1',
      text: 'Albatta, hozir tekshiraman.',
      toolCalls: [],
      stopReason: 'end',
      attempts: 1,
      usage: { inputTokens: 40, cacheReadTokens: 10, outputTokens: 9 },
    });
    expect(result.usage.estimated).toBeUndefined();
  });

  it('assembles tool-call arguments split across chunks and signals the call once', async () => {
    const { llm } = provider([
      {
        events: sse(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'search_catalog', arguments: '{"que' },
                extra_content: { google: { thought_signature: 'sig' } },
              },
            ],
          }),
          chunk({
            tool_calls: [
              { index: 0, function: { arguments: 'ry":"ingliz"}' } },
            ],
          }),
          chunk({}, 'tool_calls'),
          usage,
          '[DONE]',
        ),
      },
    ]);
    const events: LlmStreamEvent[] = [];
    const result = await llm.streamWithTools(REQUEST, (e) => events.push(e));

    expect(events).toEqual([
      { type: 'tool_call_started', name: 'search_catalog' },
    ]);
    expect(result.stopReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'search_catalog', input: { query: 'ingliz' } },
    ]);
    // Gemini 3 needs the signature echoed back on the next request.
    expect(result.providerContent).toEqual({
      openAiCompatibleExtraContent: {
        call_1: { google: { thought_signature: 'sig' } },
      },
    });
  });

  it('accepts a stream that ends without [DONE] or usage and estimates usage', async () => {
    const { llm } = provider([
      { events: sse(chunk({ content: 'Ha.' }), chunk({}, 'stop')) },
    ]);
    const result = await llm.streamWithTools(REQUEST, () => undefined);
    expect(result.text).toBe('Ha.');
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('retries a transient HTTP failure before the stream starts', async () => {
    const { llm, bodies } = provider([
      { status: 503, body: { error: { message: 'overloaded' } } },
      { events: sse(chunk({ content: 'Ha.' }), chunk({}, 'stop'), '[DONE]') },
    ]);
    const result = await llm.streamWithTools(REQUEST, () => undefined);
    expect(result.text).toBe('Ha.');
    expect(result.attempts).toBe(2);
    expect(bodies).toHaveLength(2);
  });

  it('reports a stream broken after output as interrupted, never retried', async () => {
    const { llm, bodies } = provider([
      { events: sse(chunk({ content: 'Albatta, ' })), breakAfter: true },
    ]);
    const events: LlmStreamEvent[] = [];
    const failure = await llm
      .streamWithTools(REQUEST, (e) => events.push(e))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmError);
    expect((failure as LlmError).code).toBe('LLM_STREAM_INTERRUPTED');
    expect(events).toEqual([{ type: 'text', delta: 'Albatta, ' }]);
    expect(bodies).toHaveLength(1);
  });

  it('treats an error object inside the stream as an interruption', async () => {
    const { llm } = provider([
      {
        events: sse(chunk({ content: 'Al' }), {
          error: { message: 'internal', code: 500 },
        }),
      },
    ]);
    await expect(
      llm.streamWithTools(REQUEST, () => undefined),
    ).rejects.toMatchObject({ code: 'LLM_STREAM_INTERRUPTED' });
  });

  it('fails fast when the model cannot call tools', async () => {
    const { llm, bodies } = provider([], {
      capabilityOf: () => ({ tools: 'no', structured: 'json_schema' }),
    });
    await expect(
      llm.streamWithTools(REQUEST, () => undefined),
    ).rejects.toMatchObject({ code: 'LLM_UNSUPPORTED_FEATURE' });
    expect(bodies).toHaveLength(0);
  });
});

describe('streamToolsWithFallback', () => {
  it('uses the whole reply of a provider that cannot stream', async () => {
    const whole: ToolGenerationResult = {
      providerId: 'plain',
      model: 'm',
      responseId: 'r',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      stopReason: 'tool_calls',
      durationMs: 1,
      attempts: 1,
      text: 'Bir daqiqa.',
      toolCalls: [{ id: 'c', name: 'search_catalog', input: {} }],
      providerContent: undefined,
    };
    const plain: LlmProvider = {
      providerId: 'plain',
      modelFor: () => 'm',
      generateStructured: () => Promise.reject(new Error('unused')),
      generateWithTools: () => Promise.resolve(whole),
    };
    const events: LlmStreamEvent[] = [];
    const result = await streamToolsWithFallback(plain, REQUEST, (e) =>
      events.push(e),
    );
    expect(result).toBe(whole);
    expect(events).toEqual([
      { type: 'text', delta: 'Bir daqiqa.' },
      { type: 'tool_call_started', name: 'search_catalog' },
    ]);
  });
});
