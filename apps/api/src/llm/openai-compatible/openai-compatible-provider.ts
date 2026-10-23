import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
import { estimateRequest } from '../../core/llm/metered-llm.js';
import {
  backoffDelayMs,
  MAX_RETRY_DELAY_MS,
  parseRetryAfterMs,
} from '../retry.js';

/**
 * Generic adapter for OpenAI-compatible Chat Completions endpoints
 * (`POST {baseUrl}/chat/completions`): e.g. Gemini's compatibility layer or
 * a local Ollama server. Wire format per the OpenAI Chat Completions
 * reference; endpoint specifics are documented in
 * docs/LLM_PROVIDER_EVALUATION.md (checked 2026-10-23).
 *
 * Deliberate choices for portability:
 * - `tool_choice` is never sent: "auto" is the documented default when
 *   tools are present, and Ollama lists `tool_choice` as unsupported.
 * - `parallel_tool_calls: false` is sent only when a request asks for a
 *   single tool call (the agent core does not).
 * - The output ceiling parameter name is configurable: OpenAI deprecates
 *   `max_tokens` in favor of `max_completion_tokens`; Ollama documents
 *   `max_tokens`.
 * - Structured output uses `response_format: json_schema` or, for servers
 *   that only have JSON mode, `json_object` with the schema in the system
 *   prompt. Either way zod validation of the result is authoritative.
 * - Missing usage is estimated from sizes and flagged `estimated`.
 * - Only transient failures (429 rate limit, 408, 5xx, timeouts, network)
 *   are retried, with backoff, jitter and Retry-After. Quota exhaustion,
 *   unauthorized, invalid payload and unsupported features are not.
 */

export type StructuredOutputMode = 'json_schema' | 'json_object';
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

export interface OpenAiCompatibleOptions {
  /** e.g. https://generativelanguage.googleapis.com/v1beta/openai */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`; optional for local servers. */
  readonly apiKey?: string;
  readonly models: Readonly<Record<LlmTier, string>>;
  readonly structuredOutput: StructuredOutputMode;
  readonly maxTokensParam: MaxTokensParam;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly providerId?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
  }),
});

const ResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().min(0).optional() })
        .nullable()
        .optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().int().min(0).optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
type ChatResponse = z.infer<typeof ResponseSchema>;

const ErrorBodySchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      type: z.string().nullable().optional(),
      code: z.union([z.string(), z.number()]).nullable().optional(),
      status: z.string().optional(),
    })
    .optional(),
});

/** Billing/quota error identifiers (OpenAI error-codes guide). */
const QUOTA_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted']);

function stopReasonOf(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return reason ? 'other' : 'end';
  }
}

/** Short, secret-free description of a provider error for messages. */
function describe(status: number, body: unknown): string {
  const parsed = ErrorBodySchema.safeParse(body);
  const code = parsed.success
    ? (parsed.data.error?.code ?? parsed.data.error?.status)
    : undefined;
  return code !== undefined && code !== null
    ? `HTTP ${status} (${String(code).slice(0, 60)})`
    : `HTTP ${status}`;
}

const UNSUPPORTED_HINT =
  /(tool|function|response_format|json_schema|structured)[^.]*\b(not supported|unsupported|does not support)|\b(not supported|unsupported|does not support)\b[^.]*(tool|function|response_format|json_schema|structured)/iu;

/** Maps an HTTP error response to the provider-neutral error contract. */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfter: string | null,
  now: Date = new Date(),
): LlmError {
  const parsed = ErrorBodySchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  const label = describe(status, body);
  const wait = parseRetryAfterMs(retryAfter, now);
  if (status === 401 || status === 403) {
    return new LlmError(
      'LLM_AUTHENTICATION',
      `Provider rejected credentials (${label})`,
      false,
    );
  }
  if (status === 429) {
    const code =
      error?.code !== undefined && error?.code !== null
        ? String(error.code)
        : '';
    if (QUOTA_CODES.has(code) || (error?.type ?? '') === 'insufficient_quota') {
      return new LlmError(
        'LLM_QUOTA_EXHAUSTED',
        `Provider quota exhausted (${label})`,
        false,
      );
    }
    return new LlmError(
      'LLM_RATE_LIMITED',
      `Provider rate limit (${label})`,
      true,
      wait,
    );
  }
  if (status === 408 || status >= 500) {
    return new LlmError(
      'LLM_UNAVAILABLE',
      `Provider error (${label})`,
      true,
      wait,
    );
  }
  if (UNSUPPORTED_HINT.test(error?.message ?? '')) {
    return new LlmError(
      'LLM_UNSUPPORTED_FEATURE',
      `Provider does not support a requested feature (${label})`,
      false,
    );
  }
  return new LlmError(
    'LLM_INVALID_REQUEST',
    `Provider rejected request (${label})`,
    false,
  );
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly providerId: string;
  private readonly endpoint: string;
  private readonly request: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.providerId = options.providerId ?? 'openai-compatible';
    this.endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    this.request = options.fetch ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  modelFor(tier: LlmTier): string {
    return this.options.models[tier];
  }

  private wireMessages(
    system: string,
    messages: readonly LlmMessage[],
  ): WireMessage[] {
    const wire: WireMessage[] = [{ role: 'system', content: system }];
    for (const message of messages) {
      if (message.role === 'user') {
        wire.push({ role: 'user', content: message.text });
      } else if (message.role === 'assistant') {
        wire.push({
          role: 'assistant',
          content: message.text || null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments:
                      typeof call.input === 'string'
                        ? call.input
                        : JSON.stringify(call.input ?? {}),
                  },
                })),
              }
            : {}),
        });
      } else {
        for (const result of message.results) {
          wire.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: result.content,
          });
        }
      }
    }
    return wire;
  }

  /** One HTTP exchange with bounded retries of transient failures only. */
  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ data: ChatResponse; durationMs: number; attempts: number }> {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      let error: LlmError;
      try {
        const data = await this.exchange(body, signal);
        return { data, durationMs: Date.now() - started, attempts: attempt };
      } catch (caught: unknown) {
        error =
          caught instanceof LlmError
            ? caught
            : new LlmError(
                'LLM_UNAVAILABLE',
                'Unexpected transport failure',
                false,
              );
      }
      if (
        !error.retryable ||
        attempt > this.options.maxRetries ||
        signal?.aborted
      ) {
        throw error;
      }
      // A Retry-After longer than our cap means the turn cannot wait it out.
      if (
        error.retryAfterMs !== undefined &&
        error.retryAfterMs > MAX_RETRY_DELAY_MS
      )
        throw error;
      await this.sleep(
        error.retryAfterMs ?? backoffDelayMs(attempt, this.random),
      );
    }
  }

  private async exchange(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ChatResponse> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch {
      if (signal?.aborted)
        throw new LlmError('LLM_CANCELLED', 'Request cancelled', false);
      if (timeout.aborted)
        throw new LlmError('LLM_TIMEOUT', 'Provider request timed out', true);
      throw new LlmError('LLM_UNAVAILABLE', 'Provider connection failed', true);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      throw errorFromResponse(
        response.status,
        payload,
        response.headers.get('retry-after'),
      );
    }
    const parsed = ResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new LlmError(
        'LLM_UNAVAILABLE',
        'Provider returned a malformed response',
        false,
      );
    }
    return parsed.data;
  }

  private usageOf(
    data: ChatResponse,
    request: Parameters<typeof estimateRequest>[0],
    output: string,
  ): LlmUsage {
    const usage = data.usage;
    if (!usage) {
      // Conservative estimate (UTF-8 bytes >= tokens for byte-level BPE).
      return {
        inputTokens: estimateRequest(request).tokens,
        outputTokens: Buffer.byteLength(output, 'utf8'),
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        estimated: true,
      };
    }
    const cached = Math.min(
      usage.prompt_tokens,
      usage.prompt_tokens_details?.cached_tokens ?? 0,
    );
    return {
      // Cached tokens are part of prompt_tokens in this format.
      inputTokens: usage.prompt_tokens - cached,
      outputTokens: usage.completion_tokens,
      cacheReadTokens: cached,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    };
  }

  private outputCeiling(maxOutputTokens: number): Record<string, number> {
    return { [this.options.maxTokensParam]: maxOutputTokens };
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const model = this.modelFor(request.tier);
    const jsonObject = this.options.structuredOutput === 'json_object';
    const system = jsonObject
      ? `${request.system}\n\nRespond with only a JSON object that matches this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
      : request.system;
    const { data, durationMs, attempts } = await this.post(
      {
        model,
        messages: this.wireMessages(system, request.messages),
        ...this.outputCeiling(request.maxOutputTokens),
        response_format: jsonObject
          ? { type: 'json_object' }
          : {
              type: 'json_schema',
              json_schema: {
                name: request.schemaName,
                schema: request.jsonSchema,
                strict: true,
              },
            },
      },
      request.signal,
    );
    const choice = data.choices[0];
    const text = choice.message.content ?? '';
    const base = {
      providerId: this.providerId,
      model: data.model ?? model,
      responseId: data.id ?? `local-${randomUUID()}`,
      usage: this.usageOf(data, request, text),
      stopReason: choice.message.refusal
        ? ('refusal' as const)
        : stopReasonOf(choice.finish_reason),
      durationMs,
      attempts,
    };
    if (base.stopReason === 'refusal')
      return { ...base, value: undefined, failure: 'refusal' };
    if (base.stopReason === 'max_tokens')
      return { ...base, value: undefined, failure: 'truncated' };
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
    const { data, durationMs, attempts } = await this.post(
      {
        model,
        messages: this.wireMessages(request.system, request.messages),
        ...this.outputCeiling(request.maxOutputTokens),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
              ...(request.singleToolCall ? { parallel_tool_calls: false } : {}),
            }
          : {}),
      },
      request.signal,
    );
    const choice = data.choices[0];
    const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map(
      (call) => {
        const raw = call.function.arguments ?? {};
        let input: unknown = raw;
        if (typeof raw === 'string') {
          try {
            input = JSON.parse(raw);
          } catch {
            // Malformed JSON stays a string: the core's strict input
            // validation rejects it (INVALID_ARGUMENTS) and tells the model.
            input = raw;
          }
        }
        return {
          id: call.id ?? `call-${randomUUID()}`,
          name: call.function.name,
          input,
        };
      },
    );
    const text = choice.message.content ?? '';
    const stopReason = choice.message.refusal
      ? 'refusal'
      : toolCalls.length > 0
        ? 'tool_calls'
        : stopReasonOf(choice.finish_reason);
    return {
      providerId: this.providerId,
      model: data.model ?? model,
      responseId: data.id ?? `local-${randomUUID()}`,
      usage: this.usageOf(
        data,
        request,
        text + JSON.stringify(choice.message.tool_calls ?? []),
      ),
      stopReason,
      durationMs,
      attempts,
      text,
      toolCalls,
      providerContent: undefined,
    };
  }
}
