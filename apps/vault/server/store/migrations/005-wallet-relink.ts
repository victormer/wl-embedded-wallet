import type { Migration } from './index';

// `wallet_relinks` is the audit trail: it holds nothing secret and is never deleted.
const schema = (bigint: string) => `
  CREATE TABLE IF NOT EXISTS relink_nonces (
    nonce TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    safe TEXT NOT NULL,
    owner TEXT NOT NULL,
    from_user TEXT,
    expires_at ${bigint} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wallet_relinks (
    id TEXT PRIMARY KEY,
    safe TEXT NOT NULL,
    owner TEXT NOT NULL,
    old_sub TEXT NOT NULL,
    new_sub TEXT NOT NULL,
    issuer TEXT NOT NULL,
    vault_origin TEXT NOT NULL,
    app_origin TEXT,
    nonce TEXT NOT NULL,
    signature TEXT NOT NULL,
    linked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wallet_relinks_owner ON wallet_relinks(owner);
`;

export const walletRelink: Migration = {
  version: 5,
  name: 'wallet-relink',
  sqlite: schema('INTEGER'),
  postgres: schema('BIGINT'),
};
