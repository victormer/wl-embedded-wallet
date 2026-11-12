import type { Migration } from './index';

// `prepared_transactions` holds the UserOperations the server built for a deployed Safe, one per chain, Safe and
// `userOperationHash`, so that only exactly that operation, signed by the owner, is ever submitted, and only once.
// `sponsored` is 0/1 (SQLite has no boolean). Unsent `prepared` rows are deleted once they expire; `sent` rows stay,
// so that `eth_getUserOperationReceipt` can check that the hash belongs to that Safe.
const schema = (bigint: string) => `
  CREATE TABLE IF NOT EXISTS prepared_transactions (
    chain_id ${bigint} NOT NULL,
    safe TEXT NOT NULL,
    user_id TEXT NOT NULL,
    operation_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitting', 'sent')),
    operation TEXT NOT NULL,
    sponsored INTEGER NOT NULL,
    user_op_hash TEXT,
    prepared_at ${bigint} NOT NULL,
    updated_at ${bigint} NOT NULL,
    PRIMARY KEY (chain_id, safe, operation_hash)
  );
  CREATE INDEX IF NOT EXISTS prepared_transactions_sent ON prepared_transactions(chain_id, safe, user_op_hash);
  CREATE INDEX IF NOT EXISTS prepared_transactions_expiry ON prepared_transactions(status, updated_at);
`;

export const preparedTransactions: Migration = {
  version: 7,
  name: 'prepared-transactions',
  sqlite: schema('INTEGER'),
  postgres: schema('BIGINT'),
};
