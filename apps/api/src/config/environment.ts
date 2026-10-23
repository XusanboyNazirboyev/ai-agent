import { z } from 'zod';
import { postgresEnvironmentSchema } from './postgres-config.js';

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
  })
  .superRefine((environment, context) => {
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
