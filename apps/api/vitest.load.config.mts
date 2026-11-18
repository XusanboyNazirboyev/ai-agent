import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Opt-in load test (LOAD_TEST=1): the real app against agentcore_test.
    include: ['src/testing/load/**/*.load.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 60_000,
  },
});
