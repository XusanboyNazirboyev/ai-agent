import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    // Integration files share one PostgreSQL test database and one Redis
    // queue; two queue runtimes in parallel files would consume each
    // other's jobs.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
