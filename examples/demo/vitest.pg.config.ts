import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Launched by `pnpm test:pg` (`apps/vault/tests/pg/run.mjs`), which starts a throwaway Postgres and exports
// TEST_DATABASE_URL. The suites share that database and truncate it between tests: no parallelism.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/unit/db.test.ts', 'tests/unit/api.test.ts', 'tests/unit/rate-limit.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
