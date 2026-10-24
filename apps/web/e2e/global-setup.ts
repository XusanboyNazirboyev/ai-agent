import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_ENV } from '../playwright.config';

export const FIXTURE_FILE = resolve(
  import.meta.dirname,
  '../.e2e/fixtures.json',
);

/** Seeds two fake tenants in agentcore_test (never anything else). */
export default function globalSetup(): void {
  mkdirSync(resolve(import.meta.dirname, '../.e2e'), { recursive: true });
  execFileSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/e2e-fixtures.ts', 'seed', FIXTURE_FILE],
    {
      cwd: resolve(import.meta.dirname, '../../api'),
      env: {
        ...process.env,
        TEST_POSTGRES_HOST: E2E_ENV.POSTGRES_HOST,
        TEST_POSTGRES_PORT: E2E_ENV.POSTGRES_PORT,
        TEST_POSTGRES_DATABASE: E2E_ENV.POSTGRES_DATABASE,
        TEST_POSTGRES_USER: E2E_ENV.POSTGRES_USER,
        TEST_POSTGRES_PASSWORD: E2E_ENV.POSTGRES_PASSWORD,
        TEST_POSTGRES_SSL_MODE: E2E_ENV.POSTGRES_SSL_MODE,
      },
      stdio: 'inherit',
    },
  );
}
