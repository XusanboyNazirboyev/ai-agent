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
  'src/retention/retention.integration.spec.ts',
  'src/pipelines/pipelines.integration.spec.ts',
  'src/pipelines/funnel.integration.spec.ts',
  'src/persons/person-merge.integration.spec.ts',
  'src/tags/tags.integration.spec.ts',
  'src/handover/phase5.integration.spec.ts',
  'src/channels/instagram/instagram-flow.integration.spec.ts',
  'src/webinbox/inbox-last-message.integration.spec.ts',
  'src/webinbox/canned-responses.integration.spec.ts',
  'src/webinbox/audit-log.integration.spec.ts',
  'src/webinbox/conversation-tags.integration.spec.ts',
  'src/webinbox/inbox-waiting-order.integration.spec.ts',
  'src/webinbox/today.integration.spec.ts',
  'src/webinbox/crm-template.integration.spec.ts',
  'src/webinbox/lead-archive.integration.spec.ts',
  'src/webinbox/manual-lead.integration.spec.ts',
  'src/webinbox/test-chat.integration.spec.ts',
  'src/webinbox/suggest-reply.integration.spec.ts',
  'src/webinbox/sheet-catalog.integration.spec.ts',
  'src/webinbox/connector-roles.integration.spec.ts',
  'src/webinbox/connectors.integration.spec.ts',
  'src/webinbox/analytics.integration.spec.ts',
  'src/webinbox/facebook-connect.integration.spec.ts',
  'src/webinbox/telegram-connect.integration.spec.ts',
  'src/webinbox/instagram-connect.integration.spec.ts',
  'src/webinbox/login-limit.integration.spec.ts',
  'src/webinbox/webinbox.integration.spec.ts',
  'src/handover/operator-api.integration.spec.ts',
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
