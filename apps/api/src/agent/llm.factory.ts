import Anthropic from '@anthropic-ai/sdk';
import type { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import type { BudgetLimits } from '../core/llm/budget.js';
import type { LlmProvider } from '../core/llm/llm-provider.js';
import { usdToNano } from '../core/llm/pricing.js';
import {
  neutralResponder,
  ScriptedLlmProvider,
} from '../core/llm/scripted-llm-provider.js';
import { PRICING_CATALOG } from '../llm/pricing-catalog.js';
import {
  buildRoutedProvider,
  loadRoutingPolicy,
} from '../llm/routing/routing-factory.js';
import { AnthropicLlmProvider } from '../llm/anthropic/anthropic-llm-provider.js';
import { OpenAiCompatibleLlmProvider } from '../llm/openai-compatible/openai-compatible-provider.js';
import {
  ClientRateLimiter,
  RateLimitedLlmProvider,
} from '../llm/rate-limited-provider.js';

export type LlmEnvironment = Pick<
  AppEnvironment,
  | 'LLM_PROVIDER'
  | 'ANTHROPIC_API_KEY'
  | 'LLM_FAST_MODEL'
  | 'LLM_STRONG_MODEL'
  | 'LLM_EFFORT'
  | 'LLM_REQUEST_TIMEOUT_MS'
  | 'LLM_MAX_RETRIES'
  | 'LLM_MAX_OUTPUT_TOKENS'
  | 'LLM_MAX_INPUT_BYTES'
  | 'LLM_MAX_CALLS_PER_TURN'
  | 'LLM_MAX_TOOL_ROUNDS'
  | 'LLM_MAX_TOOL_CALLS_PER_TURN'
  | 'LLM_TURN_BUDGET_USD'
  | 'LLM_CONVERSATION_BUDGET_USD'
  | 'LLM_TENANT_MONTHLY_BUDGET_USD'
  | 'LLM_BASE_URL'
  | 'LLM_ROUTING_POLICY_FILE'
  | 'LLM_PRICING_VERSION'
  | 'LLM_API_KEY'
  | 'LLM_MODEL_FAST'
  | 'LLM_MODEL_STRONG'
  | 'LLM_STRUCTURED_OUTPUT'
  | 'LLM_MAX_TOKENS_PARAM'
  | 'LLM_RATE_LIMIT_RPM'
  | 'LLM_RATE_LIMIT_TPM'
  | 'LLM_RATE_LIMIT_RPD'
  | 'LLM_RATE_LIMIT_MAX_WAIT_MS'
  | 'LLM_TURN_TOKEN_BUDGET'
  | 'LLM_CONVERSATION_TOKEN_BUDGET'
  | 'LLM_TRUSTED_PROVIDERS'
  | 'LLM_ALLOW_REAL_CUSTOMER_DATA'
>;

const LLM_KEYS = [
  'LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'LLM_FAST_MODEL',
  'LLM_STRONG_MODEL',
  'LLM_EFFORT',
  'LLM_REQUEST_TIMEOUT_MS',
  'LLM_MAX_RETRIES',
  'LLM_MAX_OUTPUT_TOKENS',
  'LLM_MAX_INPUT_BYTES',
  'LLM_MAX_CALLS_PER_TURN',
  'LLM_MAX_TOOL_ROUNDS',
  'LLM_MAX_TOOL_CALLS_PER_TURN',
  'LLM_TURN_BUDGET_USD',
  'LLM_CONVERSATION_BUDGET_USD',
  'LLM_TENANT_MONTHLY_BUDGET_USD',
  'LLM_BASE_URL',
  'LLM_ROUTING_POLICY_FILE',
  'LLM_PRICING_VERSION',
  'LLM_API_KEY',
  'LLM_MODEL_FAST',
  'LLM_MODEL_STRONG',
  'LLM_STRUCTURED_OUTPUT',
  'LLM_MAX_TOKENS_PARAM',
  'LLM_RATE_LIMIT_RPM',
  'LLM_RATE_LIMIT_TPM',
  'LLM_RATE_LIMIT_RPD',
  'LLM_RATE_LIMIT_MAX_WAIT_MS',
  'LLM_TURN_TOKEN_BUDGET',
  'LLM_CONVERSATION_TOKEN_BUDGET',
  'LLM_TRUSTED_PROVIDERS',
  'LLM_ALLOW_REAL_CUSTOMER_DATA',
] as const satisfies ReadonlyArray<keyof LlmEnvironment>;

/** Reads the validated LLM settings from Nest configuration. */
export function llmEnvironment(
  config: ConfigService<AppEnvironment, true>,
): LlmEnvironment {
  return Object.fromEntries(
    LLM_KEYS.map((key) => [key, config.get(key, { infer: true })]),
  ) as unknown as LlmEnvironment;
}

/**
 * The single provider for the process. `mock` never touches the network.
 * `anthropic` is a configured adapter only: a working key and a successful
 * live request are separate facts that this factory does not check.
 */
function baseProvider(
  environment: LlmEnvironment,
  transport?: typeof fetch,
  secrets: Readonly<Record<string, string | undefined>> = process.env,
): LlmProvider {
  if (environment.LLM_PROVIDER === 'routed') {
    const snapshot = PRICING_CATALOG.snapshot(environment.LLM_PRICING_VERSION);
    const build = buildRoutedProvider({
      policy: loadRoutingPolicy(environment.LLM_ROUTING_POLICY_FILE),
      snapshot,
      env: secrets,
      trustedProviders: environment.LLM_TRUSTED_PROVIDERS,
      requestTimeoutMs: environment.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: environment.LLM_MAX_RETRIES,
      maxInputBytes: environment.LLM_MAX_INPUT_BYTES,
      ...(transport ? { fetch: transport } : {}),
    });
    return build.provider;
  }
  if (environment.LLM_PROVIDER === 'mock')
    return new ScriptedLlmProvider(neutralResponder);
  if (environment.LLM_PROVIDER === 'openai-compatible') {
    if (
      !environment.LLM_BASE_URL ||
      !environment.LLM_MODEL_FAST ||
      !environment.LLM_MODEL_STRONG
    ) {
      throw new Error(
        'LLM_BASE_URL, LLM_MODEL_FAST and LLM_MODEL_STRONG are required for openai-compatible',
      );
    }
    return new OpenAiCompatibleLlmProvider({
      baseUrl: environment.LLM_BASE_URL,
      apiKey: environment.LLM_API_KEY,
      models: {
        FAST: environment.LLM_MODEL_FAST,
        STRONG: environment.LLM_MODEL_STRONG,
      },
      structuredOutput: environment.LLM_STRUCTURED_OUTPUT,
      maxTokensParam: environment.LLM_MAX_TOKENS_PARAM,
      requestTimeoutMs: environment.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: environment.LLM_MAX_RETRIES,
      ...(transport ? { fetch: transport } : {}),
    });
  }
  if (!environment.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is required when LLM_PROVIDER is anthropic',
    );
  }
  return new AnthropicLlmProvider({
    client: new Anthropic({
      apiKey: environment.ANTHROPIC_API_KEY,
      maxRetries: 0,
    }),
    models: {
      FAST: environment.LLM_FAST_MODEL,
      STRONG: environment.LLM_STRONG_MODEL,
    },
    effort: environment.LLM_EFFORT,
    requestTimeoutMs: environment.LLM_REQUEST_TIMEOUT_MS,
    maxRetries: environment.LLM_MAX_RETRIES,
  });
}

/**
 * The single provider for the process, wrapped in the client-side limiter
 * when any LLM_RATE_LIMIT_* is configured.
 */
export function createLlmProvider(
  environment: LlmEnvironment,
  transport?: typeof fetch,
  secrets: Readonly<Record<string, string | undefined>> = process.env,
): LlmProvider {
  const provider = baseProvider(environment, transport, secrets);
  const limited =
    environment.LLM_RATE_LIMIT_RPM !== undefined ||
    environment.LLM_RATE_LIMIT_TPM !== undefined ||
    environment.LLM_RATE_LIMIT_RPD !== undefined;
  if (!limited) return provider;
  return new RateLimitedLlmProvider(
    provider,
    new ClientRateLimiter({
      requestsPerMinute: environment.LLM_RATE_LIMIT_RPM,
      tokensPerMinute: environment.LLM_RATE_LIMIT_TPM,
      requestsPerDay: environment.LLM_RATE_LIMIT_RPD,
      maxWaitMs: environment.LLM_RATE_LIMIT_MAX_WAIT_MS,
    }),
  );
}

/** Whether the configured provider may receive real customer data. */
export function providerTrusted(environment: LlmEnvironment): boolean {
  return environment.LLM_TRUSTED_PROVIDERS.includes(environment.LLM_PROVIDER);
}

export function budgetLimits(environment: LlmEnvironment): BudgetLimits {
  return {
    maxTurnCostNano: usdToNano(environment.LLM_TURN_BUDGET_USD),
    maxConversationCostNano: usdToNano(environment.LLM_CONVERSATION_BUDGET_USD),
    maxCallsPerTurn: environment.LLM_MAX_CALLS_PER_TURN,
    maxToolRoundsPerTurn: environment.LLM_MAX_TOOL_ROUNDS,
    maxToolCallsPerTurn: environment.LLM_MAX_TOOL_CALLS_PER_TURN,
    maxOutputTokensPerCall: environment.LLM_MAX_OUTPUT_TOKENS,
    maxInputBytesPerCall: environment.LLM_MAX_INPUT_BYTES,
    maxTurnTokens: environment.LLM_TURN_TOKEN_BUDGET,
    maxConversationTokens: environment.LLM_CONVERSATION_TOKEN_BUDGET,
    ...(environment.LLM_TENANT_MONTHLY_BUDGET_USD
      ? {
          tenantMonthlyBudgetNano: usdToNano(
            environment.LLM_TENANT_MONTHLY_BUDGET_USD,
          ),
        }
      : {}),
  };
}
