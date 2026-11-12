// Safe 4337 account (modules 0.3.0, EntryPoint v0.7), with no network access and no keys.
// Used by the worker and the vault server, and by the app's verifier.
import { ENTRYPOINT_V7, EOADummySignerSignaturePair, Operation, SafeAccountV0_3_0, createUserOperationHash, type UserOperationV7 } from 'abstractionkit';
import { getAddress, hashMessage, hashTypedData, isAddressEqual, recoverAddress, slice, type Hex, type TypedDataDefinition } from 'viem';
import type { TypedDataRequest, UserOperationJson, UserOperationRequest, VaultCall } from './operations';

export const SAFE_ACCOUNT_TYPE = 'safe-4337';
export const SAFE_MODULES_VERSION = '0.3.0';
export const ERC1271_MAGIC_VALUE = '0x1626ba7e';

// `validAfter` and `validUntil` (6 bytes each) precede the ECDSA signature inside the UserOperation signature.
const SIGNATURE_VALIDITY_BYTES = 12;
const SAFE_MESSAGE_TYPES = { SafeMessage: [{ name: 'message', type: 'bytes' }] } as const;

/**
 * Safe init parameters. Product invariant: the same address on every network,
 * so nothing that varies per network may go in here. They are signed into each user's manifest:
 * changing these defaults never changes the address of an existing wallet.
 */
export interface SafeParams {
  type: typeof SAFE_ACCOUNT_TYPE;
  safeModulesVersion: typeof SAFE_MODULES_VERSION;
  entryPoint: `0x${string}`;
  factory: `0x${string}`;
  singleton: `0x${string}`;
  singletonInitHash: `0x${string}`;
  safe4337Module: `0x${string}`;
  safeModuleSetup: `0x${string}`;
  multisend: `0x${string}`;
  saltNonce: `0x${string}`;
}

export interface SmartAccountInfo extends SafeParams {
  address: `0x${string}`;
}

// The same values as `predictSafeAddress` in `@tetherto/wdk-wallet-evm-erc-4337`, checked in the tests.
export const DEFAULT_SAFE_PARAMS: SafeParams = {
  type: SAFE_ACCOUNT_TYPE,
  safeModulesVersion: SAFE_MODULES_VERSION,
  entryPoint: ENTRYPOINT_V7 as `0x${string}`,
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  singletonInitHash: '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee',
  safe4337Module: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  safeModuleSetup: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
  multisend: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  saltNonce: '0x69b348339eea4ed93f9d11931c3b894c8f9d8c7663a053024b11cb7eb4e5a1f6',
};

function initOverrides(params: SafeParams) {
  return {
    c2Nonce: BigInt(params.saltNonce),
    entrypointAddress: params.entryPoint,
    safe4337ModuleAddress: params.safe4337Module,
    safeModuleSetupAddress: params.safeModuleSetup,
    safeAccountFactoryAddress: params.factory,
    safeAccountSingleton: { singletonAddress: params.singleton, singletonInitHash: params.singletonInitHash },
    multisendContractAddress: params.multisend,
  };
}

export function predictSafeAddress(owner: string, params: SafeParams = DEFAULT_SAFE_PARAMS): `0x${string}` {
  return getAddress(SafeAccountV0_3_0.createAccountAddress([getAddress(owner)], initOverrides(params)));
}

export function smartAccountFor(owner: string, params: SafeParams = DEFAULT_SAFE_PARAMS): SmartAccountInfo {
  const { type, safeModulesVersion, entryPoint, factory, singleton, singletonInitHash, safe4337Module, safeModuleSetup, multisend, saltNonce } = params;
  return { type, safeModulesVersion, entryPoint, factory, singleton, singletonInitHash, safe4337Module, safeModuleSetup, multisend, saltNonce, address: predictSafeAddress(owner, params) };
}

export function deploymentFactory(owner: string, params: SafeParams = DEFAULT_SAFE_PARAMS): { factory: string; factoryData: string } {
  const [factory, factoryData] = SafeAccountV0_3_0.createFactoryAddressAndData([getAddress(owner)], initOverrides(params));
  return { factory, factoryData };
}

export function encodeSafeCalls(calls: readonly VaultCall[], params: SafeParams = DEFAULT_SAFE_PARAMS): string {
  const meta = calls.map((call) => ({ to: call.to, value: BigInt(call.value), data: call.data ?? '0x', operation: Operation.Call }));
  return meta.length === 1
    ? SafeAccountV0_3_0.createAccountCallDataSingleTransaction(meta[0]!)
    : SafeAccountV0_3_0.createAccountCallDataBatchTransactions(meta, { multisendContractAddress: params.multisend });
}

/** An empty, zero-value call to the Safe itself: the only thing the sponsored deployment executes. */
export function deploymentCalls(safe: `0x${string}`): VaultCall[] {
  return [{ to: safe, value: '0', data: '0x' }];
}

export function dummySafeSignature(): string {
  return SafeAccountV0_3_0.formatSignaturesToUseroperationSignature([EOADummySignerSignaturePair]);
}

const UNSET_PAYMASTER = {
  paymaster: null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit: null,
  paymasterData: null,
};

/** Unsigned UserOperation for a deployed Safe. Never carries `factory`. */
export function buildUserOperation(safe: `0x${string}`, request: UserOperationRequest, params: SafeParams = DEFAULT_SAFE_PARAMS): UserOperationJson {
  return {
    sender: safe,
    nonce: request.nonce,
    factory: null,
    factoryData: null,
    callData: encodeSafeCalls(request.calls, params),
    callGasLimit: request.callGasLimit,
    verificationGasLimit: request.verificationGasLimit,
    preVerificationGas: request.preVerificationGas,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    ...UNSET_PAYMASTER,
    signature: '0x',
  };
}

export function buildDeploymentOperation(
  owner: string,
  fees: { maxFeePerGas: string; maxPriorityFeePerGas: string },
  params: SafeParams = DEFAULT_SAFE_PARAMS,
): UserOperationJson {
  const safe = predictSafeAddress(owner, params);
  return {
    sender: safe,
    nonce: '0',
    ...deploymentFactory(owner, params),
    callData: encodeSafeCalls(deploymentCalls(safe), params),
    callGasLimit: '0',
    verificationGasLimit: '0',
    preVerificationGas: '0',
    ...fees,
    ...UNSET_PAYMASTER,
    signature: dummySafeSignature(),
  };
}

const sameHex = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

function sameQuantity(a: unknown, b: unknown): boolean {
  try {
    return BigInt(a as string) === BigInt(b as string);
  } catch {
    return false;
  }
}

function sameAddress(a: unknown, b: string): boolean {
  try {
    return isAddressEqual(a as `0x${string}`, b as `0x${string}`);
  } catch {
    return false;
  }
}

/**
 * The only operation that is sponsored and sent: deploying this owner's Safe. Accepts quantities in
 * decimal or hex, because it also validates what arrives over JSON-RPC.
 */
export function isDeploymentOperation(operation: Record<string, unknown> | null | undefined, owner: string, params: SafeParams = DEFAULT_SAFE_PARAMS): boolean {
  if (!operation) return false;
  const safe = predictSafeAddress(owner, params);
  const { factory, factoryData } = deploymentFactory(owner, params);
  return (
    sameAddress(operation.sender, safe) &&
    sameAddress(operation.factory, factory) &&
    typeof operation.factoryData === 'string' &&
    sameHex(operation.factoryData, factoryData) &&
    typeof operation.callData === 'string' &&
    sameHex(operation.callData, encodeSafeCalls(deploymentCalls(safe), params)) &&
    sameQuantity(operation.nonce, 0)
  );
}

/**
 * A call from the Safe to itself with data could change its owners, modules or guard and break the Shamir model:
 * the vault never builds or signs one. A plain transfer of value to itself is harmless and allowed.
 */
export function isAllowedTransactionCall(safe: `0x${string}`, call: VaultCall): boolean {
  return !(sameAddress(call.to, safe) && Boolean(call.data) && call.data !== '0x');
}

/** Unsigned operation for one call from a deployed Safe, with a dummy signature for estimation and gas still at 0. */
export function buildTransactionOperation(
  safe: `0x${string}`,
  call: VaultCall,
  nonce: string,
  fees: { maxFeePerGas: string; maxPriorityFeePerGas: string },
  params: SafeParams = DEFAULT_SAFE_PARAMS,
): UserOperationJson {
  return {
    sender: safe,
    nonce,
    factory: null,
    factoryData: null,
    callData: encodeSafeCalls([call], params),
    callGasLimit: '0',
    verificationGasLimit: '0',
    preVerificationGas: '0',
    ...fees,
    ...UNSET_PAYMASTER,
    signature: dummySafeSignature(),
  };
}

/**
 * The operation executes exactly `call` from this deployed Safe: no `factory`, and `callData` is
 * `executeUserOpWithErrorString(to, value, data, CALL)` for that call (abstractionkit's encoding). Since `callData` is compared byte for byte, a delegatecall or a
 * batch never matches.
 */
export function isTransactionOperation(operation: Record<string, unknown> | null | undefined, call: VaultCall, safe: `0x${string}`, params: SafeParams = DEFAULT_SAFE_PARAMS): boolean {
  if (!operation) return false;
  const noFactory = (value: unknown) => value === undefined || value === null;
  return (
    sameAddress(operation.sender, safe) &&
    noFactory(operation.factory) &&
    noFactory(operation.factoryData) &&
    typeof operation.callData === 'string' &&
    sameHex(operation.callData, encodeSafeCalls([call], params))
  );
}

/** The signature covers the UserOperation's contents, so they must be compared with what was requested. */
export function userOperationMatches(operation: UserOperationJson, request: UserOperationRequest, safe: `0x${string}`, params: SafeParams = DEFAULT_SAFE_PARAMS): boolean {
  const expected = buildUserOperation(safe, request, params);
  return (
    sameAddress(operation.sender, safe) &&
    operation.factory === null &&
    operation.factoryData === null &&
    sameHex(operation.callData, expected.callData) &&
    (['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).every((key) =>
      sameQuantity(operation[key], expected[key]),
    ) &&
    operation.paymaster === null
  );
}

const optionalBigInt = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

export function toUserOperationV7(operation: UserOperationJson): UserOperationV7 {
  return {
    sender: operation.sender,
    nonce: BigInt(operation.nonce),
    factory: operation.factory,
    factoryData: operation.factoryData,
    callData: operation.callData,
    callGasLimit: BigInt(operation.callGasLimit),
    verificationGasLimit: BigInt(operation.verificationGasLimit),
    preVerificationGas: BigInt(operation.preVerificationGas),
    maxFeePerGas: BigInt(operation.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(operation.maxPriorityFeePerGas),
    paymaster: operation.paymaster,
    paymasterVerificationGasLimit: optionalBigInt(operation.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: optionalBigInt(operation.paymasterPostOpGasLimit),
    paymasterData: operation.paymasterData,
    signature: operation.signature,
  };
}

const quantity = (value: string) => `0x${BigInt(value).toString(16)}`;

/** ERC-7769 JSON-RPC shape: hex quantities, with empty fields omitted. */
export function toRpcUserOperation(operation: UserOperationJson): Record<string, string> {
  return {
    sender: operation.sender,
    nonce: quantity(operation.nonce),
    ...(operation.factory ? { factory: operation.factory, factoryData: operation.factoryData ?? '0x' } : {}),
    callData: operation.callData,
    callGasLimit: quantity(operation.callGasLimit),
    verificationGasLimit: quantity(operation.verificationGasLimit),
    preVerificationGas: quantity(operation.preVerificationGas),
    maxFeePerGas: quantity(operation.maxFeePerGas),
    maxPriorityFeePerGas: quantity(operation.maxPriorityFeePerGas),
    ...(operation.paymaster
      ? {
          paymaster: operation.paymaster,
          paymasterVerificationGasLimit: quantity(operation.paymasterVerificationGasLimit ?? '0'),
          paymasterPostOpGasLimit: quantity(operation.paymasterPostOpGasLimit ?? '0'),
          paymasterData: operation.paymasterData ?? '0x',
        }
      : {}),
    signature: operation.signature,
  };
}

export function safeOperationHash(operation: UserOperationJson, chainId: number, params: SafeParams = DEFAULT_SAFE_PARAMS): `0x${string}` {
  return SafeAccountV0_3_0.getUserOperationEip712Hash(toUserOperationV7(operation), BigInt(chainId), {
    entrypointAddress: params.entryPoint,
    safe4337ModuleAddress: params.safe4337Module,
  }) as `0x${string}`;
}

export function userOperationHash(operation: UserOperationJson, chainId: number, params: SafeParams = DEFAULT_SAFE_PARAMS): `0x${string}` {
  return createUserOperationHash(toUserOperationV7(operation), params.entryPoint, BigInt(chainId)) as `0x${string}`;
}

/** Signs with an external signer: the private key never leaves the signer. */
export function signSafeOperation(
  operation: UserOperationJson,
  chainId: number,
  params: SafeParams,
  signer: { address: `0x${string}`; signHash(hash: `0x${string}`): Promise<`0x${string}`> },
): Promise<string> {
  const account = new SafeAccountV0_3_0(operation.sender, { entrypointAddress: params.entryPoint, safe4337ModuleAddress: params.safe4337Module });
  return account.signUserOperationWithSigners(toUserOperationV7(operation), [{ address: signer.address, signHash: (hash: string) => signer.signHash(hash as `0x${string}`) }], BigInt(chainId));
}

export async function recoverSafeOperationSigner(operation: UserOperationJson, chainId: number, params: SafeParams = DEFAULT_SAFE_PARAMS): Promise<`0x${string}`> {
  return recoverAddress({
    hash: safeOperationHash(operation, chainId, params),
    signature: slice(operation.signature as Hex, SIGNATURE_VALIDITY_BYTES),
  });
}

export type SafeMessageRequest = { kind: 'message'; message: string } | { kind: 'typedData'; typedData: TypedDataRequest };

/** What `isValidSignature(bytes32,bytes)` receives: the EIP-191 or EIP-712 hash of the request. */
export function requestHash(request: SafeMessageRequest): `0x${string}` {
  return request.kind === 'message' ? hashMessage(request.message) : hashTypedData(request.typedData as unknown as TypedDataDefinition);
}

/** The owner signs this: the `SafeMessage` of the hash, bound to the Safe and the network, as Safe's ERC-1271 requires. */
export function safeMessageTypedData(safe: `0x${string}`, chainId: number, hash: `0x${string}`) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_MESSAGE_TYPES,
    primaryType: 'SafeMessage',
    message: { message: hash },
  } as const;
}

export function recoverSafeMessageSigner(safe: `0x${string}`, chainId: number, hash: `0x${string}`, signature: `0x${string}`): Promise<`0x${string}`> {
  return recoverAddress({ hash: hashTypedData(safeMessageTypedData(safe, chainId, hash)), signature });
}
