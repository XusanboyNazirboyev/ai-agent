import { z } from 'zod';
import type { PoolConfig } from 'pg';

export const postgresEnvironmentSchema = z.object({
  POSTGRES_HOST: z.string().trim().min(1),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535),
  POSTGRES_DATABASE: z.string().trim().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_SSL_MODE: z
    .enum(['disable', 'require', 'verify-full'])
    .default('verify-full'),
});

export type PostgresEnvironment = z.infer<typeof postgresEnvironmentSchema>;

export function parsePostgresEnvironment(
  source: Record<string, unknown>,
  prefix = '',
): PostgresEnvironment {
  const values = prefix
    ? Object.fromEntries(
        Object.keys(postgresEnvironmentSchema.shape).map((key) => [
          key,
          source[`${prefix}${key}`],
        ]),
      )
    : source;
  const result = postgresEnvironmentSchema.safeParse(values);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((field, index, all) => all.indexOf(field) === index);
    throw new Error(
      `Invalid PostgreSQL configuration. Check: ${fields.join(', ')}`,
    );
  }
  return result.data;
}

export function postgresConnectionUrl(config: PostgresEnvironment): string {
  const url = new URL('postgresql://localhost');
  url.hostname = config.POSTGRES_HOST;
  url.port = String(config.POSTGRES_PORT);
  url.username = config.POSTGRES_USER;
  url.password = config.POSTGRES_PASSWORD;
  url.pathname = `/${encodeURIComponent(config.POSTGRES_DATABASE)}`;
  url.searchParams.set('schema', 'public');
  url.searchParams.set('sslmode', config.POSTGRES_SSL_MODE);
  url.searchParams.set('connect_timeout', '5');
  return url.toString();
}

export function postgresPoolOptions(config: PostgresEnvironment): PoolConfig {
  return {
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DATABASE,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    ssl:
      config.POSTGRES_SSL_MODE === 'disable'
        ? false
        : config.POSTGRES_SSL_MODE === 'verify-full'
          ? { rejectUnauthorized: true }
          : { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  };
}
