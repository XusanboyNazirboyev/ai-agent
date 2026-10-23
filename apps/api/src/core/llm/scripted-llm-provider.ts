import {
  LlmError,
  type LlmProvider,
  type LlmTier,
  type LlmUsage,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from './llm-provider.js';
import { estimateRequest } from './metered-llm.js';

/**
 * Deterministic, offline provider for tests, CI evals and local `mock` mode.
 * It never makes network calls and is never billed. Usage is derived from
 * request/response sizes so budget enforcement can be exercised.
 */

export type ScriptStep =
  | {
      readonly kind: 'structured';
      readonly value?: unknown;
      readonly failure?: 'refusal' | 'truncated' | 'malformed';
    }
  | {
      readonly kind: 'tools';
      readonly text?: string;
      readonly toolCalls?: ReadonlyArray<{
        readonly name: string;
        readonly input: unknown;
      }>;
      readonly stop?: 'refusal' | 'max_tokens';
    }
  | { readonly kind: 'error'; readonly error: LlmError };

export type ScriptRequest =
  | {
      readonly type: 'structured';
      readonly request: StructuredGenerationRequest<unknown>;
    }
  | { readonly type: 'tools'; readonly request: ToolGenerationRequest };

export const MOCK_MODEL = 'mock-deterministic';

/**
 * Local mock mode: schema-valid "nothing extracted" answers and empty
 * drafts, so the agent runs end to end on deterministic slot detection and
 * code-rendered fallback replies. It does not pretend to understand text.
 */
export function neutralResponder(call: ScriptRequest): ScriptStep {
  if (call.type === 'tools') return { kind: 'tools', text: '' };
  const slotsSchema = (
    call.request.jsonSchema.properties as
      Record<string, { required?: string[] }> | undefined
  )?.slots;
  const slots = Object.fromEntries(
    (slotsSchema?.required ?? []).map((key) => [key, null]),
  );
  return {
    kind: 'structured',
    value: { language: 'other', script: 'other', intent: 'other', slots },
  };
}

export class ScriptedLlmProvider implements LlmProvider {
  readonly providerId = 'mock';
  readonly calls: ScriptRequest[] = [];
  private readonly queue: ScriptStep[];
  private sequence = 0;

  constructor(
    script: readonly ScriptStep[] | ((call: ScriptRequest) => ScriptStep),
    private readonly model: string = MOCK_MODEL,
  ) {
    this.queue = Array.isArray(script) ? [...script] : [];
    if (!Array.isArray(script))
      this.responder = script as (call: ScriptRequest) => ScriptStep;
  }

  private responder: ((call: ScriptRequest) => ScriptStep) | undefined;

  modelFor(_tier: LlmTier): string {
    return this.model;
  }

  private next(call: ScriptRequest): ScriptStep {
    this.calls.push(call);
    if (this.responder) return this.responder(call);
    const step = this.queue.shift();
    if (!step) throw new LlmError('LLM_UNAVAILABLE', 'Script exhausted', false);
    return step;
  }

  private usage(
    request: Parameters<typeof estimateRequest>[0],
    output: string,
    max: number,
  ): LlmUsage {
    return {
      inputTokens: Math.ceil(estimateRequest(request).bytes / 4),
      outputTokens: Math.min(
        max,
        Math.ceil(Buffer.byteLength(output, 'utf8') / 4) + 1,
      ),
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    };
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const step = this.next({
      type: 'structured',
      request: request as StructuredGenerationRequest<unknown>,
    });
    if (step.kind === 'error') throw step.error;
    if (step.kind !== 'structured')
      throw new Error(`Script expected structured, got ${step.kind}`);
    const output = JSON.stringify(step.value ?? {});
    const base = {
      providerId: this.providerId,
      model: this.model,
      responseId: `mock-${++this.sequence}`,
      usage: this.usage(request, output, request.maxOutputTokens),
      durationMs: 0,
      attempts: 1,
    };
    if (step.failure === 'refusal')
      return {
        ...base,
        stopReason: 'refusal',
        value: undefined,
        failure: 'refusal',
      };
    if (step.failure === 'truncated') {
      return {
        ...base,
        stopReason: 'max_tokens',
        value: undefined,
        failure: 'truncated',
      };
    }
    const parsed = request.schema.safeParse(step.value);
    if (step.failure === 'malformed' || !parsed.success) {
      return {
        ...base,
        stopReason: 'end',
        value: undefined,
        failure: 'malformed',
      };
    }
    return { ...base, stopReason: 'end', value: parsed.data };
  }

  async generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    const step = this.next({ type: 'tools', request });
    if (step.kind === 'error') throw step.error;
    if (step.kind !== 'tools')
      throw new Error(`Script expected tools, got ${step.kind}`);
    const toolCalls = (step.toolCalls ?? []).map((call, index) => ({
      id: `mock-call-${this.sequence + 1}-${index}`,
      name: call.name,
      input: call.input,
    }));
    const text = step.text ?? '';
    return {
      providerId: this.providerId,
      model: this.model,
      responseId: `mock-${++this.sequence}`,
      usage: this.usage(
        request,
        text + JSON.stringify(toolCalls),
        request.maxOutputTokens,
      ),
      stopReason:
        step.stop === 'refusal'
          ? 'refusal'
          : step.stop === 'max_tokens'
            ? 'max_tokens'
            : toolCalls.length > 0
              ? 'tool_calls'
              : 'end',
      durationMs: 0,
      attempts: 1,
      text,
      toolCalls,
      providerContent: undefined,
    };
  }
}
