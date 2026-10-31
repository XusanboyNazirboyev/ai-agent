import { defineConfig } from 'vitest/config';
import { randomUUID } from 'node:crypto';

const testRunId = `agentcore-test-${randomUUID()}`;
process.env.BULLMQ_PREFIX = testRunId;

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    fileParallelism: false,
    env: { BULLMQ_PREFIX: testRunId },
    // Integration files share one PostgreSQL test database and one Redis
    // queue; two queue runtimes in parallel files would consume each
    // other's jobs.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
