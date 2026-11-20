import { configDefaults, defineConfig } from 'vitest/config';

/**
 * RLS plan S8/S8b: every integration spec runs in strict mode with the code
 * under test on a NOBYPASSRLS role (`persistence/testing/test-clients.ts`):
 * fixtures use `ownerClient()`, the code under test `appClient()`, and calls
 * set the tenant as production does. A new spec is covered without being
 * listed (a hand-kept list let the sales site's plan list miss strict mode,
 * 2026-11-20). Only these stay out, each for the reason given:
 */
const NOT_STRICT = [
  // Infrastructure: they test the RLS and persistence machinery itself.
  'src/persistence/rls.integration.spec.ts',
  'src/persistence/tenant-adapter.integration.spec.ts',
  'src/persistence/persistence.integration.spec.ts',
  'src/persistence/timestamp-offset.integration.spec.ts',
  'src/persistence/shutdown-order.integration.spec.ts',
  'src/app.startup.integration.spec.ts',
  // Redis only: no database statement to scope.
  'src/channels/instagram/instagram-oauth-state-ledger.integration.spec.ts',
  // Dev and ops CLI scripts run as the owner by design.
  'src/dev/dev-superadmin.integration.spec.ts',
  'src/dev/test-account.integration.spec.ts',
  'src/ops/demo-catalog.integration.spec.ts',
  'src/ops/tenant-owner.integration.spec.ts',
  'src/platform/reset-platform-admin-mfa.integration.spec.ts',
];

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    exclude: [...configDefaults.exclude, ...NOT_STRICT],
    globalSetup: ['src/persistence/testing/rls-strict.global-setup.ts'],
    env: { TEST_RLS_STRICT: '1' },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
