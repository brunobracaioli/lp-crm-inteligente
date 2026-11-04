import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real Postgres from `supabase start` (one local stack per machine, see
 * docs/plan/implementation-waves.md). Files run sequentially because they share one database.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
