import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SqlDriver, SqlValue } from './driver';
import { normalizePostgresUrl } from './postgres-url';

const CONNECTION_TIMEOUT_MS = 10_000;
// On Vercel an instance can be frozen between requests: idle connections are closed soon instead of going stale.
const VERCEL_IDLE_TIMEOUT_MS = 5000;
const DEFAULT_POOL_SIZE = 5;
const MAX_POOL_SIZE = 200;
// Serialises the schema across instances that start at the same time. Distinct from the vault's key.
const SCHEMA_LOCK_KEY = 5190237461;

// Same tables as `sqlite.ts`; timestamps are `BIGINT` (milliseconds), flags stay `INTEGER` 0/1 so the queries are
// identical in both dialects.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    scrypt_n INTEGER NOT NULL,
    scrypt_r INTEGER NOT NULL,
    scrypt_p INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    totp_secret_enc TEXT,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at BIGINT NOT NULL,
    second_factor_done INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start BIGINT NOT NULL,
    hits INTEGER NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_limits_expires_at ON rate_limits (expires_at);
`;

/** `DATABASE_POOL_SIZE`: connections per instance. Unset or empty: 5. */
export function poolSize(raw: string | undefined = process.env.DATABASE_POOL_SIZE): number {
  if (raw === undefined || raw === '') return DEFAULT_POOL_SIZE;
  const size = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(size) || size < 1 || size > MAX_POOL_SIZE) throw new Error(`DATABASE_POOL_SIZE must be an integer from 1 to ${MAX_POOL_SIZE}`);
  return size;
}

function toPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

async function applySchema(pool: Pool): Promise<void> {
  const client: PoolClient = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
    await client.query(SCHEMA);
    await client.query('COMMIT');
  } catch (error) {
    failure = error as Error;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release(failure);
  }
}

/** Opens the pool and applies the schema. The URL contains the password: it is never logged. */
export async function openPostgres(url: string): Promise<SqlDriver> {
  const { connectionString, enableChannelBinding } = normalizePostgresUrl(url);
  const config: PoolConfig = { connectionString, max: poolSize(), connectionTimeoutMillis: CONNECTION_TIMEOUT_MS };
  if (enableChannelBinding) config.enableChannelBinding = true;
  if (process.env.VERCEL === '1') config.idleTimeoutMillis = VERCEL_IDLE_TIMEOUT_MS;
  const pool = new Pool(config);
  // Without this handler, an error on an idle connection crashes the process.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(`Postgres: error on an idle connection (${error.code ?? 'no code'})`);
  });

  try {
    await applySchema(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  return {
    dialect: 'postgres',
    async query<T>(sql: string, params: SqlValue[] = []) {
      const result = await pool.query(toPostgres(sql), params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    close: () => pool.end(),
  };
}
