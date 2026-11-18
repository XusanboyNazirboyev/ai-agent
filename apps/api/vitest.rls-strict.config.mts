import { defineConfig } from 'vitest/config';

/**
 * RLS plan S8/S8b: integration specs that run in strict mode with the code
 * under test on a NOBYPASSRLS role (`persistence/testing/test-clients.ts`).
 * A spec joins this list once its fixtures use `ownerClient()`, the code
 * under test `appClient()`, and its calls set the tenant as production does.
 */
const STRICT_SPECS = [
  'src/persistence/rls-http-context.integration.spec.ts',
  'src/persistence/rls-background.integration.spec.ts',
  'src/handover/handover.integration.spec.ts',
  'src/persons/person-identity.integration.spec.ts',
  'src/channels/telegram/telegram-agent.integration.spec.ts',
];

export default defineConfig({
  test: {
    include: STRICT_SPECS,
    globalSetup: ['src/persistence/testing/rls-strict.global-setup.ts'],
    env: { TEST_RLS_STRICT: '1' },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
