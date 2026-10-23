import { z } from 'zod';

/**
 * Versioned, non-secret presets for OpenAI-compatible providers used by
 * AgentCore's production `LlmProvider` (never by the Claude Code assistant:
 * Anthropic does not support routing Claude Code to non-Claude models, see
 * docs/LLM_PROVIDER_EVALUATION.md §11). Keys are read from the env var NAMED
 * here; values never appear in config. Every provider is `trusted: false`.
 *
 * Fact status: `documented` = stated by the official page in `sourceUrl`;
 * `unverified` = not confirmed (never guessed, treated as "try, then learn");
 * `measured` = set from a dated smoke test (docs/LLM_PROVIDER_STATUS.md).
 */

const Status = z.enum(['documented', 'unverified', 'measured']);
const Tri = z.enum(['yes', 'no', 'unknown']);

const ModelCapabilitySchema = z
  .object({
    tools: Tri,
    /** Constrained `json_schema` output; `json_object` = JSON mode only. */
    structured: z.enum(['json_schema', 'json_object', 'none', 'unknown']),
    status: Status,
  })
  .strict();

const LimitsSchema = z
  .object({
    requestsPerMinute: z.number().int().positive().optional(),
    tokensPerMinute: z.number().int().positive().optional(),
    requestsPerDay: z.number().int().positive().optional(),
    tokensPerDay: z.number().int().positive().optional(),
    status: Status,
    note: z.string().max(300),
  })
  .strict();

export const ProviderPresetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    label: z.string(),
    /** Chat Completions protocol only; not an Anthropic Messages endpoint. */
    protocol: z.literal('openai-chat'),
    baseUrl: z.url(),
    /** Name of the environment variable holding the key (never the key). */
    apiKeyEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    apiKeyRequired: z.boolean(),
    maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']),
    /** Per-tier default model ids; absent = must be set by configuration. */
    defaultModels: z
      .object({ FAST: z.string().optional(), STRONG: z.string().optional() })
      .strict(),
    /** Capabilities by model id; `*` = default for unlisted models. */
    capabilities: z.record(z.string(), ModelCapabilitySchema),
    limits: LimitsSchema,
    free: z.boolean(),
    /** Free tiers may train on prompts unless stated otherwise. */
    dataUse: z.object({ status: Status, note: z.string().max(300) }).strict(),
    trusted: z.literal(false),
    /** The only supported target; Claude Code is deliberately not one. */
    integrationTarget: z.literal('agentcore-llm-provider'),
    asOf: z.iso.date(),
    sourceUrls: z.array(z.url()).min(1),
  })
  .strict();

export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

const UNKNOWN: ModelCapability = {
  tools: 'unknown',
  structured: 'unknown',
  status: 'unverified',
};

const groqStrict: ModelCapability = {
  tools: 'yes',
  structured: 'json_schema',
  status: 'documented',
};
const groqJsonOnly: ModelCapability = {
  tools: 'yes',
  structured: 'json_object',
  status: 'documented',
};

const RAW_PRESETS: unknown[] = [
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    apiKeyRequired: true,
    // Not stated on the OpenAI-compatibility page; Groq lists max_tokens
    // support only implicitly. Left as max_tokens (smoke test decides).
    maxTokensParam: 'max_tokens',
    defaultModels: {
      FAST: 'openai/gpt-oss-20b',
      STRONG: 'openai/gpt-oss-120b',
    },
    capabilities: {
      // Tool use + JSON mode for all listed models; strict json_schema only
      // for the four below (console.groq.com/docs/structured-outputs).
      'openai/gpt-oss-20b': groqStrict,
      'openai/gpt-oss-120b': groqStrict,
      'qwen/qwen3.8-27b': groqStrict,
      'meta-models/muse-spark-open': groqStrict,
      'llama-3.3-70b-versatile': groqJsonOnly,
      // Listed by Groq's tool-use page, but this project's account got
      // `model_not_found` on 2026-10-23: availability is per account.
      'llama-3.1-8b-instant': groqJsonOnly,
      'minimaxai/minimax-m2.7': groqJsonOnly,
      '*': UNKNOWN,
    },
    limits: {
      requestsPerMinute: 30,
      tokensPerMinute: 8000,
      requestsPerDay: 1000,
      tokensPerDay: 200000,
      status: 'unverified',
      note: 'openai/gpt-oss-120b row of the "Developer plan" base limits table; the page does not say these are the free-plan limits. Copy your account limits from console.groq.com/settings/limits.',
    },
    free: true,
    dataUse: {
      status: 'unverified',
      note: 'Data-use terms not read; treat as untrusted.',
    },
    trusted: false,
    integrationTarget: 'agentcore-llm-provider',
    asOf: '2026-10-23',
    sourceUrls: [
      'https://console.groq.com/docs/openai',
      'https://console.groq.com/docs/tool-use',
      'https://console.groq.com/docs/structured-outputs',
      'https://console.groq.com/docs/rate-limits',
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini API (OpenAI compatibility, beta)',
    protocol: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    apiKeyRequired: true,
    maxTokensParam: 'max_tokens',
    defaultModels: {
      FAST: 'gemini-3.5-flash-lite',
      STRONG: 'gemini-3.8-flash',
    },
    capabilities: {
      // Tools documented (function calling, tool_choice auto). json_schema is
      // only shown via a Pydantic parse() example; max_tokens is not
      // mentioned. Until the smoke test measures them: unverified.
      '*': { tools: 'yes', structured: 'unknown', status: 'unverified' },
    },
    limits: {
      status: 'unverified',
      note: 'RPM/TPM/RPD are shown per account in AI Studio, not in the docs. Fill LLM_RATE_LIMIT_* yourself.',
    },
    free: true,
    dataUse: {
      status: 'documented',
      note: 'Free Tier: "Used to improve our products: Yes"; Paid Tier: No.',
    },
    trusted: false,
    integrationTarget: 'agentcore-llm-provider',
    asOf: '2026-10-23',
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/openai',
      'https://ai.google.dev/gemini-api/docs/pricing',
      'https://ai.google.dev/gemini-api/docs/rate-limits',
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    // The key variable in this project's .env is OPEN_ROUTER_API_KEY.
    apiKeyEnvVar: 'OPEN_ROUTER_API_KEY',
    apiKeyRequired: true,
    maxTokensParam: 'max_tokens',
    // Model ids were not verified from official docs: set LLM models
    // explicitly (tool/structured support varies per model).
    defaultModels: {},
    capabilities: { '*': UNKNOWN },
    limits: {
      requestsPerMinute: 20,
      requestsPerDay: 50,
      status: 'documented',
      note: '":free" model variants: 20 RPM; 50 requests/day with under 10 credits purchased, 1000/day with at least 10 (openrouter.ai/docs/api-reference/limits).',
    },
    free: true,
    dataUse: {
      status: 'unverified',
      note: 'Depends on the upstream provider of each model; not read.',
    },
    trusted: false,
    integrationTarget: 'agentcore-llm-provider',
    asOf: '2026-10-23',
    sourceUrls: [
      'https://openrouter.ai/docs/api-reference/overview',
      'https://openrouter.ai/docs/api-reference/errors',
      'https://openrouter.ai/docs/api-reference/limits',
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral La Plateforme',
    protocol: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    apiKeyRequired: true,
    maxTokensParam: 'max_tokens',
    // Ids appear as examples on docs.mistral.ai/api; a current list is only
    // available from the /models endpoint.
    defaultModels: {
      FAST: 'mistral-small-latest',
      STRONG: 'mistral-large-latest',
    },
    capabilities: {
      // Tools (tool_choice auto/none/any/required) and json_schema response
      // format are documented on the chat completions reference.
      '*': { tools: 'yes', structured: 'json_schema', status: 'documented' },
    },
    limits: {
      status: 'unverified',
      note: 'Free-tier limits page returned 404; read them from your account.',
    },
    free: false,
    dataUse: {
      status: 'unverified',
      note: 'Free-tier training/retention terms not read; treat as untrusted.',
    },
    trusted: false,
    integrationTarget: 'agentcore-llm-provider',
    asOf: '2026-10-23',
    sourceUrls: ['https://docs.mistral.ai/api/'],
  },
  {
    id: 'llm7',
    label: 'LLM7.io (optional candidate)',
    protocol: 'openai-chat',
    baseUrl: 'https://api.llm7.io/v1',
    apiKeyEnvVar: 'LLM7_API_KEY',
    apiKeyRequired: true,
    maxTokensParam: 'max_tokens',
    // Model ids and per-model tools/JSON flags come from the live Models
    // API (tools_calling, json_mode); none are assumed here.
    defaultModels: {},
    capabilities: {
      // JSON mode is json_object only (json_schema is not documented).
      '*': {
        tools: 'unknown',
        structured: 'json_object',
        status: 'unverified',
      },
    },
    limits: {
      requestsPerMinute: 60,
      requestsPerDay: undefined,
      tokensPerDay: 100000,
      status: 'documented',
      note: 'Free token: 1 req/s, 60/min, 250/hour, 100,000 tokens per 24 h (input+output); "may be reduced without notice" (docs.llm7.io/limits).',
    },
    free: true,
    dataUse: {
      status: 'unverified',
      note: 'No privacy page in the docs index; treat as untrusted.',
    },
    trusted: false,
    integrationTarget: 'agentcore-llm-provider',
    asOf: '2026-10-23',
    sourceUrls: [
      'https://docs.llm7.io/quickstart.md',
      'https://docs.llm7.io/limits.md',
      'https://docs.llm7.io/guides/function-calling.md',
      'https://docs.llm7.io/guides/json-mode.md',
    ],
  },
];

export const PROVIDER_PRESETS: ReadonlyMap<string, ProviderPreset> = new Map(
  RAW_PRESETS.map((raw) => {
    const preset = ProviderPresetSchema.parse(raw);
    return [preset.id, preset] as const;
  }),
);

export class PresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetError';
  }
}

export function presetFor(id: string): ProviderPreset {
  const preset = PROVIDER_PRESETS.get(id);
  if (!preset) throw new PresetError(`Unknown provider preset: ${id}`);
  return preset;
}

export function capabilityFor(
  preset: ProviderPreset,
  model: string,
): ModelCapability {
  return preset.capabilities[model] ?? preset.capabilities['*'] ?? UNKNOWN;
}

export interface PresetResolution {
  readonly preset: ProviderPreset;
  readonly apiKey: string | undefined;
  readonly models: { readonly FAST: string; readonly STRONG: string };
}

/**
 * Resolves a preset against the environment: reads only the key variable the
 * preset names. Missing key or unset models are reported by variable NAME,
 * never by value.
 */
export function resolvePreset(
  id: string,
  env: Readonly<Record<string, string | undefined>>,
  overrides: { FAST?: string; STRONG?: string } = {},
): PresetResolution {
  const preset = presetFor(id);
  const apiKey = env[preset.apiKeyEnvVar] || undefined;
  if (preset.apiKeyRequired && !apiKey) {
    throw new PresetError(
      `Provider ${id} is not configured: environment variable ${preset.apiKeyEnvVar} is not set`,
    );
  }
  const FAST = overrides.FAST ?? preset.defaultModels.FAST;
  const STRONG = overrides.STRONG ?? preset.defaultModels.STRONG;
  if (!FAST || !STRONG) {
    throw new PresetError(
      `Provider ${id} has no default model for ${!FAST ? 'FAST' : 'STRONG'}; set it explicitly`,
    );
  }
  return { preset, apiKey, models: { FAST, STRONG } };
}
