import type { UserOperationJson } from '@wl-embedded-wallet/core/operations';
import { isRecord } from '@wl-embedded-wallet/core/schema';
import {
  buildDeploymentOperation,
  isDeploymentOperation,
  recoverSafeOperationSigner,
  toRpcUserOperation,
  userOperationHash,
  type SmartAccountInfo,
} from '@wl-embedded-wallet/core/safe';
import { getAddress, isAddress, isAddressEqual } from 'viem';
import { ChainError, jsonRpc, type ChainConfig, type RpcOutcome } from './chains';
import { sponsorshipLimits, type SponsorshipLimits } from './limits';
import {
  claimSponsoredDeployment,
  completeSponsoredDeployment,
  getSponsoredDeployment,
  prepareSponsoredDeployment,
  releaseSponsoredDeployment,
  type SponsoredDeploymentRecord,
} from './store';

/**
 * The deployment UserOperation is built here, never by the browser: fees come from the node (with the bundler's quote
 * as a floor when it gives one), gas from the bundler
 * and the paymaster fields from the paymaster, each within the caps of `sponsorshipLimits`. The page only signs it,
 * and only that exact operation, with the owner's signature, is ever sent, once per Safe and chain.
 */

// The estimated limits leave headroom for state changes between estimation and submission.
export const GAS_MARGIN_PERCENT = 120n;
// Longer than an upstream call can take (10 s): a `submitting` row this old belongs to a process that died mid-send.
export const STALE_SUBMITTING_MS = 60_000;
const MAX_PAYMASTER_DATA_BYTES = 4096;
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const USER_OP_HASH = /^0x[0-9a-fA-F]{64}$/;
// `validAfter` and `validUntil` (6 bytes each) and one 65-byte ECDSA signature: a Safe with a single EOA owner.
const SAFE_SIGNATURE = /^0x[0-9a-fA-F]{154}$/;

export type SponsorshipErrorCode =
  | 'FEES_TOO_HIGH'
  | 'GAS_LIMIT_EXCEEDED'
  | 'UPSTREAM_INVALID'
  | 'ALREADY_SPONSORED'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'DEPLOYMENT_NOT_PREPARED'
  | 'OPERATION_NOT_ALLOWED'
  | 'ALREADY_DEPLOYED';

const STATUS: Record<SponsorshipErrorCode, number> = {
  FEES_TOO_HIGH: 409,
  GAS_LIMIT_EXCEEDED: 409,
  UPSTREAM_INVALID: 502,
  ALREADY_SPONSORED: 409,
  DEPLOYMENT_IN_PROGRESS: 409,
  DEPLOYMENT_NOT_PREPARED: 409,
  OPERATION_NOT_ALLOWED: 403,
  ALREADY_DEPLOYED: 409,
};

/** Never says which field or check failed. */
export class SponsorshipError extends Error {
  readonly code: SponsorshipErrorCode;
  readonly status: number;

  constructor(code: SponsorshipErrorCode) {
    super(code);
    this.name = 'SponsorshipError';
    this.code = code;
    this.status = STATUS[code];
  }
}

/** The bundler or paymaster answered with a JSON-RPC error. Its message is already sanitized by `jsonRpc`. */
export class UpstreamError extends Error {
  readonly rpcMessage: string;

  constructor(rpcMessage: string) {
    super('UPSTREAM_ERROR');
    this.name = 'UpstreamError';
    this.rpcMessage = rpcMessage;
  }
}

export interface DeploymentContext {
  chainId: number;
  userId: string;
  owner: string;
  account: SmartAccountInfo;
  config: ChainConfig;
  /** Node RPC, already checked with `assertRpcChain`. */
  rpcUrl: string;
  bundler: { url: string; headers?: Record<string, string> };
}

function upstreamResult(outcome: RpcOutcome): unknown {
  if ('error' in outcome) throw new UpstreamError(outcome.error.message);
  return outcome.result;
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) throw new SponsorshipError('UPSTREAM_INVALID');
  return BigInt(value);
}

async function nodeQuantity(url: string, method: 'eth_gasPrice' | 'eth_maxPriorityFeePerGas'): Promise<bigint> {
  const outcome = await jsonRpc(url, method, []);
  if ('error' in outcome) throw new ChainError('CHAIN_UNAVAILABLE');
  try {
    return quantity(outcome.result);
  } catch {
    throw new ChainError('CHAIN_UNAVAILABLE');
  }
}

/** What the bundler says it accepts now. `null` when it has no such method or answers something else. */
export interface BundlerGasPrice {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * `pimlico_getUserOperationGasPrice`, `standard` tier. Pimlico (alto) refuses `eth_sendUserOperation` below its own
 * recent quotes, which on some testnets are orders of magnitude above what the node reports (Sepolia: a 50 wei tip
 * from the node, 0.001 to 0.7 gwei from Pimlico). Any other bundler answers `method not found`, or fails, and the
 * node's values are used alone: this is a floor, never the only source.
 */
export async function bundlerGasPrice(bundler: { url: string; headers?: Record<string, string> }): Promise<BundlerGasPrice | null> {
  try {
    const outcome = await jsonRpc(bundler.url, 'pimlico_getUserOperationGasPrice', [], bundler.headers);
    if ('error' in outcome || !isRecord(outcome.result) || !isRecord(outcome.result.standard)) return null;
    const { maxFeePerGas, maxPriorityFeePerGas } = outcome.result.standard;
    return { maxFeePerGas: quantity(maxFeePerGas), maxPriorityFeePerGas: quantity(maxPriorityFeePerGas) };
  } catch {
    return null;
  }
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * From the network's values and, when given, the bundler's quote, which is a floor for both fees:
 * - tip = max(node tip, bundler tip) * priorityFeeMultiplierPercent / 100;
 * - `maxFeePerGas` = max(gasPrice * feeMultiplierPercent / 100 + tip, bundler max fee * priorityFeeMultiplierPercent / 100),
 *   clamped to the cap, and the tip never above it.
 * A network (or bundler) already priced above the cap is refused rather than underpriced: an operation below the
 * bundler's floor would only be rejected at send time.
 */
export function deploymentFees(
  gasPrice: bigint,
  priority: bigint,
  limits: SponsorshipLimits,
  quote: BundlerGasPrice | null = null,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const cap = limits.maxFeePerGas;
  if (gasPrice > cap || priority > cap || (quote && (quote.maxFeePerGas > cap || quote.maxPriorityFeePerGas > cap))) throw new SponsorshipError('FEES_TOO_HIGH');
  const tip = (max(priority, quote?.maxPriorityFeePerGas ?? 0n) * limits.priorityFeeMultiplierPercent) / 100n;
  const fromNode = (gasPrice * limits.feeMultiplierPercent) / 100n + tip;
  const fromBundler = quote ? (quote.maxFeePerGas * limits.priorityFeeMultiplierPercent) / 100n : 0n;
  const wanted = max(fromNode, fromBundler);
  const maxFeePerGas = wanted < cap ? wanted : cap;
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

/** The estimate plus the margin, clamped to the cap. An estimate already above the cap is refused. */
export function gasWithMargin(estimate: bigint, cap: bigint): bigint {
  if (estimate > cap) throw new SponsorshipError('GAS_LIMIT_EXCEEDED');
  const padded = (estimate * GAS_MARGIN_PERCENT) / 100n;
  return padded < cap ? padded : cap;
}

function withinCap(value: bigint, cap: bigint): bigint {
  if (value > cap) throw new SponsorshipError('GAS_LIMIT_EXCEEDED');
  return value;
}

/** ERC-7677 result: the paymaster address and data always, its gas limits when it gives them. */
function applyPaymaster(operation: UserOperationJson, result: unknown, limits: SponsorshipLimits): UserOperationJson {
  if (!isRecord(result)) throw new SponsorshipError('UPSTREAM_INVALID');
  const { paymaster, paymasterData, paymasterVerificationGasLimit, paymasterPostOpGasLimit } = result;
  if (typeof paymaster !== 'string' || !isAddress(paymaster, { strict: false })) throw new SponsorshipError('UPSTREAM_INVALID');
  if (typeof paymasterData !== 'string' || !HEX_BYTES.test(paymasterData) || paymasterData.length > 2 + 2 * MAX_PAYMASTER_DATA_BYTES) {
    throw new SponsorshipError('UPSTREAM_INVALID');
  }
  const optional = (value: unknown, cap: bigint, current: string | null) => (value === undefined || value === null ? current : withinCap(quantity(value), cap).toString());
  return {
    ...operation,
    paymaster: getAddress(paymaster),
    paymasterData: paymasterData.toLowerCase(),
    paymasterVerificationGasLimit: optional(paymasterVerificationGasLimit, limits.maxPaymasterVerificationGasLimit, operation.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: optional(paymasterPostOpGasLimit, limits.maxPaymasterPostOpGasLimit, operation.paymasterPostOpGasLimit),
  };
}

/** Builds the deployment: fees from the node and the bundler's quote, stub data, estimate within the caps, final paymaster data. Unsigned. */
export async function buildSponsoredDeployment(context: DeploymentContext): Promise<UserOperationJson> {
  const { chainId, owner, account, config, rpcUrl, bundler } = context;
  const limits = sponsorshipLimits(chainId);
  const [gasPrice, priority, quote] = await Promise.all([
    nodeQuantity(rpcUrl, 'eth_gasPrice'),
    nodeQuantity(rpcUrl, 'eth_maxPriorityFeePerGas'),
    bundlerGasPrice(bundler),
  ]);
  const fees = deploymentFees(gasPrice, priority, limits, quote);
  let operation = buildDeploymentOperation(owner, { maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }, account);
  const paymasterUrl = config.paymasterUrl;
  // The server decides the sponsorship context: the browser does not choose the policy.
  const paymasterCall = async (method: 'pm_getPaymasterStubData' | 'pm_getPaymasterData') =>
    upstreamResult(
      await jsonRpc(paymasterUrl as string, method, [toRpcUserOperation(operation), account.entryPoint, `0x${chainId.toString(16)}`, config.paymasterContext ?? {}], config.paymasterHeaders),
    );

  if (paymasterUrl) operation = applyPaymaster(operation, await paymasterCall('pm_getPaymasterStubData'), limits);

  const gas = upstreamResult(await jsonRpc(bundler.url, 'eth_estimateUserOperationGas', [toRpcUserOperation(operation), account.entryPoint], bundler.headers));
  if (!isRecord(gas)) throw new SponsorshipError('UPSTREAM_INVALID');
  operation = {
    ...operation,
    callGasLimit: gasWithMargin(quantity(gas.callGasLimit), limits.maxCallGasLimit).toString(),
    verificationGasLimit: gasWithMargin(quantity(gas.verificationGasLimit), limits.maxVerificationGasLimit).toString(),
    preVerificationGas: gasWithMargin(quantity(gas.preVerificationGas), limits.maxPreVerificationGas).toString(),
  };
  if (paymasterUrl) {
    if (gas.paymasterVerificationGasLimit != null) {
      operation.paymasterVerificationGasLimit = gasWithMargin(quantity(gas.paymasterVerificationGasLimit), limits.maxPaymasterVerificationGasLimit).toString();
    }
    if (gas.paymasterPostOpGasLimit != null) {
      operation.paymasterPostOpGasLimit = gasWithMargin(quantity(gas.paymasterPostOpGasLimit), limits.maxPaymasterPostOpGasLimit).toString();
    }
    operation = applyPaymaster(operation, await paymasterCall('pm_getPaymasterData'), limits);
    // EntryPoint v0.7 packs both paymaster gas limits: one that nobody gave cannot be guessed here.
    if (operation.paymasterVerificationGasLimit === null || operation.paymasterPostOpGasLimit === null) throw new SponsorshipError('UPSTREAM_INVALID');
  }
  return { ...operation, signature: '0x' };
}

function recentlyBusy(record: SponsoredDeploymentRecord | null, now: number, retryMs: number): SponsorshipErrorCode | null {
  if (record?.status === 'submitting' && record.updatedAt > now - STALE_SUBMITTING_MS) return 'DEPLOYMENT_IN_PROGRESS';
  if (record?.status === 'sent' && record.updatedAt > now - retryMs) return 'ALREADY_SPONSORED';
  return null;
}

/**
 * `vault_prepareDeployment`: builds and records the operation the page will sign. The caller has already checked that
 * the Safe is not deployed and is deployable. A deployment being sent, or sent within the retry window, blocks a new one.
 */
export async function prepareDeployment(context: DeploymentContext): Promise<UserOperationJson> {
  const { chainId, userId, account } = context;
  const { deploymentRetryMs } = sponsorshipLimits(chainId);
  // Checked before asking the paymaster, so a blocked Safe costs no upstream calls.
  const blocked = recentlyBusy(await getSponsoredDeployment(chainId, account.address), Date.now(), deploymentRetryMs);
  if (blocked) throw new SponsorshipError(blocked);

  const operation = await buildSponsoredDeployment(context);
  const now = Date.now();
  const written = await prepareSponsoredDeployment({
    chainId,
    safe: account.address,
    userId,
    operation: JSON.stringify(operation),
    operationHash: userOperationHash(operation, chainId, account),
    now,
    staleSubmittingMs: STALE_SUBMITTING_MS,
    retrySentAfterMs: deploymentRetryMs,
  });
  if (!written) throw new SponsorshipError(recentlyBusy(await getSponsoredDeployment(chainId, account.address), now, deploymentRetryMs) ?? 'DEPLOYMENT_IN_PROGRESS');
  return operation;
}

const QUANTITY_FIELDS = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
const OPERATION_FIELDS = new Set<string>([
  'sender',
  'factory',
  'factoryData',
  'callData',
  ...QUANTITY_FIELDS,
  'paymaster',
  'paymasterVerificationGasLimit',
  'paymasterPostOpGasLimit',
  'paymasterData',
  'signature',
]);

const absent = (value: unknown) => value === undefined || value === null;

function sameQuantity(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) return false;
  return BigInt(value) === BigInt(expected);
}

function sameAddress(value: unknown, expected: string): boolean {
  return typeof value === 'string' && isAddress(value, { strict: false }) && isAddressEqual(value, expected as `0x${string}`);
}

const sameHex = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();

/**
 * Every field except `signature` equals the prepared one: quantities in decimal or hex, addresses and bytes in any case,
 * and a field the prepared operation does not have must be missing or `null`. Any other key is refused.
 */
export function matchesPrepared(candidate: Record<string, unknown>, prepared: UserOperationJson): boolean {
  if (Object.keys(candidate).some((key) => !OPERATION_FIELDS.has(key))) return false;
  type Optional = 'factory' | 'factoryData' | 'paymaster' | 'paymasterData' | 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit';
  const optional = (key: Optional, compare: (value: unknown, expected: string) => boolean) =>
    prepared[key] === null ? absent(candidate[key]) : compare(candidate[key], prepared[key] as string);
  return (
    sameAddress(candidate.sender, prepared.sender) &&
    optional('factory', sameAddress) &&
    optional('factoryData', sameHex) &&
    sameHex(candidate.callData, prepared.callData) &&
    QUANTITY_FIELDS.every((key) => sameQuantity(candidate[key], prepared[key])) &&
    optional('paymaster', sameAddress) &&
    optional('paymasterData', sameHex) &&
    optional('paymasterVerificationGasLimit', sameQuantity) &&
    optional('paymasterPostOpGasLimit', sameQuantity)
  );
}

async function signedByOwner(operation: UserOperationJson, chainId: number, owner: string, account: SmartAccountInfo): Promise<boolean> {
  if (!SAFE_SIGNATURE.test(operation.signature)) return false;
  try {
    return isAddressEqual(await recoverSafeOperationSigner(operation, chainId, account), owner as `0x${string}`);
  } catch {
    return false;
  }
}

/**
 * `eth_sendUserOperation`: only the prepared operation, signed by the owner, is forwarded, and only once. The same
 * operation sent again after it went through gets the bundler's hash back without forwarding it again.
 * `assertNotDeployed` runs just before the claim.
 */
export async function submitDeployment(
  context: Omit<DeploymentContext, 'rpcUrl' | 'config' | 'userId'>,
  candidate: Record<string, unknown>,
  assertNotDeployed: () => Promise<void>,
): Promise<string> {
  const { chainId, owner, account, bundler } = context;
  const record = await getSponsoredDeployment(chainId, account.address);
  if (!record) throw new SponsorshipError('DEPLOYMENT_NOT_PREPARED');
  const prepared = JSON.parse(record.operation) as UserOperationJson;
  // A defensive check: the server built it, but nothing else is ever sent.
  if (!isDeploymentOperation(prepared, owner, account)) throw new SponsorshipError('OPERATION_NOT_ALLOWED');
  if (!matchesPrepared(candidate, prepared)) throw new SponsorshipError(record.status === 'sent' ? 'ALREADY_SPONSORED' : 'OPERATION_NOT_ALLOWED');
  const signed: UserOperationJson = { ...prepared, signature: String(candidate.signature ?? '') };
  if (!(await signedByOwner(signed, chainId, owner, account))) throw new SponsorshipError('OPERATION_NOT_ALLOWED');
  if (record.status === 'sent' && record.userOpHash) return record.userOpHash;

  await assertNotDeployed();
  const key = { chainId, safe: account.address, operationHash: record.operationHash };
  if (!(await claimSponsoredDeployment({ ...key, now: Date.now(), staleSubmittingMs: STALE_SUBMITTING_MS }))) {
    // Another request won the claim: if it has already finished, this one gets the same answer.
    const current = await getSponsoredDeployment(chainId, account.address);
    if (current?.status === 'sent' && current.operationHash === record.operationHash && current.userOpHash) return current.userOpHash;
    throw new SponsorshipError('DEPLOYMENT_IN_PROGRESS');
  }

  let userOpHash: unknown;
  try {
    // The prepared operation is what is forwarded, with only the signature taken from the request.
    userOpHash = upstreamResult(await jsonRpc(bundler.url, 'eth_sendUserOperation', [toRpcUserOperation(signed), account.entryPoint], bundler.headers));
    if (typeof userOpHash !== 'string' || !USER_OP_HASH.test(userOpHash)) throw new SponsorshipError('UPSTREAM_INVALID');
  } catch (error) {
    // It did not go through (or it cannot be told): the same signed operation may be sent again.
    await releaseSponsoredDeployment({ ...key, now: Date.now() });
    throw error;
  }
  await completeSponsoredDeployment({ ...key, userOpHash, now: Date.now() });
  return userOpHash;
}

/** `eth_getUserOperationReceipt` is only for the hash the bundler gave for this Safe's deployment on this chain. */
export async function isRecordedUserOpHash(chainId: number, safe: string, userOpHash: string): Promise<boolean> {
  const record = await getSponsoredDeployment(chainId, safe);
  return record?.status === 'sent' && typeof record.userOpHash === 'string' && record.userOpHash.toLowerCase() === userOpHash.toLowerCase();
}
