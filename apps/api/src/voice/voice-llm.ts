/**
 * The voice FAST model (ADR 045, owner decision 2026-11-09: a free provider
 * whose key is already configured; measured, `groq` `openai/gpt-oss-20b`
 * was the only one under the 400 ms first-text allowance). Configured, not
 * hard-coded:
 *
 *   VOICE_LLM_PRESET      provider preset id (default `groq`)
 *   VOICE_LLM_MODEL       model id (default: the preset's FAST model)
 *   VOICE_LLM_TIMEOUT_MS  whole-stream timeout (default 8000)
 *   VOICE_LLM_REASONING_EFFORT  minimal|low|medium|high; sent as
 *                         `reasoning_effort` when set (unset = provider default)
 *
 * The key is read from the variable the preset names (e.g. GROQ_API_KEY);
 * values are never logged. No retries: a voice turn cannot wait for one,
 * and the router or a handover covers a failure.
 */
import type { LlmProvider } from '../core/llm/llm-provider.js';
import {
  OpenAiCompatibleLlmProvider,
  type CapabilityView,
} from '../llm/openai-compatible/openai-compatible-provider.js';
import { capabilityFor, resolvePreset } from '../llm/provider-presets.js';

export const DEFAULT_VOICE_LLM_PRESET = 'groq';
const DEFAULT_TIMEOUT_MS = 8_000;

export interface VoiceLlmConfig {
  readonly presetId: string;
  readonly model: string;
  readonly reasoningEffort?: Effort;
}

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
type Effort = (typeof EFFORTS)[number];

export function createVoiceLlmProvider(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly fetch?: typeof fetch } = {},
): { provider: LlmProvider; config: VoiceLlmConfig } {
  const presetId = env.VOICE_LLM_PRESET || DEFAULT_VOICE_LLM_PRESET;
  const model = env.VOICE_LLM_MODEL || undefined;
  const resolved = resolvePreset(
    presetId,
    env,
    model ? { FAST: model, STRONG: model } : {},
  );
  const timeout = Number(env.VOICE_LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000)
    throw new Error('VOICE_LLM_TIMEOUT_MS must be an integer 1000-30000');
  const effort = env.VOICE_LLM_REASONING_EFFORT || undefined;
  if (effort !== undefined && !EFFORTS.some((e) => e === effort))
    throw new Error(
      'VOICE_LLM_REASONING_EFFORT must be minimal, low, medium or high',
    );
  const reasoningEffort = EFFORTS.find((e) => e === effort);
  const fast = resolved.models.FAST;
  const provider = new OpenAiCompatibleLlmProvider({
    providerId: `voice-${presetId}`,
    baseUrl: resolved.preset.baseUrl,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    models: { FAST: fast, STRONG: fast },
    structuredOutput: 'json_object',
    capabilityOf: (id): CapabilityView => capabilityFor(resolved.preset, id),
    maxTokensParam: resolved.preset.maxTokensParam,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    requestTimeoutMs: timeout,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    provider,
    config: {
      presetId,
      model: fast,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}
