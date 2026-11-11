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
  WALLET_NOT_DEPLOYED: 'Your wallet is not deployed on this chain. Deploy it to sign.',
  CHAIN_MISMATCH: 'The RPC for this chain does not match the requested chain.',
  CHAIN_NOT_SUPPORTED: 'This chain is not supported: the wallet would not have the same address here, or its configuration is missing.',
  CHAIN_UNAVAILABLE: 'Could not query this chain.',
  CHAIN_REQUEST_MISMATCH: 'The chain in the request does not match the authorized one.',
  ORIGIN_MISMATCH: 'The authorization token does not belong to this app.',
  ORIGIN_NOT_ALLOWED: 'This vault does not allow this app.',
  INSUFFICIENT_FUNDS: 'Your Safe does not have enough funds to pay for the deployment on this chain.',
  DEPLOY_FAILED: 'The deployment failed.',
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
