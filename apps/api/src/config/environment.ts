import { z } from 'zod';
import { ANY_MODEL, usdToNano } from '../core/llm/pricing.js';
import { MOCK_MODEL } from '../core/llm/scripted-llm-provider.js';
import { PRICING_CATALOG } from '../llm/pricing-catalog.js';
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
    /** Interface the API listens on. Deployment default stays 0.0.0.0. */
    API_HOST: z.string().min(1).default('0.0.0.0'),
    /**
     * A stream is closed after this long so proxies and load balancers never
     * keep a stale connection; the browser reconnects with Last-Event-ID.
     */
    INBOX_STREAM_MAX_MS: z.coerce
      .number()
      .int()
      .min(2000)
      .max(24 * 60 * 60 * 1000)
      .default(15 * 60 * 1000),
    /**
     * Shared secret the web server presents with the client address it
     * computed (ADR 021). Without it, logins are attributed to the TCP peer.
     */
    WEB_PROXY_SECRET: z.string().min(32).max(512).optional(),
    /** Login attempts allowed per client address and minute. */
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(20),
    /** Browser origins allowed to make state-changing inbox requests. */
    WEB_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    /** `Secure` flag of the session cookie; off only for plain-http local development. */
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
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
    LLM_PROVIDER: z
      .enum(['mock', 'anthropic', 'openai-compatible', 'routed'])
      .default('mock'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /**
     * openai-compatible: Chat Completions base URL (".../chat/completions"
     * is appended), optional bearer key, and the model per tier.
     */
    /** routed: optional JSON routing policy replacing the built-in default. */
    LLM_ROUTING_POLICY_FILE: z.string().min(1).optional(),
    LLM_BASE_URL: z.url().optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL_FAST: z.string().min(1).max(100).optional(),
    LLM_MODEL_STRONG: z.string().min(1).max(100).optional(),
    LLM_STRUCTURED_OUTPUT: z
      .enum(['json_schema', 'json_object'])
      .default('json_schema'),
    LLM_MAX_TOKENS_PARAM: z
      .enum(['max_tokens', 'max_completion_tokens'])
      .default('max_tokens'),
    /** Client-side limits to stay inside a provider quota (any provider). */
    LLM_RATE_LIMIT_RPM: z.coerce.number().int().min(1).max(100_000).optional(),
    LLM_RATE_LIMIT_TPM: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(100_000_000)
      .optional(),
    LLM_RATE_LIMIT_RPD: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000_000)
      .optional(),
    LLM_RATE_LIMIT_MAX_WAIT_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(60_000)
      .default(5_000),
    /**
     * Data protection: providers allowed to receive real customer data
     * without the override. Default only the offline mock. Free tiers may
     * use prompts to improve their products.
     */
    LLM_TRUSTED_PROVIDERS: z
      .string()
      .default('mock')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    LLM_ALLOW_REAL_CUSTOMER_DATA: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
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
    /** Token caps (input + output); they also bound zero-priced models. */
    LLM_TURN_TOKEN_BUDGET: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(10_000_000)
      .default(120_000),
    LLM_CONVERSATION_TOKEN_BUDGET: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(100_000_000)
      .default(1_000_000),
    AGENT_TOOL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30_000)
      .default(8_000),
    AGENT_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(20).default(8),
    /** Whole-turn deadline (model + tools); on expiry the turn hands over. */
    AGENT_TURN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(60_000),
    /**
     * A COMPUTING turn older than this is presumed dead and may be taken
     * over by another worker. Must exceed AGENT_TURN_TIMEOUT_MS.
     */
    AGENT_TURN_LEASE_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(900_000)
      .default(120_000),
    /** Minutes a handover may wait for an operator before the SLA alert. */
    HANDOVER_SLA_MINUTES: z.coerce.number().int().min(1).max(1_440).default(10),
    /** How often overdue handovers and failed lead syncs are scanned. */
    HANDOVER_SCAN_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(3_600)
      .default(30),
    /**
     * Embeddings for knowledge retrieval. Off until configured. The embedder
     * receives customer questions, so an untrusted provider is limited like
     * the chat providers (test accounts / explicit owner consent).
     */
    /**
     * Key for encrypting channel secrets (bot tokens) in the database, 32
     * random bytes in base64 (`openssl rand -base64 32`). Without it a bot
     * cannot be connected from the web UI. Back it up separately from the
     * database; losing it makes stored tokens unreadable. Rotation: put the
     * new key here with a new SECRETS_KEY_ID and list old ones in
     * SECRETS_PREVIOUS_KEYS as id:base64 pairs.
     */
    SECRETS_MASTER_KEY: z
      .string()
      .refine((value) => Buffer.from(value.trim(), 'base64').length === 32, {
        message: 'must be 32 bytes, base64 encoded',
      })
      .optional(),
    SECRETS_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/u)
      .optional(),
    SECRETS_PREVIOUS_KEYS: z.string().max(2000).optional(),
    /** Test double for api.telegram.org (e2e). Refused in production. */
    TELEGRAM_API_BASE_URL: z.url().optional(),
    /** https base URL of this API as Telegram sees it (webhook target). */
    PUBLIC_BASE_URL: z
      .url()
      .refine((value) => value.startsWith('https://'), {
        message: 'must be an https URL',
      })
      .optional(),
    KNOWLEDGE_EMBEDDINGS: z
      .enum(['off', 'gemini', 'openai-compatible', 'hashing'])
      .default('off'),
    KNOWLEDGE_EMBEDDING_MODEL: z.string().min(1).max(100).optional(),
    KNOWLEDGE_EMBEDDING_BASE_URL: z.string().url().optional(),
    /** Local hour from which the daily operator digest is posted. */
    DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(9),
    /** Follow-ups to silent customers are off until the owner enables them. */
    FOLLOWUP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    FOLLOWUP_AFTER_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    FOLLOWUP_MAX_PER_CONVERSATION: z.coerce
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1),
    FOLLOWUP_MAX_PER_TENANT_PER_DAY: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(200),
    /** The daily operator digest is off until the owner enables it. */
    DIGEST_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    FOLLOWUP_QUIET_START_HOUR: z.coerce
      .number()
      .int()
      .min(0)
      .max(23)
      .default(21),
    FOLLOWUP_QUIET_END_HOUR: z.coerce.number().int().min(0).max(23).default(9),
    /** Earlier no-progress turns before the STUCK handover (spec §7.4). */
    STUCK_REPEAT_LIMIT: z.coerce.number().int().min(1).max(5).default(2),
  })
  .superRefine((environment, context) => {
    if (
      environment.TELEGRAM_API_BASE_URL &&
      environment.NODE_ENV === 'production'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_API_BASE_URL'],
        message:
          'TELEGRAM_API_BASE_URL is a test setting and is refused in production',
      });
    }
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
    if (environment.LLM_PROVIDER === 'openai-compatible') {
      for (const key of [
        'LLM_BASE_URL',
        'LLM_MODEL_FAST',
        'LLM_MODEL_STRONG',
      ] as const) {
        if (!environment[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when LLM_PROVIDER is openai-compatible`,
          });
        }
      }
      if (environment.LLM_BASE_URL) {
        const url = new URL(environment.LLM_BASE_URL);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(
          url.hostname,
        );
        // Plain http only for a local server (e.g. Ollama) outside production.
        if (
          url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' &&
            local &&
            environment.NODE_ENV !== 'production'
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['LLM_BASE_URL'],
            message:
              'must use https (plain http is allowed only for localhost outside production)',
          });
        }
        if (url.username || url.password) {
          context.addIssue({
            code: 'custom',
            path: ['LLM_BASE_URL'],
            message: 'must not contain credentials; use LLM_API_KEY',
          });
        }
      }
    }
    if (
      environment.LLM_TURN_TOKEN_BUDGET >
      environment.LLM_CONVERSATION_TOKEN_BUDGET
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_TURN_TOKEN_BUDGET'],
        message: 'must not exceed LLM_CONVERSATION_TOKEN_BUDGET',
      });
    }
    if (
      environment.LLM_PROVIDER === 'routed' &&
      !PRICING_CATALOG.has(environment.LLM_PRICING_VERSION)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_PRICING_VERSION'],
        message:
          'routed requires a pricing version covering every routed model',
      });
    }
    if (!PRICING_CATALOG.has(environment.LLM_PRICING_VERSION)) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_PRICING_VERSION'],
        message: 'unknown pricing version',
      });
    } else {
      const snapshot = PRICING_CATALOG.snapshot(
        environment.LLM_PRICING_VERSION,
      );
      const models: ReadonlyArray<readonly [string, string | undefined]> =
        environment.LLM_PROVIDER === 'anthropic'
          ? [
              ['LLM_FAST_MODEL', environment.LLM_FAST_MODEL],
              ['LLM_STRONG_MODEL', environment.LLM_STRONG_MODEL],
            ]
          : environment.LLM_PROVIDER === 'openai-compatible'
            ? [
                ['LLM_MODEL_FAST', environment.LLM_MODEL_FAST],
                ['LLM_MODEL_STRONG', environment.LLM_MODEL_STRONG],
              ]
            : environment.LLM_PROVIDER === 'routed'
              ? [] // every routed candidate is priced when the router is built
              : [['LLM_PROVIDER', MOCK_MODEL]];
      for (const [key, model] of models) {
        if (!model) continue;
        const pricing = snapshot.models[model] ?? snapshot.models[ANY_MODEL];
        if (!pricing) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `model has no price in ${environment.LLM_PRICING_VERSION}; an unpriced model cannot be budgeted`,
          });
          continue;
        }
        // Every allowed prompt must stay on the standard price tier. The
        // input estimate is UTF-8 bytes plus the tool preamble.
        const threshold = pricing.longContext?.threshold;
        const overhead = pricing.toolUseSystemPromptTokens ?? 400;
        if (
          threshold !== undefined &&
          environment.LLM_MAX_INPUT_BYTES + overhead > threshold
        ) {
          context.addIssue({
            code: 'custom',
            path: ['LLM_MAX_INPUT_BYTES'],
            message: `must keep prompts under the ${threshold}-token long-prompt price threshold of ${model}`,
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
      environment.AGENT_TURN_LEASE_MS <
      environment.AGENT_TURN_TIMEOUT_MS + 10_000
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AGENT_TURN_LEASE_MS'],
        message:
          'must exceed AGENT_TURN_TIMEOUT_MS by at least 10000 so a live turn is never taken over',
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
    if (
      environment.NODE_ENV === 'production' &&
      !environment.WEB_PROXY_SECRET
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_PROXY_SECRET'],
        message:
          'WEB_PROXY_SECRET is required in production (per-client login limits behind the web server)',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      !environment.SESSION_COOKIE_SECURE
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'SESSION_COOKIE_SECURE=false is refused in production',
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
