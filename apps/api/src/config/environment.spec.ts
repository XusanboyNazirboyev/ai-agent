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

  it('defaults to the offline mock LLM with bounded provisional limits', () => {
    expect(validateEnvironment(postgresEnvironment)).toMatchObject({
      LLM_PROVIDER: 'mock',
      LLM_FAST_MODEL: 'claude-haiku-5-5',
      LLM_STRONG_MODEL: 'claude-haiku-5-5',
      LLM_MAX_OUTPUT_TOKENS: 1_024,
      LLM_MAX_CALLS_PER_TURN: 6,
      LLM_MAX_TOOL_ROUNDS: 3,
      LLM_TURN_BUDGET_USD: '0.02',
      LLM_CONVERSATION_BUDGET_USD: '0.25',
    });
  });

  it('fails fast on an unusable LLM configuration', () => {
    expect(() =>
      validateEnvironment({
        ...postgresEnvironment,
        LLM_PROVIDER: 'anthropic',
      }),
    ).toThrow(/ANTHROPIC_API_KEY is required/);
    expect(() =>
      validateEnvironment({
        ...postgresEnvironment,
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'test-only',
        LLM_FAST_MODEL: 'claude-unpriced-model',
      }),
    ).toThrow(/no price/);
    for (const [key, value] of [
      ['LLM_TURN_BUDGET_USD', '0'],
      ['LLM_TURN_BUDGET_USD', '1e-3'],
      ['LLM_CONVERSATION_BUDGET_USD', '0.01'],
      ['LLM_MAX_TOOL_ROUNDS', '50'],
      ['LLM_PRICING_VERSION', 'made-up'],
      ['LLM_PROVIDER', 'openai'],
    ]) {
      expect(() =>
        validateEnvironment({ ...postgresEnvironment, [key]: value }),
      ).toThrow();
    }
    expect(
      validateEnvironment({
        ...postgresEnvironment,
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'test-only',
      }).LLM_PROVIDER,
    ).toBe('anthropic');
  });

  it('configures an OpenAI-compatible provider (Gemini free tier, local Ollama)', () => {
    const gemini = validateEnvironment({
      ...postgresEnvironment,
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      LLM_API_KEY: 'test-only',
      LLM_MODEL_FAST: 'gemini-3.1-flash-lite',
      LLM_MODEL_STRONG: 'gemini-3.8-flash',
      LLM_PRICING_VERSION: 'gemini-free-2026-10-23',
      LLM_RATE_LIMIT_RPM: '10',
      LLM_RATE_LIMIT_RPD: '200',
    });
    expect(gemini).toMatchObject({
      LLM_STRUCTURED_OUTPUT: 'json_schema',
      LLM_MAX_TOKENS_PARAM: 'max_tokens',
      LLM_RATE_LIMIT_RPM: 10,
      LLM_TRUSTED_PROVIDERS: ['mock'],
      LLM_ALLOW_REAL_CUSTOMER_DATA: false,
      LLM_TURN_TOKEN_BUDGET: 120_000,
      LLM_CONVERSATION_TOKEN_BUDGET: 1_000_000,
    });
    const ollama = validateEnvironment({
      ...postgresEnvironment,
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_MODEL_FAST: 'qwen3:8b',
      LLM_MODEL_STRONG: 'qwen3:8b',
      LLM_PRICING_VERSION: 'local-free-2026-10-23',
    });
    expect(ollama.LLM_API_KEY).toBeUndefined();
  });

  it('accepts the routed provider only with a known pricing version', () => {
    const base = { ...postgresEnvironment, LLM_PROVIDER: 'routed' };
    expect(() => validateEnvironment(base)).not.toThrow();
    expect(
      validateEnvironment({
        ...base,
        LLM_PRICING_VERSION: 'routing-free-2026-10-23',
        LLM_TRUSTED_PROVIDERS: 'mock',
      }),
    ).toMatchObject({ LLM_PROVIDER: 'routed' });
    expect(() =>
      validateEnvironment({ ...base, LLM_PRICING_VERSION: 'made-up' }),
    ).toThrow(/pricing version/u);
  });

  it('refuses unsafe or incomplete OpenAI-compatible settings', () => {
    const base = {
      ...postgresEnvironment,
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'https://llm.example.test/v1',
      LLM_MODEL_FAST: 'gemini-3.8-flash',
      LLM_MODEL_STRONG: 'gemini-3.8-flash',
      LLM_PRICING_VERSION: 'gemini-free-2026-10-23',
    };
    expect(() => validateEnvironment(base)).not.toThrow();
    expect(() =>
      validateEnvironment({ ...base, LLM_MODEL_STRONG: undefined }),
    ).toThrow(/LLM_MODEL_STRONG is required/);
    expect(() =>
      validateEnvironment({
        ...base,
        LLM_BASE_URL: 'http://llm.example.test/v1',
      }),
    ).toThrow(/must use https/);
    expect(() =>
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        LLM_BASE_URL: 'http://localhost:11434/v1',
        LLM_PRICING_VERSION: 'local-free-2026-10-23',
      }),
    ).toThrow(/must use https/);
    expect(() =>
      validateEnvironment({
        ...base,
        LLM_BASE_URL: 'https://u:p@llm.example.test',
      }),
    ).toThrow(/credentials/);
    expect(() =>
      validateEnvironment({ ...base, LLM_MODEL_FAST: 'gemini-4-argon' }),
    ).toThrow(/no price/);
    expect(() =>
      validateEnvironment({
        ...base,
        LLM_TURN_TOKEN_BUDGET: '2000000',
        LLM_CONVERSATION_TOKEN_BUDGET: '1000000',
      }),
    ).toThrow(/LLM_TURN_TOKEN_BUDGET/);
    expect(
      validateEnvironment({
        ...base,
        LLM_TRUSTED_PROVIDERS: 'mock, openai-compatible',
        LLM_ALLOW_REAL_CUSTOMER_DATA: 'true',
      }),
    ).toMatchObject({
      LLM_TRUSTED_PROVIDERS: ['mock', 'openai-compatible'],
      LLM_ALLOW_REAL_CUSTOMER_DATA: true,
    });
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

  it('pins every session to UTC so stored instants match the JS clock (DEF-007)', () => {
    const config = parsePostgresEnvironment(postgresEnvironment);
    expect(postgresPoolOptions(config, undefined).options).toBe(
      '-c TimeZone=UTC',
    );
    // PGOPTIONS is kept (node-postgres would otherwise drop it) and the UTC
    // pin comes last, so it wins over a TimeZone given there.
    expect(
      postgresPoolOptions(
        config,
        ' -c statement_timeout=5000 -c TimeZone=Asia/Tashkent ',
      ).options,
    ).toBe(
      '-c statement_timeout=5000 -c TimeZone=Asia/Tashkent -c TimeZone=UTC',
    );
  });
});
