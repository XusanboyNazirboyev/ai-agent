import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LlmError } from '../../core/llm/llm-provider.js';
import {
  AnthropicLlmProvider,
  toLlmError,
  type AnthropicMessagesClient,
} from './anthropic-llm-provider.js';

function message(overrides: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      output_tokens_details: { thinking_tokens: 12 },
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    } as unknown as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

function provider(
  create: AnthropicMessagesClient['messages']['create'],
  maxRetries = 2,
): {
  client: {
    messages: {
      create: ReturnType<
        typeof vi.fn<AnthropicMessagesClient['messages']['create']>
      >;
    };
  };
  llm: AnthropicLlmProvider;
} {
  const client = { messages: { create: vi.fn(create) } };
  return {
    client,
    llm: new AnthropicLlmProvider({
      client,
      models: { FAST: 'claude-haiku-5-5', STRONG: 'claude-haiku-5-5' },
      effort: 'low',
      requestTimeoutMs: 5_000,
      maxRetries,
      sleep: async (): Promise<void> => undefined,
    }),
  };
}

const structured = {
  tier: 'FAST' as const,
  purpose: 'extract' as const,
  system: 'policy',
  messages: [{ role: 'user' as const, text: 'customer text' }],
  schemaName: 'x',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string' } },
    required: ['a'],
  },
  schema: z.object({ a: z.string() }).strict(),
  maxOutputTokens: 600,
};

describe('AnthropicLlmProvider structured output', () => {
  it('sends a JSON-schema output format and validates the result', async () => {
    const { llm, client } = provider(async () =>
      message({
        content: [
          {
            type: 'text',
            text: '{"a":"x"}',
            citations: null,
          } as Anthropic.TextBlock,
        ],
      }),
    );
    const result = await llm.generateStructured(structured);
    expect(result).toMatchObject({
      value: { a: 'x' },
      responseId: 'msg_test',
      model: 'claude-haiku-5-5',
      attempts: 1,
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        reasoningTokens: 12,
        cacheReadTokens: 0,
      },
    });
    const [params, options] = client.messages.create.mock.calls[0];
    expect(params).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 600,
      system: 'policy',
      messages: [{ role: 'user', content: 'customer text' }],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: structured.jsonSchema },
      },
    });
    expect(params).not.toHaveProperty('temperature');
    expect(options).toMatchObject({ timeout: 5_000, maxRetries: 0 });
  });

  it.each([
    [{ stop_reason: 'refusal' as const }, 'refusal'],
    [{ stop_reason: 'max_tokens' as const }, 'truncated'],
    [
      {
        content: [
          {
            type: 'text',
            text: 'not json',
            citations: null,
          } as Anthropic.TextBlock,
        ],
      },
      'malformed',
    ],
    [
      {
        content: [
          {
            type: 'text',
            text: '{"a":1}',
            citations: null,
          } as Anthropic.TextBlock,
        ],
      },
      'malformed',
    ],
  ])('reports %o as %s without a value', async (overrides, failure) => {
    const { llm } = provider(async () => message(overrides));
    await expect(llm.generateStructured(structured)).resolves.toMatchObject({
      value: undefined,
      failure,
    });
  });

  it('separates cache writes by TTL for accurate pricing', async () => {
    const { llm } = provider(async () =>
      message({
        content: [
          {
            type: 'text',
            text: '{"a":"x"}',
            citations: null,
          } as Anthropic.TextBlock,
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 200,
          cache_creation: {
            ephemeral_5m_input_tokens: 150,
            ephemeral_1h_input_tokens: 50,
          },
        } as unknown as Anthropic.Usage,
      }),
    );
    await expect(llm.generateStructured(structured)).resolves.toMatchObject({
      usage: {
        cacheReadTokens: 300,
        cacheWrite5mTokens: 150,
        cacheWrite1hTokens: 50,
      },
    });
  });
});

describe('AnthropicLlmProvider tools', () => {
  it('sends strict tools with auto choice and returns tool calls plus replayable content', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'list_offers',
        input: { itemId: 'i1' },
      },
    ] as unknown as Anthropic.ContentBlock[];
    const { llm, client } = provider(async () =>
      message({ content, stop_reason: 'tool_use' }),
    );
    const result = await llm.generateWithTools({
      tier: 'STRONG',
      purpose: 'respond',
      system: 'policy',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [
        {
          name: 'list_offers',
          description: 'd',
          inputSchema: { type: 'object', additionalProperties: false },
        },
      ],
      maxOutputTokens: 900,
      singleToolCall: true,
    });
    expect(result).toMatchObject({
      stopReason: 'tool_calls',
      toolCalls: [
        { id: 'toolu_1', name: 'list_offers', input: { itemId: 'i1' } },
      ],
      providerContent: content,
    });
    expect(client.messages.create.mock.calls[0][0]).toMatchObject({
      tools: [{ name: 'list_offers', strict: true }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });

    // The next round replays the assistant content unchanged (thinking blocks).
    await llm.generateWithTools({
      tier: 'STRONG',
      purpose: 'respond',
      system: 'policy',
      messages: [
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: '',
          toolCalls: result.toolCalls,
          providerContent: result.providerContent,
        },
        {
          role: 'tool_results',
          results: [{ toolCallId: 'toolu_1', content: '{}', isError: true }],
        },
      ],
      tools: [],
      maxOutputTokens: 900,
    });
    const replay = client.messages.create.mock.calls[1][0];
    expect(replay.messages[1]).toEqual({ role: 'assistant', content });
    expect(replay.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '{}',
          is_error: true,
        },
      ],
    });
    expect(replay).not.toHaveProperty('tools');
  });
});

describe('AnthropicLlmProvider errors and retries', () => {
  const rateLimit = (): InstanceType<typeof Anthropic.RateLimitError> =>
    new Anthropic.RateLimitError(
      429,
      { type: 'error' },
      'rate limited',
      new Headers({ 'retry-after': '2' }),
    );

  it('retries rate limits and overload with an accurate attempt count', async () => {
    let calls = 0;
    const { llm } = provider(async () => {
      calls += 1;
      if (calls === 1) throw rateLimit();
      if (calls === 2)
        throw new Anthropic.InternalServerError(
          529,
          { type: 'error' },
          'overloaded',
          new Headers(),
        );
      return message({
        content: [
          {
            type: 'text',
            text: '{"a":"x"}',
            citations: null,
          } as Anthropic.TextBlock,
        ],
      });
    });
    await expect(llm.generateStructured(structured)).resolves.toMatchObject({
      attempts: 3,
    });
  });

  it('stops after the retry limit and does not retry permanent errors', async () => {
    const limited = provider(async () => {
      throw rateLimit();
    }, 1);
    await expect(
      limited.llm.generateStructured(structured),
    ).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
      retryAfterMs: 2_000,
    });
    expect(limited.client.messages.create).toHaveBeenCalledTimes(2);

    const bad = provider(async () => {
      throw new Anthropic.BadRequestError(
        400,
        { type: 'error' },
        'bad',
        new Headers(),
      );
    });
    await expect(bad.llm.generateStructured(structured)).rejects.toMatchObject({
      code: 'LLM_INVALID_REQUEST',
    });
    expect(bad.client.messages.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new Anthropic.APIUserAbortError(), 'LLM_CANCELLED', false],
    [new Anthropic.APIConnectionTimeoutError(), 'LLM_TIMEOUT', true],
    [
      new Anthropic.APIConnectionError({ message: 'reset' }),
      'LLM_UNAVAILABLE',
      true,
    ],
    [
      new Anthropic.AuthenticationError(
        401,
        { type: 'error' },
        'no',
        new Headers(),
      ),
      'LLM_AUTHENTICATION',
      false,
    ],
    [new Error('weird'), 'LLM_UNAVAILABLE', false],
  ])('maps %s', (error, code, retryable) => {
    const mapped = toLlmError(error);
    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ code, retryable });
  });
});
