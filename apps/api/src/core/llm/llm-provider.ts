import type { z } from 'zod';

/**
 * Provider-agnostic LLM contract (D15). The agent core depends only on these
 * types; vendor SDK types stay inside adapters under `src/llm/<vendor>/`.
 * Replacing the provider means writing another adapter, not changing core.
 */

export type LlmTier = 'FAST' | 'STRONG';

/** Why a model call was made; recorded for cost attribution. */
export type LlmPurpose = 'extract' | 'respond' | 'evaluate';

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
}

export type LlmErrorCode =
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_AUTHENTICATION'
  | 'LLM_INVALID_REQUEST'
  | 'LLM_CANCELLED'
  | 'LLM_NOT_CONFIGURED';

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
