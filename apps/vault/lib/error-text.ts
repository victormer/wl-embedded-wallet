import { PrfError } from './prf';
import { WalletError } from '@wl-embedded-wallet/core/types';

const MESSAGES: Record<string, string> = {
  MANIFEST_INVALID: 'The manifest is not authentic. The operation was stopped before the seed was used.',
  FORMAT_UNSUPPORTED: 'This share set uses a format that this version does not support.',
  SHARE_TAMPERED: 'A share does not match the signed manifest. The operation was stopped.',
  COMBINE_FAILED: 'The shares cannot reconstruct the seed.',
  ADDRESS_MISMATCH: 'The seed does not match the expected address. The operation was stopped.',
  KDF_PARAMS_INVALID: 'The envelope encryption parameters are invalid.',
  BAD_RECOVERY_CODE: 'The recovery code is not in a valid format.',
  SERVER_KEY_MISMATCH: 'The server cannot decrypt its data: its key is wrong or the data is damaged. Notify the operator. You can recover your wallet with the emergency kit.',
  NO_SEED_BACKUP: 'This kit is old and has no seed backup: you also need your passkey.',
  RECOVERY_FAILED: 'Recovery with this passkey failed. It may not belong to your current wallet, or your wallet may predate this feature: in that case, use your kit or re-enroll first.',
  RELINK_REJECTED: 'The wallet could not be linked: the signature or permission is invalid or has expired. Try again. Nothing has changed.',
  WALLET_ALREADY_EXISTS: 'This account already has a wallet. Another one cannot be linked.',
  NETWORK: 'Could not connect to the vault.',
  UNAUTHORIZED: 'The session is invalid or has expired. Reopen this window from the app.',
  INVALID_REQUEST: 'The app request is invalid. Nothing was signed.',
  INVALID_KIT: 'The file is not a valid emergency kit.',
  WRONG_RP: 'This kit belongs to another domain: its passkey does not work here.',
  NO_WALLET: 'This user does not have a wallet yet.',
  WALLET_NOT_DEPLOYED: 'Your wallet is not deployed on this network yet. Deploy it to be able to sign.',
  CHAIN_MISMATCH: 'The RPC does not match the specified network. The operation was stopped.',
  CHAIN_NOT_SUPPORTED: 'This network is not supported: the wallet would not have the same address here, or its configuration is missing.',
  CHAIN_UNAVAILABLE: 'Could not query the network. Try again.',
  CHAIN_REQUEST_MISMATCH: 'The request network does not match the one authorized by the app. Nothing was signed.',
  ORIGIN_MISMATCH: 'The authorization token does not belong to this app.',
  ORIGIN_NOT_ALLOWED: 'This vault does not allow this app.',
  INSUFFICIENT_FUNDS: 'Your Safe does not have enough funds on this network for this operation and its network fee. Nothing was sent.',
  DEPLOY_FAILED: 'The deployment failed.',
  FEES_TOO_HIGH: 'Network fees are above the limit this vault allows. Nothing was sent. Try again later.',
  GAS_LIMIT_EXCEEDED: 'This operation would need more gas than this vault allows. Nothing was sent.',
  CALL_NOT_ALLOWED: 'The vault does not send calls with data to your own Safe: they could change its owners or modules. Nothing was sent.',
  CALL_REVERTED: 'The call would fail on-chain: the contract rejected it. Nothing was sent.',
  SPONSORSHIP_REJECTED: "This network's paymaster refused to pay for the operation (its policy may be inactive or out of funds). Nothing was sent.",
  NONCE_CONFLICT: 'Another operation from your Safe went through first. Nothing was sent. Try again.',
  TRANSACTION_FAILED: 'The bundler did not accept the transaction. Nothing was sent.',
  TRANSACTION_REVERTED: 'The transaction was included on-chain, but its call failed. The network fee was still paid.',
  TRANSACTION_TIMEOUT: 'The transaction was sent but not confirmed within 3 minutes. Check it in the block explorer before trying again.',
  TRANSACTION_EXPIRED: 'The transaction took too long to approve and its fees are no longer valid. Nothing was sent. Try again.',
  TRANSACTION_IN_PROGRESS: 'This transaction is already being sent. Wait a moment.',
  ALREADY_SPONSORED: 'A deployment of your wallet was already sent on this network. Wait a few minutes for it to complete before trying again.',
  DEPLOYMENT_IN_PROGRESS: 'Your wallet is already being deployed on this network. Wait a moment and try again.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  USER_REJECTED: 'You rejected the operation. Nothing was signed.',
  INTERNAL: 'Something went wrong. No data was revealed.',
};

/** Deployment and transaction codes from the vault server that have their own text. The worker never produces them. */
export type ServerErrorCode =
  | 'FEES_TOO_HIGH'
  | 'GAS_LIMIT_EXCEEDED'
  | 'ALREADY_SPONSORED'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'TRANSACTION_EXPIRED'
  | 'TRANSACTION_IN_PROGRESS'
  | 'RATE_LIMITED';
export const SERVER_ERROR_CODES: readonly string[] = [
  'FEES_TOO_HIGH',
  'GAS_LIMIT_EXCEEDED',
  'ALREADY_SPONSORED',
  'DEPLOYMENT_IN_PROGRESS',
  'TRANSACTION_EXPIRED',
  'TRANSACTION_IN_PROGRESS',
  'RATE_LIMITED',
];

/** The message is always the code, as with `WalletError`. */
export class ServerError extends Error {
  readonly code: ServerErrorCode;

  constructor(code: ServerErrorCode) {
    super(code);
    this.name = 'ServerError';
    this.code = code;
  }
}

export type ErrorContext = 'passkey' | 'code';

/** `DECRYPT_FAILED` does not distinguish a wrong key from a tampered envelope, and the text does not pretend to either. */
export function errorText(code: string, context: ErrorContext = 'passkey'): string {
  if (code === 'DECRYPT_FAILED') {
    return context === 'code' ? 'Incorrect code or tampered kit.' : 'Incorrect passkey or tampered data.';
  }
  return MESSAGES[code] ?? MESSAGES.INTERNAL;
}

export interface UiError {
  code: string;
  text: string;
}

export function toUiError(error: unknown, context: ErrorContext = 'passkey'): UiError {
  if (error instanceof PrfError) return { code: error.reason, text: error.message };
  if (error instanceof ServerError) return uiError(error.code, context);
  const code = error instanceof WalletError ? error.code : 'INTERNAL';
  return { code, text: errorText(code, context) };
}

export function uiError(code: string, context: ErrorContext = 'passkey'): UiError {
  return { code, text: errorText(code, context) };
}
