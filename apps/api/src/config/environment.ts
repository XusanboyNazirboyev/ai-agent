import { z } from 'zod';
import { PRICING_SNAPSHOTS, usdToNano } from '../core/llm/pricing.js';
import { postgresEnvironmentSchema } from './postgres-config.js';

/** USD amount as a decimal string ("0.02"), validated exactly. */
const usdAmount = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,9})?$/, 'must be a USD amount such as 0.02')
  .refine((value) => usdToNano(value) > 0, 'must be greater than zero');

const environmentSchema = postgresEnvironmentSchema
  .extend({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    TELEGRAM_CHANNEL_ACCOUNT_ID: z.uuid().optional(),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,256}$/)
      .optional(),
    TELEGRAM_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(120),
    /**
     * Outbound policy for CRM connectors. `permissive` (private/loopback
     * destinations and plain http, still DNS-pinned) is for a developer's own
     * machine only and is refused in production.
     */
    CONNECTOR_OUTBOUND_POLICY: z
      .enum(['strict', 'permissive'])
      .default('strict'),
    /** Scheduled catalog sync per active connector; 0 disables scheduling. */
    CATALOG_SYNC_INTERVAL_MINUTES: z.coerce
      .number()
      .int()
      .min(0)
      .max(1_440)
      .default(60),
    /** A running sync without a heartbeat for this long is recovered as FAILED. */
    CATALOG_SYNC_STALE_AFTER_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3_600)
      .default(300),
    /** Catalogs larger than this fail instead of being truncated. */
    CATALOG_SYNC_MAX_ITEMS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(5_000),
    /**
     * LLM provider. `mock` is deterministic and offline (development, CI);
     * `anthropic` calls the Claude API and requires ANTHROPIC_API_KEY. There
     * is no automatic fallback between providers.
     */
    LLM_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    LLM_FAST_MODEL: z.string().min(1).default('claude-haiku-5-5'),
    LLM_STRONG_MODEL: z.string().min(1).default('claude-haiku-5-5'),
    LLM_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
    LLM_PRICING_VERSION: z.string().min(1).default('anthropic-2026-10-23'),
    LLM_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(20_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
    // Provisional, owner-unapproved limits; see docs/LLM_PROVIDER_EVALUATION.md.
    LLM_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(256)
      .max(4_096)
      .default(1_024),
    LLM_MAX_INPUT_BYTES: z.coerce
      .number()
      .int()
      .min(4_000)
      .max(200_000)
      .default(48_000),
    LLM_MAX_CALLS_PER_TURN: z.coerce.number().int().min(1).max(12).default(6),
    LLM_MAX_TOOL_ROUNDS: z.coerce.number().int().min(0).max(6).default(3),
    LLM_MAX_TOOL_CALLS_PER_TURN: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(6),
    LLM_TURN_BUDGET_USD: usdAmount.default('0.02'),
    LLM_CONVERSATION_BUDGET_USD: usdAmount.default('0.25'),
    LLM_TENANT_MONTHLY_BUDGET_USD: usdAmount.optional(),
    AGENT_TOOL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30_000)
      .default(8_000),
    AGENT_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(20).default(8),
  })
  .superRefine((environment, context) => {
    if (
      environment.LLM_PROVIDER === 'anthropic' &&
      !environment.ANTHROPIC_API_KEY
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER is anthropic',
      });
    }
    const snapshot = PRICING_SNAPSHOTS[environment.LLM_PRICING_VERSION];
    if (!snapshot) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_PRICING_VERSION'],
        message: 'unknown pricing version',
      });
    } else if (environment.LLM_PROVIDER === 'anthropic') {
      for (const key of ['LLM_FAST_MODEL', 'LLM_STRONG_MODEL'] as const) {
        if (!snapshot.models[environment[key]]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `model has no price in ${environment.LLM_PRICING_VERSION}; an unpriced model cannot be budgeted`,
          });
        }
      }
    }
    if (
      usdToNano(environment.LLM_TURN_BUDGET_USD) >
      usdToNano(environment.LLM_CONVERSATION_BUDGET_USD)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_TURN_BUDGET_USD'],
        message: 'must not exceed LLM_CONVERSATION_BUDGET_USD',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.CONNECTOR_OUTBOUND_POLICY !== 'strict'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CONNECTOR_OUTBOUND_POLICY'],
        message: 'CONNECTOR_OUTBOUND_POLICY must be strict in production',
      });
    }
    const configured = [
      environment.TELEGRAM_CHANNEL_ACCOUNT_ID,
      environment.TELEGRAM_BOT_TOKEN,
      environment.TELEGRAM_WEBHOOK_SECRET,
    ].filter(Boolean).length;
    if (configured > 0 && configured < 3) {
      context.addIssue({
        code: 'custom',
        message:
          'TELEGRAM_CHANNEL_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, and TELEGRAM_WEBHOOK_SECRET must be configured together',
      });
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  environment: Record<string, unknown>,
): AppEnvironment {
  return environmentSchema.parse(environment);
}
