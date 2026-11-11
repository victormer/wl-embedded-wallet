import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, getUserById } from '@/server/db';

/** Set by `apps/vault/tests/pg/run.mjs` (`pnpm test:pg`): the suites then run against that Postgres. */
export const postgresUrl = process.env.TEST_DATABASE_URL || undefined;

export interface TestDatabase {
  /** Empty tables: a new SQLite file, or `TRUNCATE` on Postgres. */
  reset(): Promise<void>;
  /** Raw read, for asserting what is stored. No parameters. */
  rows(sql: string): Promise<Record<string, unknown>[]>;
  dispose(): Promise<void>;
}

/**
 * Points the demo at a test database: Postgres when `TEST_DATABASE_URL` is set, otherwise a temporary SQLite file.
 * Clears the variables that would select another backend, so a value in the developer's shell never leaks in.
 */
export function useTestDatabase(): TestDatabase {
  delete process.env.VERCEL;
  delete process.env.VERCEL_REGION;
  delete process.env.DATABASE_POOL_SIZE;

  if (postgresUrl) {
    process.env.DATABASE_URL = postgresUrl;
    delete process.env.DB_PATH;
    const run = async (sql: string) => {
      const { Client } = (await import('pg')).default;
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        return (await client.query(sql)).rows as Record<string, unknown>[];
      } finally {
        await client.end();
      }
    };
    return {
      async reset() {
        // Opens the pool, which creates the schema, before emptying it.
        await getUserById('schema');
        await run('TRUNCATE rate_limits, sessions, users');
      },
      rows: run,
      dispose: closeDb,
    };
  }

  process.env.DATABASE_URL = '';
  const dir = mkdtempSync(join(tmpdir(), 'demo-test-'));
  let count = 0;
  const point = () => {
    process.env.DB_PATH = join(dir, `demo-${(count += 1)}.db`);
  };
  point();
  return {
    async reset() {
      await closeDb();
      point();
    },
    async rows(sql) {
      const database = new DatabaseSync(process.env.DB_PATH as string, { readOnly: true });
      try {
        return database.prepare(sql).all() as Record<string, unknown>[];
      } finally {
        database.close();
      }
    },
    async dispose() {
      await closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
