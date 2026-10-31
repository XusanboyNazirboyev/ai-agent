import { defineConfig } from 'vitest/config';
import { randomUUID } from 'node:crypto';

const testRunId = `agentcore-test-${randomUUID()}`;
process.env.BULLMQ_PREFIX = testRunId;

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    // Integration files share one PostgreSQL test database and one Redis
    // queue; two queue runtimes in parallel files would consume each
    // other's jobs.
    fileParallelism: false,
    env: { BULLMQ_PREFIX: testRunId },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
