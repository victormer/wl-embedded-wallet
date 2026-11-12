const MESSAGES: Record<string, string> = {
  USER_REJECTED: 'You rejected the operation in the vault.',
  POPUP_BLOCKED: 'Your browser blocked the vault window. Allow pop-ups for this site and try again.',
  POPUP_CLOSED: 'The vault window was closed before the operation finished.',
  SUPERSEDED: 'Another operation was started in the vault window.',
  TOKEN_UNAVAILABLE: 'The operation could not be authorized. Sign in again.',
  UNAUTHORIZED: 'The vault did not accept the session. Try again.',
  NETWORK: 'Could not reach the vault.',
  VAULT_UNAVAILABLE: 'The vault is not available right now.',
  MANIFEST_INVALID: 'The wallet manifest is invalid. The operation was aborted.',
  FORMAT_UNSUPPORTED: 'This wallet format is not supported.',
  DECRYPT_FAILED: 'The wallet data could not be decrypted.',
  SHARE_TAMPERED: 'A key share has been tampered with. The operation was aborted.',
  COMBINE_FAILED: 'The key could not be reconstructed.',
  ADDRESS_MISMATCH: 'The reconstructed key does not match this wallet.',
  WALLET_NOT_DEPLOYED: 'Your wallet is not deployed on this chain. Deploy it first to sign or send.',
  CHAIN_MISMATCH: 'The RPC for this chain does not match the requested chain.',
  CHAIN_NOT_SUPPORTED: 'This chain is not supported: the wallet would not have the same address here, or its configuration is missing.',
  CHAIN_UNAVAILABLE: 'Could not query this chain.',
  CHAIN_REQUEST_MISMATCH: 'The chain in the request does not match the authorized one.',
  ORIGIN_MISMATCH: 'The authorization token does not belong to this app.',
  ORIGIN_NOT_ALLOWED: 'This vault does not allow this app.',
  INSUFFICIENT_FUNDS: 'Your Safe does not have enough funds on this chain for this operation and its network fee.',
  DEPLOY_FAILED: 'The deployment failed.',
  CALL_NOT_ALLOWED: 'The vault does not send calls with data to your own Safe: they could change its owners or modules.',
  CALL_REVERTED: 'The call would revert on-chain. Nothing was sent.',
  SPONSORSHIP_REJECTED: 'The paymaster refused to sponsor this operation (for example, its policy is inactive or out of funds). Nothing was sent.',
  NONCE_CONFLICT: 'Another operation from your Safe went through first. Try again.',
  TRANSACTION_FAILED: 'The bundler rejected the operation. Nothing was sent.',
  TRANSACTION_REVERTED: 'The operation was included on-chain, but the call failed.',
  TRANSACTION_TIMEOUT: 'The operation was sent but not confirmed within 3 minutes. Check the explorer.',
  TRANSACTION_EXPIRED: 'The operation took too long to approve. Try again.',
  TRANSACTION_IN_PROGRESS: 'Another transaction from your Safe is in progress. Wait for it to finish.',
  FEES_TOO_HIGH: 'Network fees are above the limit this vault allows. Nothing was sent. Try again later.',
  GAS_LIMIT_EXCEEDED: 'The operation would need more gas than this vault allows. Nothing was sent.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  INVALID_REQUEST: 'The vault did not accept the request. Nothing was signed or sent.',
  NO_WALLET: 'This account does not have a wallet yet.',
  WALLET_ALREADY_EXISTS: 'This account already has a wallet: another one cannot be linked.',
  RELINK_REJECTED: 'The wallet could not be linked. Nothing has changed.',
  INVALID_INPUT: 'Check the data you entered.',
  INVALID_JSON: 'The EIP-712 data is not valid JSON.',
};

export function messageFor(code: string): string {
  return MESSAGES[code] ?? `The operation failed (${code}).`;
}

/**
 * The wallet's state on the selected chain. `deployed` is `null` when the vault could not tell (for example, with
 * `chainError`, or with no chain): it is shown as unknown, never as not deployed.
 */
export function deploymentNotice(deployed: boolean | null, chainError: string | null): { kind: 'ok' | 'error' | 'info'; text: string } {
  const kind = deployed ? 'ok' : chainError ? 'error' : 'info';
  if (chainError) return { kind, text: messageFor(chainError) };
  if (deployed === null) return { kind, text: 'Deployment status on this chain is unknown.' };
  return { kind, text: deployed ? 'Deployed on this chain.' : 'Not deployed on this chain.' };
}
