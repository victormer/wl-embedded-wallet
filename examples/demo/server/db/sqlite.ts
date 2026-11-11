import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from './driver';

const BUSY_TIMEOUT_MS = 5000;
const READS = /^\s*(SELECT|PRAGMA)\b/i;
// A write with `RETURNING` hands back its rows, like a read.
const RETURNING = /\bRETURNING\b/i;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    scrypt_n INTEGER NOT NULL,
    scrypt_r INTEGER NOT NULL,
    scrypt_p INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    totp_secret_enc TEXT,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    second_factor_done INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    hits INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_limits_expires_at ON rate_limits (expires_at);
`;

/**
 * Databases created before 2FA. Their accounts set it up on the next login, and their sessions stop being valid.
 * Before `totp_last_step`, no step was recorded: the next valid code is accepted and starts the record.
 */
function addMissingColumns(database: DatabaseSync): void {
  const has = (table: string, column: string) =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
  if (!has('users', 'totp_secret_enc')) database.exec('ALTER TABLE users ADD COLUMN totp_secret_enc TEXT');
  if (!has('users', 'totp_confirmed')) database.exec('ALTER TABLE users ADD COLUMN totp_confirmed INTEGER NOT NULL DEFAULT 0');
  if (!has('users', 'totp_last_step')) database.exec('ALTER TABLE users ADD COLUMN totp_last_step INTEGER');
  if (!has('sessions', 'second_factor_done')) database.exec('ALTER TABLE sessions ADD COLUMN second_factor_done INTEGER NOT NULL DEFAULT 0');
}

/**
 * Local development, unit tests and e2e. One synchronous connection: each statement runs to completion before the
 * next one starts, so a conditional UPDATE is atomic against concurrent requests in this process.
 */
export function openSqlite(path: string): SqlDriver {
  // `turbopackIgnore`: without it, a dynamic path makes Next include the whole project in the output.
  mkdirSync(/*turbopackIgnore: true*/ dirname(path), { recursive: true });
  closeSync(openSync(/*turbopackIgnore: true*/ path, 'a', 0o600));
  chmodSync(/*turbopackIgnore: true*/ path, 0o600);
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    database.exec(SCHEMA);
    addMissingColumns(database);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    dialect: 'sqlite',
    async query<T>(sql: string, params: SqlValue[] = []) {
      const statement = database.prepare(sql);
      if (READS.test(sql) || RETURNING.test(sql)) {
        const rows = statement.all(...params) as T[];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: Number(statement.run(...params).changes) };
    },
    async close() {
      database.close();
    },
  };
}
