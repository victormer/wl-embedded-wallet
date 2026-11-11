import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDriver } from './driver';

export { normalizePostgresUrl, type NormalizedPostgresUrl } from './postgres-url';

export const SESSION_TTL_MS = 60 * 60 * 1000;
// Correct password, but second factor not completed yet.
const PENDING_SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_DB_PATH = 'data/demo.db';
const POSTGRES_URL = /^postgres(ql)?:\/\//;
const RATE_LIMIT_PURGE_INTERVAL_MS = 60_000;
const RATE_LIMIT_PURGE_BATCH = 500;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  params: ScryptParams;
  /** Encrypted with `sealTotpSecret`. */
  totpSecretEnc: string | null;
  totpConfirmed: boolean;
  /** Time step of the last accepted code, so that each code works only once. */
  totpLastStep: number | null;
}

type Target = { kind: 'postgres'; url: string } | { kind: 'sqlite'; path: string };

/**
 * `DATABASE_URL` (postgres:// or postgresql://) selects Postgres; unset or empty, SQLite at `DB_PATH`. Messages never
 * include the URL: it carries the password. On Vercel the filesystem is read-only and per instance, so a database is
 * required there rather than silently falling back to a throwaway file.
 */
function target(): Target {
  const url = process.env.DATABASE_URL;
  if (url) {
    if (!POSTGRES_URL.test(url)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
    return { kind: 'postgres', url };
  }
  if (process.env.VERCEL === '1') throw new Error('DATABASE_URL is required on Vercel');
  return { kind: 'sqlite', path: process.env.DB_PATH || DEFAULT_DB_PATH };
}

/** Each backend is loaded only if used: a Postgres deployment never opens `node:sqlite` or touches the filesystem. */
async function open(selected: Target): Promise<SqlDriver> {
  if (selected.kind === 'postgres') return (await import('./postgres')).openPostgres(selected.url);
  return (await import('./sqlite')).openSqlite(selected.path);
}

// Kept on `globalThis` so hot reload, which re-instantiates the module, does not open another connection.
const holder = globalThis as typeof globalThis & { __demoDb?: { key: string; driver: Promise<SqlDriver> } };

async function db(): Promise<SqlDriver> {
  const selected = target();
  const key = selected.kind === 'postgres' ? `postgres:${selected.url}` : `sqlite:${selected.path}`;
  if (holder.__demoDb?.key === key) return holder.__demoDb.driver;
  await closeDb();
  const driver = open(selected);
  holder.__demoDb = { key, driver };
  // A failure is not cached: the database may come back.
  driver.catch(() => {
    if (holder.__demoDb?.driver === driver) holder.__demoDb = undefined;
  });
  return driver;
}

export async function closeDb(): Promise<void> {
  const current = holder.__demoDb;
  holder.__demoDb = undefined;
  await current?.driver.then((driver) => driver.close()).catch(() => undefined);
}

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  scrypt_n: number;
  scrypt_r: number;
  scrypt_p: number;
  totp_secret_enc: string | null;
  totp_confirmed: number;
  totp_last_step: number | string | null;
};

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    params: { N: Number(row.scrypt_n), r: Number(row.scrypt_r), p: Number(row.scrypt_p) },
    totpSecretEnc: row.totp_secret_enc,
    totpConfirmed: Number(row.totp_confirmed) === 1,
    totpLastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
  };
}

/* Users */

/** Returns `null` if the email already exists. */
export async function createUser(input: { email: string; passwordHash: string; passwordSalt: string; params: ScryptParams }): Promise<UserRecord | null> {
  const id = randomUUID();
  const { rowCount } = await (await db()).query(
    `INSERT INTO users (id, email, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
    [id, input.email, input.passwordHash, input.passwordSalt, input.params.N, input.params.r, input.params.p, Date.now()],
  );
  return rowCount === 0 ? null : getUserById(id);
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const { rows } = await (await db()).query<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const { rows } = await (await db()).query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

/* Second factor */

/** Fails (`false`) if it is already confirmed: someone with only the password cannot replace it. */
export async function setTotpSecret(userId: string, totpSecretEnc: string): Promise<boolean> {
  const { rowCount } = await (await db()).query('UPDATE users SET totp_secret_enc = ? WHERE id = ? AND totp_confirmed = 0', [totpSecretEnc, userId]);
  return rowCount === 1;
}

export async function confirmTotp(userId: string, totpSecretEnc: string): Promise<boolean> {
  const { rowCount } = await (await db()).query('UPDATE users SET totp_confirmed = 1 WHERE id = ? AND totp_secret_enc = ?', [userId, totpSecretEnc]);
  return rowCount === 1;
}

/**
 * Records the time step of an accepted code. `false` if that step or a later one was already accepted. A single
 * conditional UPDATE, so two concurrent requests with the same code cannot both succeed.
 */
export async function consumeTotpStep(userId: string, step: number): Promise<boolean> {
  const { rowCount } = await (await db()).query(
    'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
    [step, userId, step],
  );
  return rowCount === 1;
}

/* Sessions: the database only stores the token hash. */

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string, options: { secondFactorDone: boolean }): Promise<string> {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const database = await db();
  const ttl = options.secondFactorDone ? SESSION_TTL_MS : PENDING_SESSION_TTL_MS;
  await database.query('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  await database.query('INSERT INTO sessions (token_hash, user_id, expires_at, second_factor_done) VALUES (?, ?, ?, ?)', [
    tokenHash(token),
    userId,
    Date.now() + ttl,
    options.secondFactorDone ? 1 : 0,
  ]);
  return token;
}

async function sessionUserBy(token: string, secondFactorDone: boolean): Promise<UserRecord | null> {
  const { rows } = await (await db()).query<{ user_id: string }>(
    'SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ? AND second_factor_done = ?',
    [tokenHash(token), Date.now(), secondFactorDone ? 1 : 0],
  );
  return rows[0] ? getUserById(rows[0].user_id) : null;
}

/** Only a session with the second factor completed. */
export function getUserBySession(token: string): Promise<UserRecord | null> {
  return sessionUserBy(token, true);
}

/** The intermediate session: it can only be used to complete the second factor. */
export function getUserByPendingSession(token: string): Promise<UserRecord | null> {
  return sessionUserBy(token, false);
}

export async function deleteSession(token: string): Promise<void> {
  await (await db()).query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
}

/* Rate limits */

let lastRateLimitPurge = 0;

/**
 * Counts one hit on `bucket` in the current fixed window of `windowMs`. Returns the hits so far in that window,
 * this one included, and when the window ends.
 */
export async function hitRateLimit(bucket: string, windowMs: number): Promise<{ hits: number; resetAt: number }> {
  const database = await db();
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  if (now - lastRateLimitPurge >= RATE_LIMIT_PURGE_INTERVAL_MS) {
    lastRateLimitPurge = now;
    await database.query('DELETE FROM rate_limits WHERE bucket IN (SELECT bucket FROM rate_limits WHERE expires_at <= ? LIMIT ?)', [now, RATE_LIMIT_PURGE_BATCH]);
  }
  // A single statement: concurrent hits on a bucket each get a different count. An instance whose clock lags
  // behind (an older window) adds to the newer window instead of resetting it.
  const { rows } = await database.query<{ hits: number | string; window_start: number | string }>(
    `INSERT INTO rate_limits (bucket, window_start, hits, expires_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start >= excluded.window_start THEN rate_limits.hits + 1 ELSE 1 END,
       window_start = CASE WHEN rate_limits.window_start >= excluded.window_start THEN rate_limits.window_start ELSE excluded.window_start END,
       expires_at = CASE WHEN rate_limits.expires_at >= excluded.expires_at THEN rate_limits.expires_at ELSE excluded.expires_at END
     RETURNING hits, window_start`,
    [bucket, windowStart, windowStart + windowMs],
  );
  const row = rows[0];
  return { hits: Number(row.hits), resetAt: Number(row.window_start) + windowMs };
}
