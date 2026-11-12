import { deploymentFactory, type SmartAccountInfo } from '@wl-embedded-wallet/core/safe';
import { getAddress, isAddress } from 'viem';
import type { ChainStatus } from '@wl-embedded-wallet/core/types';
import { allowsInsecureLocal, isLocalHost } from './config';

const RPC_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const EMPTY_CODE = new Set(['0x', '0x0', '']);
const KNOWN_CHAINS: Record<number, { name: string; nativeCurrency: string }> = {
  1: { name: 'Ethereum', nativeCurrency: 'ETH' },
  10: { name: 'Optimism', nativeCurrency: 'ETH' },
  137: { name: 'Polygon', nativeCurrency: 'POL' },
  8453: { name: 'Base', nativeCurrency: 'ETH' },
  42161: { name: 'Arbitrum One', nativeCurrency: 'ETH' },
  80002: { name: 'Polygon Amoy', nativeCurrency: 'POL' },
  84532: { name: 'Base Sepolia', nativeCurrency: 'ETH' },
  11155111: { name: 'Sepolia', nativeCurrency: 'ETH' },
};
/** What a network not in `KNOWN_CHAINS` and without `nativeCurrency` in `AA_CHAINS` shows. */
export const DEFAULT_NATIVE_CURRENCY = 'ETH';

export type ChainErrorCode = 'CHAIN_NOT_SUPPORTED' | 'CHAIN_MISMATCH' | 'CHAIN_UNAVAILABLE';

/** Never includes the URL: it may contain an API key. */
export class ChainError extends Error {
  readonly code: ChainErrorCode;

  constructor(code: ChainErrorCode) {
    super(code);
    this.name = 'ChainError';
    this.code = code;
  }
}

export interface ChainConfig {
  name?: string;
  /** Symbol of the native currency, shown next to amounts and fees (`ETH`, `POL`…). */
  nativeCurrency?: string;
  rpcUrl?: string;
  bundlerUrl?: string;
  bundlerHeaders?: Record<string, string>;
  paymasterUrl?: string;
  paymasterHeaders?: Record<string, string>;
  paymasterContext?: Record<string, unknown>;
  /**
   * Opt-in: the paymaster also sponsors transactions from deployed Safes (`vault_prepareTransaction`), not only
   * deployments. Arbitrary calls can drain the paymaster: see docs/THREAT-MODEL.md. Default `false`.
   */
  sponsorTransactions?: boolean;
  /** Per-chain sponsorship caps, read by `sponsorshipLimits` in `server/limits.ts`. */
  limits?: Record<string, unknown>;
}

/** Transactions are sponsored only with a paymaster and the explicit `sponsorTransactions: true`. */
export function transactionsSponsored(config: ChainConfig): boolean {
  return Boolean(config.paymasterUrl) && config.sponsorTransactions === true;
}

export interface SessionChain {
  chainId: number;
  rpcUrl?: string | null;
}

export function chainConfig(chainId: number): ChainConfig {
  try {
    const all = JSON.parse(process.env.AA_CHAINS ?? '{}') as Record<string, ChainConfig>;
    return all[String(chainId)] ?? {};
  } catch {
    return {};
  }
}

function allowedRpcHosts(): string[] {
  return (process.env.RPC_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * RPC that comes in the token: HTTPS, no credentials, and its host on the allowlist. HTTP only on a local host and only
 * in insecure local mode, with the same rules as the configured URLs (`server/config.ts`).
 */
export function isAllowedRpcUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const insecureAllowed = url.protocol === 'http:' && allowsInsecureLocal() && isLocalHost(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !insecureAllowed) return false;
  return allowedRpcHosts().includes(url.hostname.toLowerCase());
}

/** The configured RPC takes precedence over the token's: the former may carry an API key. */
export function resolveRpcUrl(chain: SessionChain): string {
  const configured = chainConfig(chain.chainId).rpcUrl;
  if (configured) return configured;
  if (chain.rpcUrl && isAllowedRpcUrl(chain.rpcUrl)) return chain.rpcUrl;
  throw new ChainError('CHAIN_NOT_SUPPORTED');
}

export type RpcOutcome = { result: unknown } | { error: { code: number; message: string } };

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ChainError('CHAIN_UNAVAILABLE');
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** No redirects, with a timeout and a maximum size. Errors never include the URL. */
export async function jsonRpc(url: string, method: string, params: unknown[], headers: Record<string, string> = {}): Promise<RpcOutcome> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const body = JSON.parse(await readLimited(response)) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (body.error) {
      return { error: { code: Number(body.error.code ?? -32000), message: String(body.error.message ?? '').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300) } };
    }
    if (!('result' in body)) throw new ChainError('CHAIN_UNAVAILABLE');
    return { result: body.result };
  } catch {
    throw new ChainError('CHAIN_UNAVAILABLE');
  }
}

async function rpcResult(url: string, method: string, params: unknown[]): Promise<unknown> {
  const outcome = await jsonRpc(url, method, params);
  if ('error' in outcome) throw new ChainError('CHAIN_UNAVAILABLE');
  return outcome.result;
}

const hasCode = (code: unknown) => typeof code === 'string' && !EMPTY_CODE.has(code);

/** Before using an RPC: it must belong to the network it claims to be. */
export async function assertRpcChain(url: string, chainId: number): Promise<void> {
  const reported = await rpcResult(url, 'eth_chainId', []);
  let matches = false;
  try {
    matches = BigInt(reported as string) === BigInt(chainId);
  } catch {
    // A response that is not a number does not match either.
  }
  if (!matches) throw new ChainError('CHAIN_MISMATCH');
}

/**
 * Invariant: the same address on every network. This checks that deploying on this network
 * would yield exactly the expected one. If not (zkSync, another factory…), the network is not supported: never another address.
 */
async function assertDeployable(url: string, owner: string, account: SmartAccountInfo): Promise<void> {
  const contracts = [account.factory, account.singleton, account.safe4337Module, account.safeModuleSetup, account.entryPoint];
  for (const address of contracts) {
    if (!hasCode(await rpcResult(url, 'eth_getCode', [address, 'latest']))) throw new ChainError('CHAIN_NOT_SUPPORTED');
  }
  const { factoryData } = deploymentFactory(owner, account);
  const simulated = await jsonRpc(url, 'eth_call', [{ to: account.factory, data: factoryData }, 'latest']);
  if ('error' in simulated || typeof simulated.result !== 'string' || simulated.result.length !== 66) throw new ChainError('CHAIN_NOT_SUPPORTED');
  const returned = `0x${simulated.result.slice(26)}`;
  if (!isAddress(returned, { strict: false }) || getAddress(returned) !== getAddress(account.address)) throw new ChainError('CHAIN_NOT_SUPPORTED');
}

export async function chainStatus(chain: SessionChain, owner: string, account: SmartAccountInfo): Promise<ChainStatus> {
  const url = resolveRpcUrl(chain);
  await assertRpcChain(url, chain.chainId);
  const config = chainConfig(chain.chainId);
  const common = {
    chainId: chain.chainId,
    chainName: config.name ?? KNOWN_CHAINS[chain.chainId]?.name ?? 'Unnamed network',
    nativeCurrency: config.nativeCurrency ?? KNOWN_CHAINS[chain.chainId]?.nativeCurrency ?? DEFAULT_NATIVE_CURRENCY,
    rpcHost: new URL(url).host,
    sponsored: Boolean(config.paymasterUrl),
    transactionsSponsored: transactionsSponsored(config),
    bundler: Boolean(config.bundlerUrl),
  };
  if (hasCode(await rpcResult(url, 'eth_getCode', [account.address, 'latest']))) {
    return { ...common, deployed: true, deployable: false, balance: null };
  }
  await assertDeployable(url, owner, account);
  const balance = BigInt((await rpcResult(url, 'eth_getBalance', [account.address, 'latest'])) as string).toString();
  return { ...common, deployed: false, deployable: common.bundler, balance };
}
