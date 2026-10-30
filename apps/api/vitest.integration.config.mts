import { defineConfig } from 'vitest/config';
import { randomUUID } from 'node:crypto';

const testRunId = process.env.BULLMQ_PREFIX?.trim()
  ? process.env.BULLMQ_PREFIX.trim()
  : `agentcore-test-${randomUUID()}`;
process.env.BULLMQ_PREFIX = testRunId;

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    // Integration files share one PostgreSQL test database and one Redis
    // queue; two queue runtimes in parallel files would consume each
    // other's jobs.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { BULLMQ_PREFIX: testRunId },
  },
});
