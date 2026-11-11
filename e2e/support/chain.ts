import { createPublicClient, hashMessage, hashTypedData, http, parseAbi, type Hex, type TypedDataDefinition } from 'viem';
import { runState } from './harness.ts';

const ENTRY_POINT_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const ERC1271_ABI = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
export const ERC1271_MAGIC = '0x1626ba7e';

function client(chainId: number) {
  return createPublicClient({ transport: http(runState().chains[chainId].rpcUrl) });
}

export function codeAt(chainId: number, address: `0x${string}`): Promise<Hex | undefined> {
  return client(chainId).getCode({ address });
}

export function balanceOf(chainId: number, address: `0x${string}`): Promise<bigint> {
  return client(chainId).getBalance({ address });
}

export function paymasterDeposit(chainId: number): Promise<bigint> {
  const state = runState();
  return client(chainId).readContract({
    address: state.entryPoint,
    abi: ENTRY_POINT_ABI,
    functionName: 'balanceOf',
    args: [state.chains[chainId].paymasterAddress as `0x${string}`],
  });
}

/** Asks the Safe contract directly, bypassing the demo and vault code. */
export async function erc1271(chainId: number, safe: `0x${string}`, message: string, signature: Hex): Promise<string> {
  try {
    return await client(chainId).readContract({ address: safe, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hashMessage(message), signature] });
  } catch {
    return 'revert';
  }
}

/** The same for an EIP-712 signature. */
export async function erc1271Typed(chainId: number, safe: `0x${string}`, typedData: unknown, signature: Hex): Promise<string> {
  try {
    return await client(chainId).readContract({ address: safe, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hashTypedData(typedData as TypedDataDefinition), signature] });
  } catch {
    return 'revert';
  }
}
