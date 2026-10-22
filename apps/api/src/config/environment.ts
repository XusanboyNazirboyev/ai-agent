import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z
    .url()
    .default(
      'postgresql://agentcore:agentcore@localhost:5432/agentcore?schema=public',
    ),
  REDIS_URL: z.url().default('redis://localhost:6379'),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  environment: Record<string, unknown>,
): AppEnvironment {
  return environmentSchema.parse(environment);
}
