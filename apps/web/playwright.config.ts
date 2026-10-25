import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 3010;
const API_PORT = 4010;

/**
 * Only the TEST_POSTGRES_* values are taken from the developer's .env (never
 * exported, so no Telegram or LLM secret can reach the servers below). In CI
 * they come from the environment.
 */
function fromDotenv(): Record<string, string> {
  const file = resolve(import.meta.dirname, '../../.env');
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^(TEST_POSTGRES_[A-Z_]+|REDIS_URL)=(.*)$/u.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/gu, '');
  }
  return values;
}
const source = { ...fromDotenv(), ...process.env } as Record<
  string,
  string | undefined
>;
const pg = (name: string, fallback = ''): string =>
  source[`TEST_POSTGRES_${name}`] ?? fallback;

/** A throwaway secret per test run, shared by the web server and the API. */
const PROXY_SECRET =
  process.env.E2E_PROXY_SECRET ??
  (process.env.E2E_PROXY_SECRET = randomBytes(24).toString('hex'));

export const E2E_ENV = {
  WEB_PROXY_SECRET: PROXY_SECRET,
  ENV_FILE: resolve(import.meta.dirname, 'e2e/empty.env'),
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  API_HOST: '127.0.0.1',
  SESSION_COOKIE_SECURE: 'false',
  WEB_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
  // Streams are recycled quickly so the tests exercise real reconnects.
  INBOX_STREAM_MAX_MS: '6000',
  // Each browser context is a distinct client (see helpers: X-Forwarded-For
  // as set by a simulated edge proxy), so a realistic limit can stay on.
  LOGIN_RATE_LIMIT_PER_MINUTE: '10',
  LLM_PROVIDER: 'mock',
  // The offline test embedder lets the FAQ page save without any provider.
  KNOWLEDGE_EMBEDDINGS: 'hashing',
  LLM_TRUSTED_PROVIDERS: 'mock',
  POSTGRES_HOST: pg('HOST', 'localhost'),
  POSTGRES_PORT: pg('PORT', '5432'),
  POSTGRES_DATABASE: pg('DATABASE', 'agentcore_test'),
  POSTGRES_USER: pg('USER'),
  POSTGRES_PASSWORD: pg('PASSWORD'),
  POSTGRES_SSL_MODE: pg('SSL_MODE', 'disable'),
  REDIS_URL: source.REDIS_URL ?? 'redis://localhost:6379',
};

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: resolve(import.meta.dirname, '../api'),
      url: `http://127.0.0.1:${API_PORT}/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'next build && node server.mjs',
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${WEB_PORT}/login`,
      env: {
        API_URL: `http://127.0.0.1:${API_PORT}`,
        NODE_ENV: 'production',
        PORT: String(WEB_PORT),
        HOSTNAME: '127.0.0.1',
        WEB_PROXY_SECRET: PROXY_SECRET,
        // The tests play the part of one edge proxy that appends the client.
        TRUSTED_PROXY_HOPS: '1',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
