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
import { AnthropicLlmProvider } from '../llm/anthropic/anthropic-llm-provider.js';

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
export function createLlmProvider(environment: LlmEnvironment): LlmProvider {
  if (environment.LLM_PROVIDER === 'mock')
    return new ScriptedLlmProvider(neutralResponder);
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

export function budgetLimits(environment: LlmEnvironment): BudgetLimits {
  return {
    maxTurnCostNano: usdToNano(environment.LLM_TURN_BUDGET_USD),
    maxConversationCostNano: usdToNano(environment.LLM_CONVERSATION_BUDGET_USD),
    maxCallsPerTurn: environment.LLM_MAX_CALLS_PER_TURN,
    maxToolRoundsPerTurn: environment.LLM_MAX_TOOL_ROUNDS,
    maxToolCallsPerTurn: environment.LLM_MAX_TOOL_CALLS_PER_TURN,
    maxOutputTokensPerCall: environment.LLM_MAX_OUTPUT_TOKENS,
    maxInputBytesPerCall: environment.LLM_MAX_INPUT_BYTES,
    ...(environment.LLM_TENANT_MONTHLY_BUDGET_USD
      ? {
          tenantMonthlyBudgetNano: usdToNano(
            environment.LLM_TENANT_MONTHLY_BUDGET_USD,
          ),
        }
      : {}),
  };
}
