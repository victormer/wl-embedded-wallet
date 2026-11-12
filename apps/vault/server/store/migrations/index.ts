import { initial } from './001-initial';
import { removeVaultSecondFactor } from './002-remove-vault-second-factor';
import { sessionAppOrigin } from './003-session-app-origin';
import { passkeyPublicKey } from './004-passkey-public-key';
import { walletRelink } from './005-wallet-relink';
import { limitsAndAudit } from './006-limits-and-audit';
import { preparedTransactions } from './007-prepared-transactions';

export interface Migration {
  version: number;
  name: string;
  sqlite: string;
  postgres: string;
}

// In code rather than `.sql` files, so they always reach the `standalone` output.
export const MIGRATIONS: Migration[] = [initial, removeVaultSecondFactor, sessionAppOrigin, passkeyPublicKey, walletRelink, limitsAndAudit, preparedTransactions];
