import type { UserOperationJson, VaultCall } from '@wl-embedded-wallet/core/operations';
import { isRecord } from '@wl-embedded-wallet/core/schema';
import {
  buildTransactionOperation,
  isAllowedTransactionCall,
  isTransactionOperation,
  toRpcUserOperation,
  userOperationHash,
  type SmartAccountInfo,
} from '@wl-embedded-wallet/core/safe';
import { encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem';
import { ChainError, jsonRpc, transactionsSponsored, type ChainConfig } from './chains';
import { sponsorshipLimits } from './limits';
import {
  applyPaymaster,
  bundlerGasPrice,
  deploymentFees,
  gasWithMargin,
  matchesPrepared,
  nodeQuantity,
  quantity,
  signedByOwner,
  SponsorshipError,
  STALE_SUBMITTING_MS,
  upstreamResult,
  USER_OP_HASH,
} from './sponsorship';
import {
  claimPreparedTransaction,
  completePreparedTransaction,
  createPreparedTransaction,
  getPreparedTransaction,
  releasePreparedTransaction,
} from './store';

/**
 * Transactions from a deployed Safe: one call (`to`, `value`, `data`), always a CALL. As with the sponsored
 * deployment, the server builds the whole UserOperation (nonce from the EntryPoint, fees from the node and the
 * bundler's quote, gas from the bundler within the caps, paymaster fields only where `sponsorTransactions` is on),
 * records it, and later forwards only that exact operation signed by the owner, once. The browser never chooses
 * gas, fees or paymaster fields.
 */

/** A prepared operation must be signed and sent within this time: fees and paymaster data go stale. */
export const TRANSACTION_TTL_MS = 10 * 60_000;
const EMPTY_CODE = new Set(['0x', '0x0', '']);
const ENTRY_POINT_ABI = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256 nonce)']);
const QUANTITY = /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

export interface TransactionContext {
  chainId: number;
  userId: string;
  owner: string;
  account: SmartAccountInfo;
  config: ChainConfig;
  /** Node RPC, already checked with `assertRpcChain`. */
  rpcUrl: string;
  bundler: { url: string; headers?: Record<string, string> };
}

/** What the store keeps: the call is recorded next to the operation, for the defensive check before sending. */
interface StoredTransaction {
  userOperation: UserOperationJson;
  call: VaultCall;
}

async function nodeResult(url: string, method: string, params: unknown[]): Promise<unknown> {
  const outcome = await jsonRpc(url, method, params);
  if ('error' in outcome) throw new ChainError('CHAIN_UNAVAILABLE');
  return outcome.result;
}

function nodeBigint(value: unknown): bigint {
  try {
    return quantity(value);
  } catch {
    throw new ChainError('CHAIN_UNAVAILABLE');
  }
}

/** The EntryPoint's nonce for key 0: the only key the vault uses. */
async function entryPointNonce(url: string, account: SmartAccountInfo): Promise<bigint> {
  const data = encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: 'getNonce', args: [account.address, 0n] });
  return nodeBigint(await nodeResult(url, 'eth_call', [{ to: account.entryPoint, data }, 'latest']));
}

export function requiredPrefund(operation: UserOperationJson): bigint {
  const gas = BigInt(operation.callGasLimit) + BigInt(operation.verificationGasLimit) + BigInt(operation.preVerificationGas);
  return gas * BigInt(operation.maxFeePerGas);
}

/**
 * Builds the operation for `call`: unsigned, within the caps, sponsored only if the chain opts in. Refuses a Safe that
 * is not deployed (`NOT_DEPLOYED`), a call to the Safe itself with data (`CALL_NOT_ALLOWED`), and a Safe whose balance
 * does not cover `value` plus, when not sponsored, the prefund (`INSUFFICIENT_FUNDS`): such an operation would only
 * fail on-chain, and a sponsored one would still spend the paymaster's gas.
 */
export async function buildTransaction(context: TransactionContext, call: VaultCall): Promise<{ operation: UserOperationJson; sponsored: boolean }> {
  const { chainId, account, config, rpcUrl, bundler } = context;
  if (!isAllowedTransactionCall(account.address, call)) throw new SponsorshipError('CALL_NOT_ALLOWED');
  const code = await nodeResult(rpcUrl, 'eth_getCode', [account.address, 'latest']);
  if (typeof code !== 'string' || EMPTY_CODE.has(code)) throw new SponsorshipError('NOT_DEPLOYED');

  const limits = sponsorshipLimits(chainId);
  const sponsored = transactionsSponsored(config);
  const [gasPrice, priority, quote, balance, nonce] = await Promise.all([
    nodeQuantity(rpcUrl, 'eth_gasPrice'),
    nodeQuantity(rpcUrl, 'eth_maxPriorityFeePerGas'),
    bundlerGasPrice(bundler),
    nodeResult(rpcUrl, 'eth_getBalance', [account.address, 'latest']).then(nodeBigint),
    entryPointNonce(rpcUrl, account),
  ]);
  // Checked before asking the paymaster or the bundler: a call the Safe cannot pay for costs no upstream calls.
  if (BigInt(call.value) > balance) throw new SponsorshipError('INSUFFICIENT_FUNDS');

  const fees = deploymentFees(gasPrice, priority, limits, quote);
  let operation = buildTransactionOperation(
    account.address,
    call,
    nonce.toString(),
    { maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() },
    account,
  );
  // The server decides the sponsorship context: the browser does not choose the policy.
  const paymasterCall = async (method: 'pm_getPaymasterStubData' | 'pm_getPaymasterData') =>
    upstreamResult(
      await jsonRpc(
        config.paymasterUrl as string,
        method,
        [toRpcUserOperation(operation), account.entryPoint, `0x${chainId.toString(16)}`, config.paymasterContext ?? {}],
        config.paymasterHeaders,
      ),
    );

  if (sponsored) operation = applyPaymaster(operation, await paymasterCall('pm_getPaymasterStubData'), limits);

  const gas = upstreamResult(await jsonRpc(bundler.url, 'eth_estimateUserOperationGas', [toRpcUserOperation(operation), account.entryPoint], bundler.headers));
  if (!isRecord(gas)) throw new SponsorshipError('UPSTREAM_INVALID');
  operation = {
    ...operation,
    callGasLimit: gasWithMargin(quantity(gas.callGasLimit), limits.maxCallGasLimit).toString(),
    verificationGasLimit: gasWithMargin(quantity(gas.verificationGasLimit), limits.maxVerificationGasLimit).toString(),
    preVerificationGas: gasWithMargin(quantity(gas.preVerificationGas), limits.maxPreVerificationGas).toString(),
  };
  if (sponsored) {
    if (gas.paymasterVerificationGasLimit != null) {
      operation.paymasterVerificationGasLimit = gasWithMargin(quantity(gas.paymasterVerificationGasLimit), limits.maxPaymasterVerificationGasLimit).toString();
    }
    if (gas.paymasterPostOpGasLimit != null) {
      operation.paymasterPostOpGasLimit = gasWithMargin(quantity(gas.paymasterPostOpGasLimit), limits.maxPaymasterPostOpGasLimit).toString();
    }
    operation = applyPaymaster(operation, await paymasterCall('pm_getPaymasterData'), limits);
    // EntryPoint v0.7 packs both paymaster gas limits: one that nobody gave cannot be guessed here.
    if (operation.paymasterVerificationGasLimit === null || operation.paymasterPostOpGasLimit === null) throw new SponsorshipError('UPSTREAM_INVALID');
  } else if (BigInt(call.value) + requiredPrefund(operation) > balance) {
    throw new SponsorshipError('INSUFFICIENT_FUNDS');
  }
  return { operation: { ...operation, signature: '0x' }, sponsored };
}

/** `vault_prepareTransaction`: builds and records the operation the page will sign. */
export async function prepareTransaction(context: TransactionContext, call: VaultCall): Promise<UserOperationJson> {
  const { chainId, userId, account } = context;
  const { operation, sponsored } = await buildTransaction(context, call);
  const operationHash = userOperationHash(operation, chainId, account).toLowerCase();
  const now = Date.now();
  const stored: StoredTransaction = { userOperation: operation, call };
  const created = await createPreparedTransaction({
    chainId,
    safe: account.address,
    userId,
    operationHash,
    operation: JSON.stringify(stored),
    sponsored,
    now,
    expireBefore: now - TRANSACTION_TTL_MS,
  });
  if (!created) {
    // The same operation prepared twice (same nonce, fees and gas): still the same one to sign, unless it already went out.
    const existing = await getPreparedTransaction(chainId, account.address, operationHash);
    if (existing?.status !== 'prepared') throw new SponsorshipError('TRANSACTION_IN_PROGRESS');
  }
  return operation;
}

function decimal(value: unknown): string | null {
  if (typeof value !== 'string' || !QUANTITY.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < 1n << 256n ? parsed.toString() : null;
}

/**
 * The candidate from `eth_sendUserOperation` (hex or decimal quantities, empty fields missing or `null`) as a
 * `UserOperationJson`, or `null` if a field is malformed. Only used to find the prepared record by its hash.
 */
export function fromRpcUserOperation(candidate: Record<string, unknown>): UserOperationJson | null {
  const address = (value: unknown) => (typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : null);
  const bytes = (value: unknown) => (typeof value === 'string' && HEX_BYTES.test(value) ? value : null);
  const optional = <T>(value: unknown, parse: (value: unknown) => T | null): T | null | undefined => (value === undefined || value === null ? null : (parse(value) ?? undefined));
  const sender = address(candidate.sender);
  const callData = bytes(candidate.callData);
  const signature = bytes(candidate.signature);
  const quantities = (['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map((key) => decimal(candidate[key]));
  const factory = optional(candidate.factory, address);
  const factoryData = optional(candidate.factoryData, bytes);
  const paymaster = optional(candidate.paymaster, address);
  const paymasterVerificationGasLimit = optional(candidate.paymasterVerificationGasLimit, decimal);
  const paymasterPostOpGasLimit = optional(candidate.paymasterPostOpGasLimit, decimal);
  const paymasterData = optional(candidate.paymasterData, bytes);
  const optionals = [factory, factoryData, paymaster, paymasterVerificationGasLimit, paymasterPostOpGasLimit, paymasterData];
  if (!sender || !callData || signature === null || quantities.some((value) => value === null) || optionals.some((value) => value === undefined)) return null;
  const [nonce, callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas] = quantities as string[];
  return {
    sender,
    nonce,
    factory: factory as string | null,
    factoryData: factoryData as string | null,
    callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster: paymaster as string | null,
    paymasterVerificationGasLimit: paymasterVerificationGasLimit as string | null,
    paymasterPostOpGasLimit: paymasterPostOpGasLimit as string | null,
    paymasterData: paymasterData as string | null,
    signature,
  };
}

/**
 * `eth_sendUserOperation` for a transaction: only an operation this server prepared for this Safe (found by its
 * hash, so any changed field finds nothing), unexpired, signed by the owner, is forwarded, and only once. Sent again
 * after it went through, it gets the bundler's hash back without being forwarded again.
 */
export async function submitTransaction(context: Omit<TransactionContext, 'rpcUrl' | 'config' | 'userId'>, candidate: Record<string, unknown>): Promise<string> {
  const { chainId, owner, account, bundler } = context;
  const normalized = fromRpcUserOperation(candidate);
  if (!normalized) throw new SponsorshipError('OPERATION_NOT_ALLOWED');
  const operationHash = userOperationHash(normalized, chainId, account).toLowerCase();
  const record = await getPreparedTransaction(chainId, account.address, operationHash);
  if (!record) throw new SponsorshipError('OPERATION_NOT_ALLOWED');
  const { userOperation: prepared, call } = JSON.parse(record.operation) as StoredTransaction;
  // A defensive check: the server built it, but nothing else is ever sent.
  if (!isAllowedTransactionCall(account.address, call) || !isTransactionOperation(prepared, call, account.address, account) || !matchesPrepared(candidate, prepared)) {
    throw new SponsorshipError('OPERATION_NOT_ALLOWED');
  }
  const signed: UserOperationJson = { ...prepared, signature: String(candidate.signature ?? '') };
  if (!(await signedByOwner(signed, chainId, owner, account))) throw new SponsorshipError('OPERATION_NOT_ALLOWED');
  if (record.status === 'sent' && record.userOpHash) return record.userOpHash;
  if (record.preparedAt <= Date.now() - TRANSACTION_TTL_MS) throw new SponsorshipError('TRANSACTION_EXPIRED');

  const key = { chainId, safe: account.address, operationHash };
  if (!(await claimPreparedTransaction({ ...key, now: Date.now(), staleSubmittingMs: STALE_SUBMITTING_MS }))) {
    // Another request won the claim: if it has already finished, this one gets the same answer.
    const current = await getPreparedTransaction(chainId, account.address, operationHash);
    if (current?.status === 'sent' && current.userOpHash) return current.userOpHash;
    throw new SponsorshipError('TRANSACTION_IN_PROGRESS');
  }

  let userOpHash: unknown;
  try {
    // The prepared operation is what is forwarded, with only the signature taken from the request.
    userOpHash = upstreamResult(await jsonRpc(bundler.url, 'eth_sendUserOperation', [toRpcUserOperation(signed), account.entryPoint], bundler.headers));
    if (typeof userOpHash !== 'string' || !USER_OP_HASH.test(userOpHash)) throw new SponsorshipError('UPSTREAM_INVALID');
  } catch (error) {
    // It did not go through (or it cannot be told): the same signed operation may be sent again.
    await releasePreparedTransaction({ ...key, now: Date.now() });
    throw error;
  }
  await completePreparedTransaction({ ...key, userOpHash, now: Date.now() });
  return userOpHash;
}
