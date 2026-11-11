import type { UserOperationJson, UserOperationRequest, VaultSignRequest } from '@wl-embedded-wallet/sdk/server';
import { ERC1271_MAGIC_VALUE, recoverSafeMessageSigner, recoverSafeOperationSigner, requestHash, userOperationMatches } from '@wl-embedded-wallet/sdk/server';
import { createPublicClient, http, isAddressEqual, type Hex } from 'viem';

const ERC1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

export interface VerifyResult {
  valid: boolean;
  recovered: `0x${string}` | null;
  // Messages and EIP-712: result of `isValidSignature` on the Safe. `null` if not applicable or it could not be read.
  erc1271: boolean | null;
}

export interface VerifyAccount {
  address: `0x${string}`;
  owner: `0x${string}`;
}

export interface VerifyChain {
  chainId: number;
  rpcUrl: string;
}

/** Asks the actual contract: that is what any third party receiving this signature will do. */
async function isValidOnChain(chain: VerifyChain, safe: `0x${string}`, hash: `0x${string}`, signature: Hex): Promise<boolean | null> {
  try {
    const client = createPublicClient({ transport: http(chain.rpcUrl) });
    if ((await client.getChainId()) !== chain.chainId) return null;
    const value = await client.readContract({ address: safe, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hash, signature] });
    return value.toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch {
    // The Safe reverts on a signature from another chain, and a failed call does not count as valid either.
    return false;
  }
}

async function verifyUserOperation(
  request: UserOperationRequest,
  operation: UserOperationJson | undefined,
  signature: Hex,
  account: VerifyAccount,
  chain: VerifyChain,
): Promise<VerifyResult> {
  if (!operation || operation.signature.toLowerCase() !== signature.toLowerCase()) return { valid: false, recovered: null, erc1271: null };
  let recovered: `0x${string}`;
  try {
    recovered = await recoverSafeOperationSigner(operation, chain.chainId);
  } catch {
    return { valid: false, recovered: null, erc1271: null };
  }
  try {
    return { valid: isAddressEqual(recovered, account.owner) && userOperationMatches(operation, request, account.address), recovered, erc1271: null };
  } catch {
    return { valid: false, recovered, erc1271: null };
  }
}

/** `account` always comes from the vault and `chain` from `DEMO_CHAINS`, never from the client. */
export async function verifySignature(
  request: VaultSignRequest,
  signature: Hex,
  account: VerifyAccount,
  chain: VerifyChain,
  operation?: UserOperationJson,
): Promise<VerifyResult> {
  if (request.kind === 'userOperation') return verifyUserOperation(request.userOperation, operation, signature, account, chain);

  let hash: `0x${string}`;
  let recovered: `0x${string}`;
  try {
    hash = requestHash(request);
    recovered = await recoverSafeMessageSigner(account.address, chain.chainId, hash, signature);
  } catch {
    return { valid: false, recovered: null, erc1271: null };
  }
  const erc1271 = await isValidOnChain(chain, account.address, hash, signature);
  return { valid: isAddressEqual(recovered, account.owner) && erc1271 === true, recovered, erc1271 };
}

export function parseSignRequest(value: unknown): VaultSignRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const request = value as Record<string, unknown>;
  if (request.kind === 'message' && typeof request.message === 'string') return request as unknown as VaultSignRequest;
  if (request.kind === 'typedData' && typeof request.typedData === 'object' && request.typedData !== null) return request as unknown as VaultSignRequest;
  if (request.kind === 'userOperation' && typeof request.userOperation === 'object' && request.userOperation !== null) return request as unknown as VaultSignRequest;
  return null;
}
