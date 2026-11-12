import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Launched by `tests/pg/run.mjs`, which starts the temporary Postgres. The tests share a database: no parallelism.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    // Every suite on the route harness (`tests/unit/route-harness.ts`), plus `api.test.ts`, which resets the same way.
    include: [
      'tests/pg/**/*.test.ts',
      'tests/unit/api.test.ts',
      'tests/unit/passkey-recovery.test.ts',
      'tests/unit/relink.test.ts',
      'tests/unit/aa-rpc.test.ts',
      'tests/unit/transactions.test.ts',
      'tests/unit/body-limit.test.ts',
      'tests/unit/share-a.test.ts',
      'tests/unit/s2s.test.ts',
      'tests/unit/route-limits.test.ts',
    ],
    testTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
