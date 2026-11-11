import { Pool, type PoolClient } from 'pg';
import type { SqlDriver, SqlExecutor, SqlValue } from './driver';
import { normalizePostgresUrl } from './postgres-url';

const CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_POOL_SIZE = 10;
// On Vercel the default is smaller (many instances, each with its own pool) and idle connections are closed soon:
// an instance can be frozen between requests and its sockets go stale.
const VERCEL_DEFAULT_POOL_SIZE = 5;
const VERCEL_IDLE_TIMEOUT_MS = 5000;

function toPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

function executor(target: Pick<PoolClient, 'query'>): SqlExecutor {
  return {
    async query<T>(sql: string, params: SqlValue[] = []) {
      const result = await target.query(toPostgres(sql), params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await target.query(sql);
    },
  };
}

/**
 * SSL is set in the URL itself, with `sslmode`; Neon's `channel_binding=require` becomes `enableChannelBinding`
 * (`postgres-url.ts`). The URL contains the password: it is never logged.
 */
export function openPostgres(url: string, poolSize?: number): SqlDriver {
  const vercel = process.env.VERCEL === '1';
  const { connectionString, enableChannelBinding } = normalizePostgresUrl(url);
  const pool = new Pool({
    connectionString,
    enableChannelBinding,
    max: poolSize ?? (vercel ? VERCEL_DEFAULT_POOL_SIZE : DEFAULT_POOL_SIZE),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ...(vercel ? { idleTimeoutMillis: VERCEL_IDLE_TIMEOUT_MS } : {}),
  });
  // Without this handler, an error on an idle connection crashes the process.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(`Postgres: error on an idle connection (${error.code ?? 'no code'})`);
  });

  return {
    dialect: 'postgres',
    ...executor(pool),
    async transaction(run) {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await run(executor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        failure = error as Error;
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release(failure);
      }
    },
    close: () => pool.end(),
  };
}
