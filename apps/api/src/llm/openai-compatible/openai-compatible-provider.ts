import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmStreamListener,
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

/** What a model can do, from the provider preset / smoke test. */
export interface CapabilityView {
  readonly tools: 'yes' | 'no' | 'unknown';
  readonly structured: 'json_schema' | 'json_object' | 'none' | 'unknown';
}
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

export interface OpenAiCompatibleOptions {
  /** e.g. https://generativelanguage.googleapis.com/v1beta/openai */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`; optional for local servers. */
  readonly apiKey?: string;
  readonly models: Readonly<Record<LlmTier, string>>;
  /** Mode used when the capability table says `unknown`. */
  readonly structuredOutput: StructuredOutputMode;
  /**
   * Per-model capability lookup. `no`/`none` fail fast with
   * LLM_UNSUPPORTED_FEATURE before any request is sent; `unknown` tries.
   */
  readonly capabilityOf?: (model: string) => CapabilityView;
  readonly maxTokensParam: MaxTokensParam;
  /** Sent as `reasoning_effort` when set (e.g. Gemini's thinking level). */
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Overrides `reasoningEffort` for one tier (LLM_FAST_REASONING_EFFORT:
   * extraction only). Unset tiers keep `reasoningEffort`.
   */
  readonly reasoningEffortByTier?: Partial<
    Record<LlmTier, 'minimal' | 'low' | 'medium' | 'high'>
  >;
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
  // Vendor data attached to a tool call that must be echoed back unchanged
  // (Gemini 3: `extra_content.google.thought_signature`; without it the next
  // request is refused with HTTP 400).
  extra_content: z.record(z.string(), z.unknown()).optional(),
  function: z.object({
    name: z.string(),
    arguments: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
  }),
});

/**
 * Message content: a string, or (reasoning models, e.g. Mistral
 * `mistral-large-4`, observed 2026-11-09) an array of chunks such as
 * `{type: 'thinking', thinking, closed}` and `{type: 'text', text}`. Only text
 * chunks are the reply; thinking is never returned or shown.
 */
const ContentSchema = z.union([
  z.string(),
  z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
]);

function textOf(
  content: z.infer<typeof ContentSchema> | null | undefined,
): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

const ResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: ContentSchema.nullable().optional(),
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

/**
 * One `chat.completion.chunk` of a streamed response (OpenAI chat streaming
 * reference, read 2026-11-09). Lenient: vendors omit fields freely; the
 * Gemini OpenAI-compatibility page (read 2026-11-09) documents streaming and
 * `stream_options.include_usage` but not streamed tool calls, so tool-call
 * deltas are accepted whole or in pieces.
 */
const ChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        delta: z
          .object({
            content: ContentSchema.nullable().optional(),
            refusal: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).optional(),
                  id: z.string().optional(),
                  type: z.string().optional(),
                  extra_content: z.record(z.string(), z.unknown()).optional(),
                  function: z
                    .object({
                      name: z.string().optional(),
                      arguments: z
                        .union([z.string(), z.record(z.string(), z.unknown())])
                        .optional(),
                    })
                    .optional(),
                }),
              )
              .nullable()
              .optional(),
          })
          .optional(),
      }),
    )
    .nullable()
    .optional(),
  usage: ResponseSchema.shape.usage,
});

interface StreamedToolCall {
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
  extra_content?: Record<string, unknown>;
}

function interrupted(message: string): LlmError {
  return new LlmError('LLM_STREAM_INTERRUPTED', message, false);
}

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

/** Maps an HTTP error response to the provider-neutral error contract. */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfter: string | null,
  now: Date = new Date(),
): LlmError {
  // Google wraps the error object in an array on some endpoints.
  const parsed = ErrorBodySchema.safeParse(
    Array.isArray(body) ? body[0] : body,
  );
  const error = parsed.success ? parsed.data.error : undefined;
  const label = describe(status, body);
  const wait = parseRetryAfterMs(retryAfter, now);
  if (
    status === 401 ||
    status === 403 ||
    // Gemini (OpenAI-compatible endpoint, observed 2026-11-09) answers an
    // invalid key with 400 INVALID_ARGUMENT "API key not valid" and no
    // structured reason. It is a credential failure, so the router may fail
    // over (ADR 012); any other 400 stays an invalid request.
    (status === 400 &&
      error?.status === 'INVALID_ARGUMENT' &&
      /\bAPI key\b/u.test(error.message ?? ''))
  ) {
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
  if (status === 404) {
    // Unknown model / no access (e.g. Groq `model_not_found`): not a payload
    // defect, and no response was billed; the router may fail over.
    return new LlmError(
      'LLM_UNSUPPORTED_FEATURE',
      `Model or endpoint not available to this account (${label})`,
      false,
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
  // An unknown 400 is an invalid payload, never "unsupported feature":
  // unsupported features come from the capability table (checked before
  // sending), not from guessing at error message text.
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
        extra_content?: Record<string, unknown>;
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** The extra_content this provider attached to an earlier assistant message, by tool call id. */
function extraContentOf(
  providerContent: unknown,
): Record<string, Record<string, unknown>> {
  if (
    providerContent &&
    typeof providerContent === 'object' &&
    'openAiCompatibleExtraContent' in providerContent
  )
    return (
      (
        providerContent as {
          openAiCompatibleExtraContent: Record<string, Record<string, unknown>>;
        }
      ).openAiCompatibleExtraContent ?? {}
    );
  return {};
}

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
                  ...(extraContentOf(message.providerContent)[call.id]
                    ? {
                        extra_content: extraContentOf(message.providerContent)[
                          call.id
                        ],
                      }
                    : {}),
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

  /**
   * Opaque data the core hands back with the assistant message so the next
   * request can repeat it (see `extra_content` above). Keyed by tool call id.
   */
  private echoed(
    raw:
      | ReadonlyArray<{ extra_content?: Record<string, unknown> }>
      | null
      | undefined,
    calls: readonly LlmToolCall[],
  ): unknown {
    const extras: Record<string, Record<string, unknown>> = {};
    (raw ?? []).forEach((call, index) => {
      if (call.extra_content && calls[index])
        extras[calls[index].id] = call.extra_content;
    });
    return Object.keys(extras).length > 0
      ? { openAiCompatibleExtraContent: extras }
      : undefined;
  }

  /** One HTTP exchange with bounded retries of transient failures only. */
  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ data: ChatResponse; durationMs: number; attempts: number }> {
    const started = Date.now();
    const { value, attempts } = await this.retrying(
      () => this.exchange(body, signal),
      signal,
    );
    return { data: value, durationMs: Date.now() - started, attempts };
  }

  /** Runs `once` with bounded retries of transient failures only. */
  private async retrying<T>(
    once: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<{ value: T; attempts: number }> {
    for (let attempt = 1; ; attempt++) {
      let error: LlmError;
      try {
        return { value: await once(), attempts: attempt };
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
    const { response } = await this.send(body, signal);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
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

  /**
   * Sends the request; resolves with a 2xx response whose body is unread,
   * or throws the mapped error. The timeout covers reading the body too.
   */
  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; timeout: AbortSignal }> {
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
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw errorFromResponse(
        response.status,
        payload,
        response.headers.get('retry-after'),
      );
    }
    return { response, timeout };
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

  /** The output ceiling, plus the reasoning effort when one is configured. */
  private outputCeiling(
    maxOutputTokens: number,
    tier: LlmTier,
  ): Record<string, number | string> {
    const effort =
      this.options.reasoningEffortByTier?.[tier] ??
      this.options.reasoningEffort;
    return {
      [this.options.maxTokensParam]: maxOutputTokens,
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const model = this.modelFor(request.tier);
    const capability = this.options.capabilityOf?.(model);
    if (capability?.structured === 'none') {
      throw new LlmError(
        'LLM_UNSUPPORTED_FEATURE',
        `Model ${model} does not support structured output`,
        false,
      );
    }
    const mode: StructuredOutputMode =
      capability?.structured === 'json_schema' ||
      capability?.structured === 'json_object'
        ? capability.structured
        : this.options.structuredOutput;
    const jsonObject = mode === 'json_object';
    const system = jsonObject
      ? `${request.system}\n\nRespond with only a JSON object that matches this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
      : request.system;
    const { data, durationMs, attempts } = await this.post(
      {
        model,
        messages: this.wireMessages(system, request.messages),
        ...this.outputCeiling(request.maxOutputTokens, request.tier),
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
    const text = textOf(choice.message.content);
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

  /** Model and request body of a tool-calling generation. */
  private toolRequest(request: ToolGenerationRequest): {
    model: string;
    body: Record<string, unknown>;
  } {
    const model = this.modelFor(request.tier);
    if (
      request.tools.length > 0 &&
      this.options.capabilityOf?.(model).tools === 'no'
    ) {
      throw new LlmError(
        'LLM_UNSUPPORTED_FEATURE',
        `Model ${model} does not support tool calling`,
        false,
      );
    }
    return {
      model,
      body: {
        model,
        messages: this.wireMessages(request.system, request.messages),
        ...this.outputCeiling(request.maxOutputTokens, request.tier),
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
    };
  }

  async generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    const { model, body } = this.toolRequest(request);
    const { data, durationMs, attempts } = await this.post(
      body,
      request.signal,
    );
    return this.toolResult(data, model, request, durationMs, attempts);
  }

  /**
   * Streams a tool-calling generation over SSE. Connection and HTTP errors
   * before the body starts are retried like a plain call; any failure while
   * reading the body is LLM_STREAM_INTERRUPTED (not retried: output may
   * already be in use, and the attempt may be billed).
   */
  async streamWithTools(
    request: ToolGenerationRequest,
    onEvent: LlmStreamListener,
  ): Promise<ToolGenerationResult> {
    const { model, body } = this.toolRequest(request);
    const started = Date.now();
    const {
      value: { response, timeout },
      attempts,
    } = await this.retrying(
      () =>
        this.send(
          { ...body, stream: true, stream_options: { include_usage: true } },
          request.signal,
        ),
      request.signal,
    );
    const data = await this.readStream(response, onEvent).catch(
      (error: unknown) => {
        if (request.signal?.aborted)
          throw new LlmError('LLM_CANCELLED', 'Request cancelled', false);
        if (error instanceof LlmError) throw error;
        throw interrupted(
          timeout.aborted
            ? 'Provider stream timed out'
            : 'Provider stream broke off',
        );
      },
    );
    return this.toolResult(
      data,
      model,
      request,
      Date.now() - started,
      attempts,
    );
  }

  /** Reads the SSE body into the shape of a whole (non-streamed) response. */
  private async readStream(
    response: Response,
    onEvent: LlmStreamListener,
  ): Promise<ChatResponse> {
    if (!response.body) throw interrupted('Provider stream has no body');
    let id: string | undefined;
    let model: string | undefined;
    let usage: ChatResponse['usage'];
    let finish: string | null | undefined;
    let text = '';
    let refusal = '';
    const calls: StreamedToolCall[] = [];

    const apply = (raw: string): boolean => {
      if (raw === '[DONE]') return true;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw interrupted('Provider sent a malformed stream chunk');
      }
      const parsed = ChunkSchema.safeParse(json);
      if (!parsed.success)
        throw interrupted('Provider sent a malformed stream chunk');
      const chunk = parsed.data;
      if (chunk.error !== undefined)
        throw interrupted('Provider reported an error inside the stream');
      id ??= chunk.id;
      model ??= chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return false;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      const piece = textOf(delta?.content);
      if (piece) {
        text += piece;
        onEvent({ type: 'text', delta: piece });
      }
      if (delta?.refusal) refusal += delta.refusal;
      for (const part of delta?.tool_calls ?? []) {
        const index = part.index ?? calls.length;
        let call = calls[index];
        if (!call) {
          call = { name: '', arguments: '' };
          calls[index] = call;
        }
        if (part.id) call.id = part.id;
        if (part.extra_content)
          call.extra_content = { ...call.extra_content, ...part.extra_content };
        const name = part.function?.name;
        if (name && !call.name) {
          call.name = name;
          onEvent({ type: 'tool_call_started', name });
        }
        const args = part.function?.arguments;
        if (typeof args === 'string' && typeof call.arguments === 'string')
          call.arguments += args;
        else if (args !== undefined && typeof args !== 'string')
          call.arguments = args;
      }
      return false;
    };

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    const reader = response.body.getReader();
    try {
      while (!done) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while (!done && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/u, '');
          buffer = buffer.slice(newline + 1);
          if (line.startsWith('data:')) done = apply(line.slice(5).trim());
        }
      }
      const rest = buffer.trim();
      if (!done && rest.startsWith('data:')) apply(rest.slice(5).trim());
    } finally {
      if (done) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    return {
      id,
      model,
      usage,
      choices: [
        {
          finish_reason: finish,
          message: {
            content: text,
            refusal: refusal || undefined,
            tool_calls: calls
              .filter((call) => call.name)
              .map((call) => ({
                id: call.id,
                type: 'function',
                ...(call.extra_content
                  ? { extra_content: call.extra_content }
                  : {}),
                function: { name: call.name, arguments: call.arguments },
              })),
          },
        },
      ],
    };
  }

  private toolResult(
    data: ChatResponse,
    model: string,
    request: ToolGenerationRequest,
    durationMs: number,
    attempts: number,
  ): ToolGenerationResult {
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
    const text = textOf(choice.message.content);
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
      providerContent: this.echoed(choice.message.tool_calls, toolCalls),
    };
  }
}
