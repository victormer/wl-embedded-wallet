import type { Migration } from './index';

// SQLite's `INTEGER` is already 64-bit. In Postgres, timestamps and `chainId`s do not fit in 32 bits.
const schema = (bigint: string) => `
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    exported_at TEXT,
    created_at ${bigint} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    verified INTEGER NOT NULL DEFAULT 0,
    expires_at ${bigint} NOT NULL,
    chain_id ${bigint},
    rpc_url TEXT
  );
  CREATE TABLE IF NOT EXISTS used_jti (
    jti TEXT PRIMARY KEY,
    expires_at ${bigint} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS share_sets (
    set_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
    credential_id TEXT NOT NULL,
    manifest TEXT NOT NULL,
    signature TEXT NOT NULL,
    enc_a TEXT,
    enc_b TEXT,
    enc_c TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS share_sets_one_active
    ON share_sets(user_id) WHERE status = 'active';
`;

export const initial: Migration = {
  version: 1,
  name: 'initial',
  sqlite: schema('INTEGER'),
  postgres: schema('BIGINT'),
};
