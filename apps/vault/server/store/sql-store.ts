import { b64urlEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import type { Envelope, Manifest } from '@wl-embedded-wallet/core/types';
import type { SqlDriver, SqlExecutor } from './driver';
import {
  SESSION_TTL_MS,
  type PreparedTransactionRecord,
  type PreparedTransactionStatus,
  type RelinkNonceRecord,
  type SessionRecord,
  type SetStatus,
  type ShareAReleaseRecord,
  type ShareSetRecord,
  type SponsoredDeploymentRecord,
  type SponsoredDeploymentStatus,
  type UserRecord,
  type VaultStore,
  type WalletRelinkRecord,
  type WebauthnPurpose,
} from './types';

const SESSION_TOKEN_BYTES = 32;
// Expired rate-limit buckets are purged at most this often per connection, and at most this many at a time.
const RATE_LIMIT_PURGE_INTERVAL_MS = 60_000;
const RATE_LIMIT_PURGE_BATCH = 1000;
// Transaction-level locks that serialize challenge creation per purpose when there is a cap. Next to the migration lock.
const CHALLENGE_LOCK_KEYS: Record<WebauthnPurpose, number> = { register: 7_238_104_562, recover: 7_238_104_563 };

type UserRow = { user_id: string; label: string; exported_at: string | null };
// Postgres returns `BIGINT` as a string.
type SessionRow = { user_id: string; app_origin: string | null; expires_at: number | string; chain_id: number | string | null; rpc_url: string | null };
type SetRow = {
  set_id: string;
  user_id: string;
  status: SetStatus;
  credential_id: string;
  manifest: string;
  signature: string;
  enc_a: string | null;
  enc_b: string | null;
  enc_c: string | null;
  created_at: string;
  credential_public_key: string | null;
  credential_counter: number | string;
  created_session_hash: string | null;
};
type RelinkNonceRow = { nonce: string; user_id: string; safe: string; owner: string; from_user: string | null; expires_at: number | string };
type ReleaseRow = { user_id: string; set_id: string; set_status: 'pending' | 'active'; session_hash: string; app_origin: string | null; released_at: string };
type DeploymentRow = {
  chain_id: number | string;
  safe: string;
  user_id: string;
  status: SponsoredDeploymentStatus;
  operation: string;
  operation_hash: string;
  user_op_hash: string | null;
  prepared_at: number | string;
  updated_at: number | string;
};
type PreparedTransactionRow = {
  chain_id: number | string;
  safe: string;
  user_id: string;
  operation_hash: string;
  status: PreparedTransactionStatus;
  operation: string;
  sponsored: number | string;
  user_op_hash: string | null;
  prepared_at: number | string;
  updated_at: number | string;
};
type RelinkRow = {
  safe: string;
  owner: string;
  old_sub: string;
  new_sub: string;
  issuer: string;
  vault_origin: string;
  app_origin: string | null;
  nonce: string;
  signature: string;
  linked_at: string;
};

function toSet(row: SetRow | undefined): ShareSetRecord | null {
  if (!row) return null;
  const record: ShareSetRecord = {
    setId: row.set_id,
    userId: row.user_id,
    status: row.status,
    credentialId: row.credential_id,
    manifest: JSON.parse(row.manifest) as Manifest,
    signature: row.signature,
    createdAt: row.created_at,
  };
  if (row.enc_a) record.encA = JSON.parse(row.enc_a) as Envelope;
  if (row.enc_b) record.encB = JSON.parse(row.enc_b) as Envelope;
  if (row.enc_c) record.encC = JSON.parse(row.enc_c) as Envelope;
  if (row.credential_public_key) record.credential = { publicKey: row.credential_public_key, counter: Number(row.credential_counter) };
  if (row.created_session_hash) record.createdSessionHash = row.created_session_hash;
  return record;
}

function toDeployment(row: DeploymentRow): SponsoredDeploymentRecord {
  return {
    chainId: Number(row.chain_id),
    safe: row.safe,
    userId: row.user_id,
    status: row.status,
    operation: row.operation,
    operationHash: row.operation_hash,
    userOpHash: row.user_op_hash,
    preparedAt: Number(row.prepared_at),
    updatedAt: Number(row.updated_at),
  };
}

function toPreparedTransaction(row: PreparedTransactionRow): PreparedTransactionRecord {
  return {
    chainId: Number(row.chain_id),
    safe: row.safe,
    userId: row.user_id,
    operationHash: row.operation_hash,
    status: row.status,
    operation: row.operation,
    sponsored: Number(row.sponsored) === 1,
    userOpHash: row.user_op_hash,
    preparedAt: Number(row.prepared_at),
    updatedAt: Number(row.updated_at),
  };
}

function toRelinkNonce(row: RelinkNonceRow): RelinkNonceRecord {
  return { nonce: row.nonce, userId: row.user_id, safe: row.safe, owner: row.owner, fromUser: row.from_user, expiresAt: Number(row.expires_at) };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function selectSet(db: SqlExecutor, userId: string, setId: string): Promise<ShareSetRecord | null> {
  const { rows } = await db.query<SetRow>('SELECT * FROM share_sets WHERE set_id = ? AND user_id = ?', [setId, userId]);
  return toSet(rows[0]);
}

async function selectActiveSet(db: SqlExecutor, userId: string): Promise<ShareSetRecord | null> {
  const { rows } = await db.query<SetRow>(`SELECT * FROM share_sets WHERE user_id = ? AND status = 'active'`, [userId]);
  return toSet(rows[0]);
}

/** The same SQL in both dialects. The differences live in the drivers and the migrations. */
export function createSqlStore(driver: SqlDriver): VaultStore {
  let lastRateLimitPurge = 0;

  return {
    async ping() {
      await driver.query('SELECT 1');
    },

    close: () => driver.close(),

    /* Users */

    async upsertUser(userId, label) {
      await driver.query(
        `INSERT INTO users (user_id, label, created_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET label = excluded.label`,
        [userId, label, Date.now()],
      );
    },

    async getUser(userId): Promise<UserRecord | null> {
      const { rows } = await driver.query<UserRow>('SELECT * FROM users WHERE user_id = ?', [userId]);
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        label: row.label,
        exportedAt: row.exported_at,
      };
    },

    async markExported(userId, exportedAt) {
      const { rowCount } = await driver.query('UPDATE users SET exported_at = ? WHERE user_id = ?', [exportedAt, userId]);
      return rowCount === 1;
    },

    /* Sessions */

    async createSession(userId, options = {}) {
      const token = b64urlEncode(randomBytes(SESSION_TOKEN_BYTES));
      const now = Date.now();
      await driver.query('DELETE FROM sessions WHERE expires_at <= ?', [now]);
      await driver.query('INSERT INTO sessions (token, user_id, app_origin, expires_at) VALUES (?, ?, ?, ?)', [
        token,
        userId,
        options.appOrigin ?? null,
        now + (options.ttlMs ?? SESSION_TTL_MS),
      ]);
      return token;
    },

    async getSession(token): Promise<SessionRecord | null> {
      if (!token) return null;
      const { rows } = await driver.query<SessionRow>('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', [token, Date.now()]);
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        expiresAt: Number(row.expires_at),
        appOrigin: row.app_origin,
        chain: row.chain_id === null ? null : { chainId: Number(row.chain_id), rpcUrl: row.rpc_url },
      };
    },

    async setSessionChain(token, chain) {
      await driver.query('UPDATE sessions SET chain_id = ?, rpc_url = ? WHERE token = ?', [chain?.chainId ?? null, chain?.rpcUrl ?? null, token]);
    },

    async deleteSession(token) {
      await driver.query('DELETE FROM sessions WHERE token = ?', [token]);
    },

    /* Single-use jti */

    async consumeJti(jti, expiresAtMs) {
      const now = Date.now();
      await driver.query('DELETE FROM used_jti WHERE expires_at <= ?', [now]);
      // A single statement: of several concurrent ones with the same `jti`, only one writes a row.
      const { rowCount } = await driver.query(
        `INSERT INTO used_jti (jti, expires_at) VALUES (?, ?)
         ON CONFLICT (jti) DO UPDATE SET expires_at = excluded.expires_at WHERE used_jti.expires_at <= ?`,
        [jti, expiresAtMs, now],
      );
      return rowCount === 1;
    },

    /* Share sets */

    async createSet(record) {
      const { rowCount } = await driver.query(
        `INSERT INTO share_sets
           (set_id, user_id, status, credential_id, manifest, signature, enc_a, enc_b, enc_c, created_at, owner, credential_public_key, credential_counter, created_session_hash)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          record.setId,
          record.userId,
          record.credentialId,
          JSON.stringify(record.manifest),
          record.signature,
          JSON.stringify(record.encA),
          JSON.stringify(record.encB),
          JSON.stringify(record.encC),
          record.createdAt,
          record.manifest.expectedAddress.toLowerCase(),
          record.credential?.publicKey ?? null,
          record.credential?.counter ?? 0,
          record.createdSessionHash ?? null,
        ],
      );
      return rowCount === 1 ? { ...record, status: 'pending' } : null;
    },

    getSet: (userId, setId) => selectSet(driver, userId, setId),

    getActiveSet: (userId) => selectActiveSet(driver, userId),

    async getAccount(userId) {
      const set = await selectActiveSet(driver, userId);
      return { exists: set !== null, address: set?.manifest.smartAccount.address ?? null, owner: set?.manifest.expectedAddress ?? null };
    },

    activateSet(userId, setId) {
      return driver.transaction(async (tx) => {
        // Serializes a user's activations: the unique index alone would make the second one fail.
        if (driver.dialect === 'postgres') await tx.query('SELECT user_id FROM users WHERE user_id = ? FOR NO KEY UPDATE', [userId]);
        const set = await selectSet(tx, userId, setId);
        if (!set || set.status !== 'pending') return set;
        const active = await selectActiveSet(tx, userId);
        if (active && active.manifest.expectedAddress.toLowerCase() !== set.manifest.expectedAddress.toLowerCase()) return set;
        await tx.query(
          `UPDATE share_sets SET status = 'revoked', enc_a = NULL, enc_b = NULL, enc_c = NULL
           WHERE user_id = ? AND status = 'active'`,
          [userId],
        );
        await tx.query(`UPDATE share_sets SET status = 'active' WHERE set_id = ?`, [setId]);
        return selectSet(tx, userId, setId);
      });
    },

    async findActiveSetsByOwner(owner) {
      const { rows } = await driver.query<SetRow>(`SELECT * FROM share_sets WHERE owner = ? AND status = 'active'`, [owner.toLowerCase()]);
      return rows.map((row) => toSet(row) as ShareSetRecord);
    },

    /* WebAuthn */

    async createWebauthnChallenge(challenge, purpose, userId, ttlMs, maxLive) {
      const insert = 'INSERT INTO webauthn_challenges (challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)';
      if (maxLive === undefined) {
        const now = Date.now();
        await driver.query('DELETE FROM webauthn_challenges WHERE expires_at <= ?', [now]);
        await driver.query(insert, [challenge, purpose, userId, now + ttlMs]);
        return true;
      }
      // Count and insert in one transaction. In Postgres the lock makes concurrent creators wait, so the cap is exact;
      // in SQLite, `BEGIN IMMEDIATE` already serializes writers.
      return driver.transaction(async (tx) => {
        if (driver.dialect === 'postgres') await tx.query(`SELECT pg_advisory_xact_lock(${CHALLENGE_LOCK_KEYS[purpose]})`);
        const now = Date.now();
        await tx.query('DELETE FROM webauthn_challenges WHERE expires_at <= ?', [now]);
        const { rows } = await tx.query<{ live: number | string }>('SELECT COUNT(*) AS live FROM webauthn_challenges WHERE purpose = ? AND expires_at > ?', [purpose, now]);
        if (Number(rows[0]?.live ?? 0) >= maxLive) return false;
        await tx.query(insert, [challenge, purpose, userId, now + ttlMs]);
        return true;
      });
    },

    async consumeWebauthnChallenge(challenge, purpose, userId) {
      // A single statement: of several concurrent ones with the same challenge, only one deletes the row.
      const { rowCount } = await driver.query(
        `DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND expires_at > ? AND ${userId === null ? 'user_id IS NULL' : 'user_id = ?'}`,
        userId === null ? [challenge, purpose, Date.now()] : [challenge, purpose, Date.now(), userId],
      );
      return rowCount === 1;
    },

    async getActiveSetByCredential(credentialId) {
      const { rows } = await driver.query<SetRow>(
        `SELECT * FROM share_sets WHERE credential_id = ? AND status = 'active' AND credential_public_key IS NOT NULL`,
        [credentialId],
      );
      return toSet(rows[0]);
    },

    async advanceCredentialCounter(setId, expected, next) {
      const { rowCount } = await driver.query('UPDATE share_sets SET credential_counter = ? WHERE set_id = ? AND credential_counter = ?', [next, setId, expected]);
      return rowCount === 1;
    },

    /* Link to another account */

    async createRelinkNonce(record) {
      await driver.query('DELETE FROM relink_nonces WHERE expires_at <= ?', [Date.now()]);
      await driver.query('INSERT INTO relink_nonces (nonce, user_id, safe, owner, from_user, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
        record.nonce,
        record.userId,
        record.safe,
        record.owner,
        record.fromUser,
        record.expiresAt,
      ]);
    },

    async getRelinkNonce(nonce, userId) {
      const { rows } = await driver.query<RelinkNonceRow>('SELECT * FROM relink_nonces WHERE nonce = ? AND user_id = ? AND expires_at > ?', [nonce, userId, Date.now()]);
      return rows[0] ? toRelinkNonce(rows[0]) : null;
    },

    relinkWallet({ nonce, userId, signature, issuer, vaultOrigin, appOrigin }) {
      return driver.transaction(async (tx) => {
        const { rows } = await tx.query<RelinkNonceRow>('SELECT * FROM relink_nonces WHERE nonce = ? AND user_id = ? AND expires_at > ?', [nonce, userId, Date.now()]);
        if (!rows[0]) return 'NONCE_INVALID';
        const record = toRelinkNonce(rows[0]);
        // The nonce is spent even if the rest fails: the transaction only rolls back on an error.
        const { rowCount } = await tx.query('DELETE FROM relink_nonces WHERE nonce = ?', [nonce]);
        if (rowCount !== 1) return 'NONCE_INVALID';
        const { fromUser } = record;
        if (!fromUser || fromUser === userId) return 'STALE';
        // Serializes with other relinks and activations of both users. In a fixed order, to avoid deadlocks.
        if (driver.dialect === 'postgres') {
          await tx.query('SELECT user_id FROM users WHERE user_id IN (?, ?) ORDER BY user_id FOR NO KEY UPDATE', [fromUser, userId]);
        }
        const current = await selectActiveSet(tx, fromUser);
        if (!current || !sameAddress(current.manifest.expectedAddress, record.owner) || !sameAddress(current.manifest.smartAccount.address, record.safe)) return 'STALE';
        if (await selectActiveSet(tx, userId)) return 'HAS_WALLET';

        await tx.query('UPDATE share_sets SET user_id = ? WHERE user_id = ?', [userId, fromUser]);
        await tx.query('UPDATE users SET exported_at = (SELECT exported_at FROM users WHERE user_id = ?) WHERE user_id = ?', [fromUser, userId]);
        await tx.query('DELETE FROM sessions WHERE user_id = ?', [fromUser]);
        await tx.query(
          `INSERT INTO wallet_relinks (id, safe, owner, old_sub, new_sub, issuer, vault_origin, app_origin, nonce, signature, linked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), record.safe, record.owner.toLowerCase(), fromUser, userId, issuer, vaultOrigin, appOrigin, nonce, signature, new Date().toISOString()],
        );
        return 'LINKED';
      });
    },

    async listWalletRelinks(owner) {
      const { rows } = await driver.query<RelinkRow>('SELECT * FROM wallet_relinks WHERE owner = ? ORDER BY linked_at', [owner.toLowerCase()]);
      return rows.map(
        (row): WalletRelinkRecord => ({
          safe: row.safe,
          owner: row.owner,
          oldSub: row.old_sub,
          newSub: row.new_sub,
          issuer: row.issuer,
          vaultOrigin: row.vault_origin,
          appOrigin: row.app_origin,
          nonce: row.nonce,
          signature: row.signature,
          linkedAt: row.linked_at,
        }),
      );
    },

    /* Rate limits */

    async hitRateLimit(bucket, windowMs) {
      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      if (now - lastRateLimitPurge >= RATE_LIMIT_PURGE_INTERVAL_MS) {
        lastRateLimitPurge = now;
        await driver.query('DELETE FROM rate_limits WHERE bucket IN (SELECT bucket FROM rate_limits WHERE expires_at <= ? LIMIT ?)', [now, RATE_LIMIT_PURGE_BATCH]);
      }
      // A single statement: concurrent hits on a bucket each get a different count. A replica whose clock lags
      // behind (an older window) adds to the newer window instead of resetting it.
      const { rows } = await driver.query<{ hits: number | string; window_start: number | string }>(
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
    },

    /* Share A release audit */

    async recordShareARelease(record) {
      await driver.query(
        'INSERT INTO share_a_releases (id, user_id, set_id, set_status, session_hash, app_origin, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), record.userId, record.setId, record.setStatus, record.sessionHash, record.appOrigin, record.releasedAt],
      );
    },

    async listShareAReleases(userId) {
      const { rows } = await driver.query<ReleaseRow>('SELECT * FROM share_a_releases WHERE user_id = ? ORDER BY released_at', [userId]);
      return rows.map(
        (row): ShareAReleaseRecord => ({
          userId: row.user_id,
          setId: row.set_id,
          setStatus: row.set_status,
          sessionHash: row.session_hash,
          appOrigin: row.app_origin,
          releasedAt: row.released_at,
        }),
      );
    },

    /* Sponsored deployments */

    async getSponsoredDeployment(chainId, safe) {
      const { rows } = await driver.query<DeploymentRow>('SELECT * FROM sponsored_deployments WHERE chain_id = ? AND safe = ?', [chainId, safe.toLowerCase()]);
      return rows[0] ? toDeployment(rows[0]) : null;
    },

    async prepareSponsoredDeployment({ chainId, safe, userId, operation, operationHash, now, staleSubmittingMs, retrySentAfterMs }) {
      // A single statement: it never replaces an operation being submitted, or one sent recently.
      const { rowCount } = await driver.query(
        `INSERT INTO sponsored_deployments (chain_id, safe, user_id, status, operation, operation_hash, user_op_hash, prepared_at, updated_at)
         VALUES (?, ?, ?, 'prepared', ?, ?, NULL, ?, ?)
         ON CONFLICT (chain_id, safe) DO UPDATE SET
           user_id = excluded.user_id, status = 'prepared', operation = excluded.operation, operation_hash = excluded.operation_hash,
           user_op_hash = NULL, prepared_at = excluded.prepared_at, updated_at = excluded.updated_at
         WHERE sponsored_deployments.status = 'prepared'
           OR (sponsored_deployments.status = 'submitting' AND sponsored_deployments.updated_at <= ?)
           OR (sponsored_deployments.status = 'sent' AND sponsored_deployments.updated_at <= ?)`,
        [chainId, safe.toLowerCase(), userId, operation, operationHash, now, now, now - staleSubmittingMs, now - retrySentAfterMs],
      );
      return rowCount === 1;
    },

    async claimSponsoredDeployment({ chainId, safe, operationHash, now, staleSubmittingMs }) {
      // A single statement: of several concurrent claims, only one finds the row still claimable.
      const { rowCount } = await driver.query(
        `UPDATE sponsored_deployments SET status = 'submitting', updated_at = ?
         WHERE chain_id = ? AND safe = ? AND operation_hash = ?
           AND (status = 'prepared' OR (status = 'submitting' AND updated_at <= ?))`,
        [now, chainId, safe.toLowerCase(), operationHash, now - staleSubmittingMs],
      );
      return rowCount === 1;
    },

    async completeSponsoredDeployment({ chainId, safe, operationHash, userOpHash, now }) {
      const { rowCount } = await driver.query(
        `UPDATE sponsored_deployments SET status = 'sent', user_op_hash = ?, updated_at = ?
         WHERE chain_id = ? AND safe = ? AND operation_hash = ? AND status = 'submitting'`,
        [userOpHash, now, chainId, safe.toLowerCase(), operationHash],
      );
      return rowCount === 1;
    },

    async releaseSponsoredDeployment({ chainId, safe, operationHash, now }) {
      const { rowCount } = await driver.query(
        `UPDATE sponsored_deployments SET status = 'prepared', updated_at = ?
         WHERE chain_id = ? AND safe = ? AND operation_hash = ? AND status = 'submitting'`,
        [now, chainId, safe.toLowerCase(), operationHash],
      );
      return rowCount === 1;
    },

    /* Prepared transactions */

    async createPreparedTransaction({ chainId, safe, userId, operationHash, operation, sponsored, now, expireBefore }) {
      // Housekeeping first: an expired `prepared` row can no longer be sent. Never touches `submitting` or `sent` rows.
      await driver.query(`DELETE FROM prepared_transactions WHERE status = 'prepared' AND updated_at <= ?`, [expireBefore]);
      // A single statement: an existing row with that key is left as it is, whatever its status.
      const { rowCount } = await driver.query(
        `INSERT INTO prepared_transactions (chain_id, safe, user_id, operation_hash, status, operation, sponsored, user_op_hash, prepared_at, updated_at)
         VALUES (?, ?, ?, ?, 'prepared', ?, ?, NULL, ?, ?)
         ON CONFLICT (chain_id, safe, operation_hash) DO NOTHING`,
        [chainId, safe.toLowerCase(), userId, operationHash.toLowerCase(), operation, sponsored ? 1 : 0, now, now],
      );
      return rowCount === 1;
    },

    async getPreparedTransaction(chainId, safe, operationHash) {
      const { rows } = await driver.query<PreparedTransactionRow>(
        'SELECT * FROM prepared_transactions WHERE chain_id = ? AND safe = ? AND operation_hash = ?',
        [chainId, safe.toLowerCase(), operationHash.toLowerCase()],
      );
      return rows[0] ? toPreparedTransaction(rows[0]) : null;
    },

    async claimPreparedTransaction({ chainId, safe, operationHash, now, staleSubmittingMs }) {
      // A single statement: of several concurrent claims, only one finds the row still claimable.
      const { rowCount } = await driver.query(
        `UPDATE prepared_transactions SET status = 'submitting', updated_at = ?
         WHERE chain_id = ? AND safe = ? AND operation_hash = ?
           AND (status = 'prepared' OR (status = 'submitting' AND updated_at <= ?))`,
        [now, chainId, safe.toLowerCase(), operationHash.toLowerCase(), now - staleSubmittingMs],
      );
      return rowCount === 1;
    },

    async completePreparedTransaction({ chainId, safe, operationHash, userOpHash, now }) {
      const { rowCount } = await driver.query(
        `UPDATE prepared_transactions SET status = 'sent', user_op_hash = ?, updated_at = ?
         WHERE chain_id = ? AND safe = ? AND operation_hash = ? AND status = 'submitting'`,
        [userOpHash.toLowerCase(), now, chainId, safe.toLowerCase(), operationHash.toLowerCase()],
      );
      return rowCount === 1;
    },

    async releasePreparedTransaction({ chainId, safe, operationHash, now }) {
      const { rowCount } = await driver.query(
        `UPDATE prepared_transactions SET status = 'prepared', updated_at = ?
         WHERE chain_id = ? AND safe = ? AND operation_hash = ? AND status = 'submitting'`,
        [now, chainId, safe.toLowerCase(), operationHash.toLowerCase()],
      );
      return rowCount === 1;
    },

    async isSentTransaction(chainId, safe, userOpHash) {
      // `user_op_hash` is stored lowercase, so the index serves the lookup.
      const { rows } = await driver.query(
        `SELECT 1 FROM prepared_transactions WHERE chain_id = ? AND safe = ? AND user_op_hash = ? AND status = 'sent' LIMIT 1`,
        [chainId, safe.toLowerCase(), userOpHash.toLowerCase()],
      );
      return rows.length > 0;
    },
  };
}
