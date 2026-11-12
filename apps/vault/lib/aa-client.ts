import type { UserOperationJson, VaultCall } from '@wl-embedded-wallet/sdk/protocol';
import { toRpcUserOperation, type SmartAccountInfo } from '@wl-embedded-wallet/core/safe';
import { WalletError, type ChainStatus, type WalletErrorCode } from '@wl-embedded-wallet/core/types';
import { SERVER_ERROR_CODES, ServerError, type ServerErrorCode } from './error-text';
import { currentAppOrigin } from './vault-api';

// Up to 3 minutes: on Ethereum Sepolia (12 s blocks plus the bundler's own batching) a deployment can take more than
// one. Every second at first, then every 3 s, well within the `aa` rate limit (120 per minute per user).
const RECEIPT_TIMEOUT_MS = 180_000;
const RECEIPT_FAST_POLLS = 30;
const RECEIPT_INTERVAL_MS = 1000;
const RECEIPT_SLOW_INTERVAL_MS = 3000;

export type AaContext = 'deploy' | 'transaction';

/**
 * A bundler or paymaster rejection, as a code the user can act on. ERC-4337 errors carry an `AAxx` prefix
 * (AA2x: the account, AA3x: the paymaster); Pimlico words policy failures, e.g. "sponsorship policy ... is not active".
 */
export function upstreamErrorCode(rpcMessage: string, context: AaContext): WalletErrorCode {
  const failed: WalletErrorCode = context === 'transaction' ? 'TRANSACTION_FAILED' : 'DEPLOY_FAILED';
  if (/\bAA21\b/.test(rpcMessage)) return 'INSUFFICIENT_FUNDS';
  if (/\bAA25\b|invalid (account )?nonce/i.test(rpcMessage)) return 'NONCE_CONFLICT';
  if (/\bAA3\d\b|paymaster|sponsorship|policy/i.test(rpcMessage)) return 'SPONSORSHIP_REJECTED';
  if (/\bAA\d\d\b/.test(rpcMessage)) return failed;
  if (context === 'transaction' && /revert|execution/i.test(rpcMessage)) return 'CALL_REVERTED';
  return failed;
}

/** A transaction that reached the chain without its call succeeding, or whose receipt did not arrive in time. */
export class SentTransactionError extends WalletError {
  readonly userOpHash: `0x${string}`;
  readonly transactionHash: `0x${string}` | null;

  constructor(code: 'TRANSACTION_REVERTED' | 'TRANSACTION_TIMEOUT', userOpHash: `0x${string}`, transactionHash: `0x${string}` | null) {
    super(code);
    this.name = 'SentTransactionError';
    this.userOpHash = userOpHash;
    this.transactionHash = transactionHash;
  }
}

/** Talks to the vault proxy: the bundler and paymaster are never contacted from the browser. */
async function rpc<T>(method: string, params: unknown[], context: AaContext = 'deploy'): Promise<T> {
  let response: Response;
  try {
    const appOrigin = currentAppOrigin();
    response = await fetch('/api/aa/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(appOrigin ? { 'X-Vault-App-Origin': appOrigin } : {}) },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new WalletError('NETWORK');
  }
  const body = (await response.json().catch(() => null)) as { result?: T; error?: string; rpcMessage?: string } | null;
  if (response.status === 401 || (response.status === 403 && (body?.error === 'FORBIDDEN_ORIGIN' || body?.error === 'ORIGIN_MISMATCH'))) throw new WalletError('UNAUTHORIZED');
  if (!response.ok || !body || body.error) {
    if (body?.error === 'UPSTREAM_ERROR' && typeof body.rpcMessage === 'string') throw new WalletError(upstreamErrorCode(body.rpcMessage, context));
    if (body?.error?.startsWith('CHAIN_')) throw new WalletError(body.error as WalletErrorCode);
    if (body?.error === 'NOT_DEPLOYED') throw new WalletError('WALLET_NOT_DEPLOYED');
    if (body?.error === 'INSUFFICIENT_FUNDS' || body?.error === 'CALL_NOT_ALLOWED') throw new WalletError(body.error);
    if (body?.error && SERVER_ERROR_CODES.includes(body.error)) throw new ServerError(body.error as ServerErrorCode);
    throw new WalletError(context === 'transaction' ? 'TRANSACTION_FAILED' : 'DEPLOY_FAILED');
  }
  return body.result as T;
}

/** Polls the receipt of a hash the vault recorded. `null` when none arrived within the timeout. */
async function waitForReceipt(userOpHash: `0x${string}`, context: AaContext): Promise<{ success: boolean; receipt: { transactionHash: `0x${string}` } } | null> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const receipt = await rpc<{ success: boolean; receipt: { transactionHash: `0x${string}` } } | null>('eth_getUserOperationReceipt', [userOpHash], context);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, attempt < RECEIPT_FAST_POLLS ? RECEIPT_INTERVAL_MS : RECEIPT_SLOW_INTERVAL_MS));
  }
  return null;
}

export function requiredPrefund(operation: UserOperationJson): bigint {
  const gas = BigInt(operation.callGasLimit) + BigInt(operation.verificationGasLimit) + BigInt(operation.preVerificationGas);
  return gas * BigInt(operation.maxFeePerGas);
}

/**
 * The server builds the deployment (fees, gas and paymaster fields within its caps) and records it: only that
 * operation, signed unchanged, is accepted later. The signature is still missing.
 */
export async function prepareDeployment(status: ChainStatus): Promise<UserOperationJson> {
  const operation = await rpc<UserOperationJson | null>('vault_prepareDeployment', []);
  if (!operation || typeof operation.maxFeePerGas !== 'string' || Boolean(operation.paymaster) !== status.sponsored) throw new WalletError('DEPLOY_FAILED');
  if (!status.sponsored && BigInt(status.balance ?? '0') < requiredPrefund(operation)) throw new WalletError('INSUFFICIENT_FUNDS');
  return operation;
}

export async function sendDeployment(operation: UserOperationJson, account: SmartAccountInfo): Promise<{ userOpHash: `0x${string}`; transactionHash: `0x${string}` }> {
  const userOpHash = await rpc<`0x${string}`>('eth_sendUserOperation', [toRpcUserOperation(operation), account.entryPoint]);
  const receipt = await waitForReceipt(userOpHash, 'deploy');
  if (!receipt?.success) throw new WalletError('DEPLOY_FAILED');
  return { userOpHash, transactionHash: receipt.receipt.transactionHash };
}

/**
 * The server builds the operation for this call (nonce, fees, gas and, where the vault sponsors transactions, the
 * paymaster fields) and records it. The signature is still missing.
 */
export async function prepareTransaction(call: VaultCall, status: ChainStatus): Promise<UserOperationJson> {
  const operation = await rpc<UserOperationJson | null>('vault_prepareTransaction', [call], 'transaction');
  if (!operation || typeof operation.maxFeePerGas !== 'string' || operation.factory || Boolean(operation.paymaster) !== status.transactionsSponsored) {
    throw new WalletError('TRANSACTION_FAILED');
  }
  return operation;
}

/** Sends the signed operation and waits for its receipt (up to 3 minutes). */
export async function sendTransaction(operation: UserOperationJson, account: SmartAccountInfo): Promise<{ userOpHash: `0x${string}`; transactionHash: `0x${string}` }> {
  const userOpHash = await rpc<`0x${string}`>('eth_sendUserOperation', [toRpcUserOperation(operation), account.entryPoint], 'transaction');
  const receipt = await waitForReceipt(userOpHash, 'transaction');
  if (!receipt) throw new SentTransactionError('TRANSACTION_TIMEOUT', userOpHash, null);
  if (!receipt.success) throw new SentTransactionError('TRANSACTION_REVERTED', userOpHash, receipt.receipt.transactionHash);
  return { userOpHash, transactionHash: receipt.receipt.transactionHash };
}
