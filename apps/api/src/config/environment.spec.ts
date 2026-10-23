import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment.js';
import {
  parsePostgresEnvironment,
  postgresConnectionUrl,
  postgresPoolOptions,
} from './postgres-config.js';

const postgresEnvironment = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_DATABASE: 'agentcore',
  POSTGRES_USER: 'agentcore',
  POSTGRES_PASSWORD: 'test-only',
};

describe('validateEnvironment', () => {
  it('provides development defaults', () => {
    expect(validateEnvironment(postgresEnvironment)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
      POSTGRES_SSL_MODE: 'verify-full',
    });
  });

  it('coerces a valid port and rejects an invalid port', () => {
    expect(
      validateEnvironment({ ...postgresEnvironment, PORT: '8080' }).PORT,
    ).toBe(8080);
    expect(() =>
      validateEnvironment({ ...postgresEnvironment, PORT: '70000' }),
    ).toThrow();
  });

  it('rejects malformed service URLs', () => {
    expect(() =>
      validateEnvironment({
        ...postgresEnvironment,
        REDIS_URL: 'not-a-url',
      }),
    ).toThrow();
  });

  it('requires Telegram account, bot token, and webhook secret as one configuration set', () => {
    expect(() =>
      validateEnvironment({
        ...postgresEnvironment,
        TELEGRAM_BOT_TOKEN: 'token',
      }),
    ).toThrow(/must be configured together/);
    expect(
      validateEnvironment({
        ...postgresEnvironment,
        TELEGRAM_CHANNEL_ACCOUNT_ID: '00000000-0000-4000-8000-000000000001',
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
      }).TELEGRAM_RATE_LIMIT_PER_MINUTE,
    ).toBe(120);
  });

  it('defaults connectors to the strict outbound policy and refuses permissive in production', () => {
    expect(
      validateEnvironment(postgresEnvironment).CONNECTOR_OUTBOUND_POLICY,
    ).toBe('strict');
    expect(
      validateEnvironment({
        ...postgresEnvironment,
        CONNECTOR_OUTBOUND_POLICY: 'permissive',
      }).CONNECTOR_OUTBOUND_POLICY,
    ).toBe('permissive');
    expect(() =>
      validateEnvironment({
        ...postgresEnvironment,
        NODE_ENV: 'production',
        CONNECTOR_OUTBOUND_POLICY: 'permissive',
      }),
    ).toThrow(/must be strict in production/);
    expect(() =>
      validateEnvironment({
        ...postgresEnvironment,
        CONNECTOR_OUTBOUND_POLICY: 'open',
      }),
    ).toThrow();
  });

  it('provides bounded catalog sync defaults', () => {
    expect(validateEnvironment(postgresEnvironment)).toMatchObject({
      CATALOG_SYNC_INTERVAL_MINUTES: 60,
      CATALOG_SYNC_STALE_AFTER_SECONDS: 300,
      CATALOG_SYNC_MAX_ITEMS: 5_000,
    });
    expect(
      validateEnvironment({
        ...postgresEnvironment,
        CATALOG_SYNC_INTERVAL_MINUTES: '0',
      }).CATALOG_SYNC_INTERVAL_MINUTES,
    ).toBe(0);
    for (const [key, value] of [
      ['CATALOG_SYNC_STALE_AFTER_SECONDS', '5'],
      ['CATALOG_SYNC_MAX_ITEMS', '0'],
      ['CATALOG_SYNC_INTERVAL_MINUTES', '-1'],
    ]) {
      expect(() =>
        validateEnvironment({ ...postgresEnvironment, [key]: value }),
      ).toThrow();
    }
  });

  it('reports missing PostgreSQL settings without printing secrets', () => {
    expect(() => validateEnvironment({})).toThrow(/POSTGRES_HOST/);
    expect(() =>
      validateEnvironment({ ...postgresEnvironment, POSTGRES_PASSWORD: '' }),
    ).toThrow(/POSTGRES_PASSWORD/);
  });

  it('validates explicit PostgreSQL settings and encodes CLI URL credentials', () => {
    const postgres = parsePostgresEnvironment({
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PORT: '5432',
      POSTGRES_DATABASE: 'agent core',
      POSTGRES_USER: 'agent@core',
      POSTGRES_PASSWORD: 'p@ss:/word',
    });
    const connection = new URL(postgresConnectionUrl(postgres));

    expect(connection.hostname).toBe('db.internal');
    expect(connection.pathname).toBe('/agent%20core');
    expect(connection.username).toBe('agent%40core');
    expect(connection.password).toBe('p%40ss%3A%2Fword');
    expect(connection.searchParams.get('sslmode')).toBe('verify-full');
  });

  it('reads the same PostgreSQL fields using the integration-test prefix', () => {
    expect(
      parsePostgresEnvironment(
        {
          TEST_POSTGRES_HOST: 'postgres',
          TEST_POSTGRES_PORT: '55432',
          TEST_POSTGRES_DATABASE: 'agentcore_test',
          TEST_POSTGRES_USER: 'test-user',
          TEST_POSTGRES_PASSWORD: 'test-pass',
          TEST_POSTGRES_SSL_MODE: 'disable',
        },
        'TEST_',
      ),
    ).toMatchObject({
      POSTGRES_HOST: 'postgres',
      POSTGRES_PORT: 55432,
      POSTGRES_DATABASE: 'agentcore_test',
      POSTGRES_SSL_MODE: 'disable',
    });
  });

  it('configures bounded pool timeouts and explicit TLS policy', () => {
    const config = parsePostgresEnvironment({
      ...postgresEnvironment,
      POSTGRES_SSL_MODE: 'verify-full',
    });
    expect(postgresPoolOptions(config)).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: true },
    });
    expect(() =>
      parsePostgresEnvironment({
        ...postgresEnvironment,
        POSTGRES_SSL_MODE: 'invalid',
      }),
    ).toThrow(/POSTGRES_SSL_MODE/);

    expect(
      postgresPoolOptions(
        parsePostgresEnvironment({
          ...postgresEnvironment,
          POSTGRES_SSL_MODE: 'disable',
        }),
      ).ssl,
    ).toBe(false);
    expect(
      postgresPoolOptions(
        parsePostgresEnvironment({
          ...postgresEnvironment,
          POSTGRES_SSL_MODE: 'require',
        }),
      ).ssl,
    ).toMatchObject({ rejectUnauthorized: false });
  });
});
