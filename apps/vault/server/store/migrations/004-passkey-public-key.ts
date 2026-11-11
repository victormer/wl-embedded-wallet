import type { Migration } from './index';

// `owner` comes from the manifest, using each dialect's JSON function. Existing sets are left without a public
// key: their passkey cannot use kit-free recovery until re-enrollment, because there is nowhere to get it from.
const schema = (bigint: string, owner: string) => `
  ALTER TABLE share_sets ADD COLUMN credential_public_key TEXT;
  ALTER TABLE share_sets ADD COLUMN credential_counter ${bigint} NOT NULL DEFAULT 0;
  ALTER TABLE share_sets ADD COLUMN owner TEXT;
  UPDATE share_sets SET owner = lower(${owner});
  CREATE UNIQUE INDEX IF NOT EXISTS share_sets_one_public_key
    ON share_sets(credential_id) WHERE credential_public_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS share_sets_active_owner
    ON share_sets(owner) WHERE status = 'active';
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'recover')),
    user_id TEXT,
    expires_at ${bigint} NOT NULL
  );
`;

export const passkeyPublicKey: Migration = {
  version: 4,
  name: 'passkey-public-key',
  sqlite: schema('INTEGER', `json_extract(manifest, '$.expectedAddress')`),
  postgres: schema('BIGINT', `manifest::json->>'expectedAddress'`),
};
