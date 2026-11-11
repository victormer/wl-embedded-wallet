import type { Migration } from './index';

// `rate_limits` holds one fixed-window counter per bucket (an IP or a `sub` per scope), purged after it expires.
// `share_a_releases` is the audit trail of share A releases: nothing secret, never deleted, and no foreign key,
// because a relink moves sets between users. `sponsored_deployments` makes a sponsored deployment single-flight per Safe.
const schema = (bigint: string) => `
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start ${bigint} NOT NULL,
    hits ${bigint} NOT NULL,
    expires_at ${bigint} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_limits_expires_at ON rate_limits(expires_at);
  CREATE TABLE IF NOT EXISTS share_a_releases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    set_id TEXT NOT NULL,
    set_status TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    app_origin TEXT,
    released_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS share_a_releases_user ON share_a_releases(user_id, released_at);
  ALTER TABLE share_sets ADD COLUMN created_session_hash TEXT;
  CREATE TABLE IF NOT EXISTS sponsored_deployments (
    chain_id ${bigint} NOT NULL,
    safe TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitting', 'sent')),
    operation TEXT NOT NULL,
    operation_hash TEXT NOT NULL,
    user_op_hash TEXT,
    prepared_at ${bigint} NOT NULL,
    updated_at ${bigint} NOT NULL,
    PRIMARY KEY (chain_id, safe)
  );
`;

export const limitsAndAudit: Migration = {
  version: 6,
  name: 'limits-and-audit',
  sqlite: schema('INTEGER'),
  postgres: schema('BIGINT'),
};
