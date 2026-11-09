import type { z } from 'zod';

/**
 * Provider-agnostic LLM contract (D15). The agent core depends only on these
 * types; vendor SDK types stay inside adapters under `src/llm/<vendor>/`.
 * Replacing the provider means writing another adapter, not changing core.
 */

export type LlmTier = 'FAST' | 'STRONG';

/** Why a model call was made; recorded for cost attribution. */
export type LlmPurpose =
  | 'extract'
  | 'respond'
  | 'evaluate'
  | 'embed'
  /** Speech-to-text of a voice note (metered on the same ledger, REV-03). */
  | 'transcribe'
  /** Text-to-speech of a voice-call reply (ADR 045, same ledger). */
  | 'speak';

export type LlmStopReason =
  'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  /** Reasoning tokens when reported (already included in outputTokens). */
  readonly reasoningTokens?: number;
  /**
   * True when the provider reported no usage and the adapter estimated the
   * counts from request/response sizes; such records are flagged.
   */
  readonly estimated?: boolean;
}

export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema with `additionalProperties: false` on every object. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  /** Untrusted model output: validate before use. */
  readonly input: unknown;
}

export interface LlmToolResult {
  readonly toolCallId: string;
  /** Serialized result shown to the model (untrusted data, not instructions). */
  readonly content: string;
  readonly isError: boolean;
}

export type LlmMessage =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly LlmToolCall[];
      /**
       * Provider-native assistant content (e.g. thinking blocks) that must be
       * replayed unchanged on the next request. Opaque to the core.
       */
      readonly providerContent?: unknown;
    }
  | {
      readonly role: 'tool_results';
      readonly results: readonly LlmToolResult[];
    };

interface LlmRequestBase {
  readonly tier: LlmTier;
  readonly purpose: LlmPurpose;
  /** Trusted operator instructions. Customer text never goes here. */
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  /** Hard output ceiling for the call (includes any reasoning tokens). */
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
  /**
   * Set by MeteredLlm so a router can keep billing honest across candidates
   * (absent for unmetered use).
   */
  readonly ambiguity?: AmbiguityHooks;
}

/** A failed attempt whose billing is unknowable (e.g. a timeout). */
export interface AmbiguousAttempt {
  readonly providerId: string;
  readonly model: string;
  readonly code: LlmErrorCode;
}

/**
 * A timeout may have been billed. A router reports each timed-out attempt
 * and must obtain a fresh reservation before starting another one.
 */
export interface AmbiguityHooks {
  onTimeout(attempt: AmbiguousAttempt): Promise<void>;
  /** False when budget does not allow another billable attempt. */
  reserveNextAttempt(): Promise<boolean>;
}

export interface StructuredGenerationRequest<T> extends LlmRequestBase {
  readonly schemaName: string;
  /** JSON Schema sent to the provider for constrained decoding. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /** Authoritative validator applied to whatever the provider returns. */
  readonly schema: z.ZodType<T>;
}

export interface ToolGenerationRequest extends LlmRequestBase {
  readonly tools: readonly LlmToolDefinition[];
  /** At most one tool call per response (simpler budgeting and auditing). */
  readonly singleToolCall?: boolean;
}

interface LlmResultBase {
  readonly providerId: string;
  readonly model: string;
  /** Provider response id: idempotency key for usage accounting. */
  readonly responseId: string;
  readonly usage: LlmUsage;
  readonly stopReason: LlmStopReason;
  readonly durationMs: number;
  readonly attempts: number;
}

export interface StructuredGenerationResult<T> extends LlmResultBase {
  /** Undefined when output was refused, truncated or failed validation. */
  readonly value: T | undefined;
  readonly failure?: 'refusal' | 'truncated' | 'malformed';
}

export interface ToolGenerationResult extends LlmResultBase {
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly providerContent: unknown;
}

/**
 * Streamed output of a tool-calling generation (ADR 045 amendment to D15):
 * text as it is generated, and a signal when the model starts a tool call
 * (a voice turn speaks its "one moment" filler then). Untrusted model output.
 */
export type LlmStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'tool_call_started'; readonly name: string };

export type LlmStreamListener = (event: LlmStreamEvent) => void;

export interface LlmProvider {
  readonly providerId: string;
  /** Model id serving a tier (for pricing and budgeting before a call). */
  modelFor(tier: LlmTier): string;
  generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>>;
  generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult>;
  /**
   * Optional: the same generation, streamed. Events arrive while the call
   * runs; the promise resolves with the whole result (usage included) once
   * the stream ends. A failure after any event is `LLM_STREAM_INTERRUPTED`:
   * output already left, so it is never retried or failed over. Callers use
   * `streamToolsWithFallback` so providers without it still work.
   */
  streamWithTools?(
    request: ToolGenerationRequest,
    onEvent: LlmStreamListener,
  ): Promise<ToolGenerationResult>;
}

/**
 * Streams when the provider can; otherwise generates the whole reply and
 * replays it as events (text first, then tool calls, the order a stream
 * would show them).
 */
export async function streamToolsWithFallback(
  provider: LlmProvider,
  request: ToolGenerationRequest,
  onEvent: LlmStreamListener,
): Promise<ToolGenerationResult> {
  if (provider.streamWithTools)
    return provider.streamWithTools(request, onEvent);
  const result = await provider.generateWithTools(request);
  if (result.text) onEvent({ type: 'text', delta: result.text });
  for (const call of result.toolCalls)
    onEvent({ type: 'tool_call_started', name: call.name });
  return result;
}

export type LlmErrorCode =
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_AUTHENTICATION'
  | 'LLM_INVALID_REQUEST'
  | 'LLM_CANCELLED'
  | 'LLM_NOT_CONFIGURED'
  /** Billing or daily quota exhausted: retrying does not help. */
  | 'LLM_QUOTA_EXHAUSTED'
  /** The endpoint or model lacks a required feature (e.g. tool calling). */
  | 'LLM_UNSUPPORTED_FEATURE'
  /**
   * A streamed response failed after it started: output may already have
   * been used and billed, so it is neither retried nor failed over.
   */
  | 'LLM_STREAM_INTERRUPTED';

/** Provider failure with no billable response (nothing to account for). */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}
