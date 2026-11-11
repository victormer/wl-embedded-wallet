export interface DemoChain {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** Block explorer base, without a trailing slash: links are `<explorerUrl>/address/<addr>` and `/tx/<hash>`. */
  explorerUrl?: string;
  /** Symbol of the native currency, e.g. `ETH` or `POL`. */
  nativeCurrency?: string;
}

/** What the browser may see of a chain: never `rpcUrl`, which can carry an API key. */
export type PublicDemoChain = Pick<DemoChain, 'chainId' | 'name' | 'explorerUrl' | 'nativeCurrency'>;

const MAX_NAME_LENGTH = 64;
const CURRENCY_SYMBOL = /^[A-Za-z0-9._-]{1,11}$/;

/** Invalid `DEMO_CHAINS`. The message never includes the value: RPC URLs often carry API keys. */
export class DemoChainsConfigError extends Error {
  constructor(detail: string) {
    super(`DEMO_CHAINS ${detail}`);
    this.name = 'DemoChainsConfigError';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** An http(s) URL without credentials, with no trailing slash. `null` otherwise. */
function explorerBase(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Paths are appended to it, so a query or fragment would end up in the middle of every link.
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function parseChain(value: unknown, index: number): DemoChain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DemoChainsConfigError(`[${index}] must be an object`);
  const { chainId, name, rpcUrl, explorerUrl, nativeCurrency } = value as Record<string, unknown>;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new DemoChainsConfigError(`[${index}].chainId must be a positive integer`);
  }
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME_LENGTH) {
    throw new DemoChainsConfigError(`[${index}].name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
  }
  if (typeof rpcUrl !== 'string' || !isHttpUrl(rpcUrl)) throw new DemoChainsConfigError(`[${index}].rpcUrl must be an http(s) URL`);
  const chain: DemoChain = { chainId, name, rpcUrl };
  if (explorerUrl !== undefined) {
    const base = typeof explorerUrl === 'string' ? explorerBase(explorerUrl) : null;
    if (!base) throw new DemoChainsConfigError(`[${index}].explorerUrl must be an http(s) URL without credentials, query or fragment`);
    chain.explorerUrl = base;
  }
  if (nativeCurrency !== undefined) {
    if (typeof nativeCurrency !== 'string' || !CURRENCY_SYMBOL.test(nativeCurrency)) {
      throw new DemoChainsConfigError(`[${index}].nativeCurrency must be 1 to 11 letters, digits, '.', '-' or '_'`);
    }
    chain.nativeCurrency = nativeCurrency;
  }
  return chain;
}

/**
 * Demo chains. The RPC is always resolved here: it is never accepted from the browser.
 * Read and validated on every use, like the rest of the demo's configuration, so it is not baked into the build:
 * an invalid value fails the page or request that needs it (`INTERNAL`), never silently offers no chains.
 */
export function demoChains(): DemoChain[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.DEMO_CHAINS || '[]');
  } catch {
    throw new DemoChainsConfigError('must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new DemoChainsConfigError('must be a JSON array');
  const chains = parsed.map(parseChain);
  if (new Set(chains.map(({ chainId }) => chainId)).size !== chains.length) throw new DemoChainsConfigError('has a repeated chainId');
  return chains;
}

/** Throws `DemoChainsConfigError` if `DEMO_CHAINS` is invalid. */
export function findDemoChain(chainId: unknown): DemoChain | null {
  return demoChains().find((chain) => chain.chainId === chainId) ?? null;
}

/** The chains as the browser gets them. Throws `DemoChainsConfigError` if `DEMO_CHAINS` is invalid. */
export function publicDemoChains(): PublicDemoChain[] {
  return demoChains().map(({ chainId, name, explorerUrl, nativeCurrency }) => ({
    chainId,
    name,
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...(nativeCurrency === undefined ? {} : { nativeCurrency }),
  }));
}
