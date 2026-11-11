export type WalletErrorCode =
  | 'MANIFEST_INVALID'
  | 'FORMAT_UNSUPPORTED'
  | 'DECRYPT_FAILED'
  | 'SERVER_KEY_MISMATCH'
  | 'SHARE_TAMPERED'
  | 'COMBINE_FAILED'
  | 'ADDRESS_MISMATCH'
  | 'WALLET_NOT_DEPLOYED'
  | 'CHAIN_MISMATCH'
  | 'CHAIN_NOT_SUPPORTED'
  | 'CHAIN_UNAVAILABLE'
  | 'CHAIN_REQUEST_MISMATCH'
  | 'ORIGIN_MISMATCH'
  | 'ORIGIN_NOT_ALLOWED'
  | 'INSUFFICIENT_FUNDS'
  | 'DEPLOY_FAILED'
  | 'KDF_PARAMS_INVALID'
  | 'BAD_RECOVERY_CODE'
  | 'INVALID_KIT'
  | 'NO_SEED_BACKUP'
  | 'WALLET_ALREADY_EXISTS'
  | 'RELINK_REJECTED'
  | 'RECOVERY_FAILED'
  | 'NETWORK'
  | 'UNAUTHORIZED'
  // A vault rate limit or budget was reached (HTTP 429).
  | 'RATE_LIMITED'
  | 'INTERNAL';

/** The message is always the code: it never carries sensitive material or a `cause`. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode) {
    super(code);
    this.name = 'WalletError';
    this.code = code;
  }
}
