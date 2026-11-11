import type { UserOperationJson } from '@wl-embedded-wallet/sdk/protocol';
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

/** Talks to the vault proxy: the bundler and paymaster are never contacted from the browser. */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
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
    if (body?.rpcMessage?.includes('AA21')) throw new WalletError('INSUFFICIENT_FUNDS');
    if (body?.error?.startsWith('CHAIN_')) throw new WalletError(body.error as WalletErrorCode);
    if (body?.error && SERVER_ERROR_CODES.includes(body.error)) throw new ServerError(body.error as ServerErrorCode);
    throw new WalletError('DEPLOY_FAILED');
  }
  return body.result as T;
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
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const receipt = await rpc<{ success: boolean; receipt: { transactionHash: `0x${string}` } } | null>('eth_getUserOperationReceipt', [userOpHash]);
    if (receipt) {
      if (!receipt.success) throw new WalletError('DEPLOY_FAILED');
      return { userOpHash, transactionHash: receipt.receipt.transactionHash };
    }
    await new Promise((resolve) => setTimeout(resolve, attempt < RECEIPT_FAST_POLLS ? RECEIPT_INTERVAL_MS : RECEIPT_SLOW_INTERVAL_MS));
  }
  throw new WalletError('DEPLOY_FAILED');
}
