import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmStopReason,
  type LlmTier,
  type LlmToolCall,
  type LlmUsage,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../../core/llm/llm-provider.js';

/** The slice of the SDK client this adapter uses (injectable for tests). */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  readonly client: AnthropicMessagesClient;
  readonly models: Readonly<Record<LlmTier, string>>;
  /** Thinking depth; `low` keeps reasoning tokens (billed as output) small. */
  readonly effort: 'low' | 'medium' | 'high';
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_DELAY_MS = 10_000;

function stopReasonOf(reason: Anthropic.StopReason | null): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function usageOf(message: Anthropic.Message): LlmUsage {
  const usage = message.usage;
  const split = usage.cache_creation;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: split
      ? split.ephemeral_5m_input_tokens
      : (usage.cache_creation_input_tokens ?? 0),
    cacheWrite1hTokens: split ? split.ephemeral_1h_input_tokens : 0,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens,
  };
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get('retry-after');
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  return Math.min(Number(value) * 1000, MAX_RETRY_DELAY_MS);
}

/** Maps SDK errors (no billable response) to the provider-neutral contract. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LlmError('LLM_CANCELLED', 'Request cancelled', false);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('LLM_TIMEOUT', 'Provider request timed out', true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('LLM_UNAVAILABLE', 'Provider connection failed', true);
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new LlmError(
      'LLM_AUTHENTICATION',
      'Provider rejected credentials',
      false,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError(
      'LLM_RATE_LIMITED',
      'Provider rate limit',
      true,
      retryAfterMs(error.headers),
    );
  }
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.UnprocessableEntityError
  ) {
    return new LlmError(
      'LLM_INVALID_REQUEST',
      `Provider rejected request (${error.status})`,
      false,
    );
  }
  if (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500) {
    return new LlmError(
      'LLM_UNAVAILABLE',
      `Provider error (${error.status})`,
      true,
      retryAfterMs(error.headers),
    );
  }
  return new LlmError('LLM_UNAVAILABLE', 'Unexpected provider failure', false);
}

/**
 * Claude adapter (Anthropic Messages API, official TypeScript SDK).
 *
 * - Structured output via `output_config.format` (JSON Schema) and then
 *   zod validation; refusal, truncation and malformed output are explicit.
 * - Tool calls via strict tool definitions and `tool_choice: auto` (current
 *   Claude models reject forced tool choice); the core executes tools.
 * - Assistant content (including thinking blocks) is replayed unchanged.
 * - SDK retries are disabled so this adapter's bounded retry is the only one
 *   and the attempt count is accurate. Failed requests are not billed.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly providerId = 'anthropic';
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.sleep =
      options.sleep ??
      ((ms): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)));
  }

  modelFor(tier: LlmTier): string {
    return this.options.models[tier];
  }

  private messages(messages: readonly LlmMessage[]): Anthropic.MessageParam[] {
    return messages.map((message): Anthropic.MessageParam => {
      if (message.role === 'user')
        return { role: 'user', content: message.text };
      if (message.role === 'tool_results') {
        return {
          role: 'user',
          content: message.results.map((result) => ({
            type: 'tool_result' as const,
            tool_use_id: result.toolCallId,
            content: result.content,
            is_error: result.isError,
          })),
        };
      }
      if (Array.isArray(message.providerContent)) {
        return {
          role: 'assistant',
          content: message.providerContent as Anthropic.ContentBlockParam[],
        };
      }
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      return { role: 'assistant', content };
    });
  }

  private async send(
    params: Anthropic.MessageCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
  ): Promise<{
    message: Anthropic.Message;
    durationMs: number;
    attempts: number;
  }> {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const message = await this.options.client.messages.create(params, {
          signal,
          timeout: this.options.requestTimeoutMs,
          maxRetries: 0,
        });
        return { message, durationMs: Date.now() - started, attempts: attempt };
      } catch (error: unknown) {
        const mapped = toLlmError(error);
        if (
          !mapped.retryable ||
          attempt > this.options.maxRetries ||
          signal?.aborted
        ) {
          throw mapped;
        }
        await this.sleep(
          mapped.retryAfterMs ??
            Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS),
        );
      }
    }
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const model = this.modelFor(request.tier);
    const { message, durationMs, attempts } = await this.send(
      {
        model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: this.messages(request.messages),
        output_config: {
          effort: this.options.effort,
          format: { type: 'json_schema', schema: { ...request.jsonSchema } },
        },
      },
      request.signal,
    );
    const base = {
      providerId: this.providerId,
      model: message.model ?? model,
      responseId: message.id,
      usage: usageOf(message),
      stopReason: stopReasonOf(message.stop_reason),
      durationMs,
      attempts,
    };
    if (base.stopReason === 'refusal')
      return { ...base, value: undefined, failure: 'refusal' };
    if (base.stopReason === 'max_tokens')
      return { ...base, value: undefined, failure: 'truncated' };
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...base, value: undefined, failure: 'malformed' };
    }
    const validated = request.schema.safeParse(parsed);
    return validated.success
      ? { ...base, value: validated.data }
      : { ...base, value: undefined, failure: 'malformed' };
  }

  async generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    const model = this.modelFor(request.tier);
    const { message, durationMs, attempts } = await this.send(
      {
        model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: this.messages(request.messages),
        output_config: { effort: this.options.effort },
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
                strict: true,
              })),
              tool_choice: {
                type: 'auto' as const,
                disable_parallel_tool_use: request.singleToolCall ?? false,
              },
            }
          : {}),
      },
      request.signal,
    );
    const toolCalls: LlmToolCall[] = message.content
      .filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      )
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));
    return {
      providerId: this.providerId,
      model: message.model ?? model,
      responseId: message.id,
      usage: usageOf(message),
      stopReason: stopReasonOf(message.stop_reason),
      durationMs,
      attempts,
      text: message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      toolCalls,
      providerContent: message.content,
    };
  }
}
