import type { Migration } from './index';

// The second factor moves to the app's login. Sessions are deleted: one pending verification must not
// become valid when the column disappears. Users, sets and wallets are left untouched.
const sql = `
  DELETE FROM sessions;
  ALTER TABLE users DROP COLUMN totp_secret_enc;
  ALTER TABLE users DROP COLUMN totp_confirmed;
  ALTER TABLE sessions DROP COLUMN verified;
`;

export const removeVaultSecondFactor: Migration = {
  version: 2,
  name: 'remove-vault-second-factor',
  sqlite: sql,
  postgres: sql,
};
