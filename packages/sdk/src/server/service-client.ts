// Server-to-server client for `GET /api/s2s/accounts/{sub}`. Only for the integrator backend: it holds the
// vault service token. The vault is the only source of truth for a user's wallet address and its state per chain.

const TIMEOUT_MS = 15_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class VaultUnavailableError extends Error {
  constructor() {
    super('VAULT_UNAVAILABLE');
    this.name = 'VaultUnavailableError';
  }
}

export type VaultServiceAccount =
  | { exists: false; address: null; owner: null }
  | {
      exists: true;
      /** The Safe: the user's account. */
      address: `0x${string}`;
      /** The Shamir-protected owner key that controls the Safe. */
      owner: `0x${string}`;
      chainId?: number;
      /** `null` when it could not be checked on that chain; `chainError` says why. */
      deployed?: boolean | null;
      deployable?: boolean;
      sponsored?: boolean;
      chainError?: string;
    };

export interface VaultServiceClientOptions {
  /** The vault origin, for example `https://vault.example.com`. Trailing slashes are removed. */
  vaultOrigin: string;
  /** The vault's `VAULT_SERVICE_TOKEN`. Never send it to a browser. */
  serviceToken: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface VaultServiceClient {
  /**
   * Public data of the user's wallet. With `chain`, also its deployment state on that chain; the RPC URL
   * comes from your server configuration, never from the browser. Throws `VaultUnavailableError`.
   */
  getAccount(sub: string, chain?: { chainId: number; rpcUrl?: string }): Promise<VaultServiceAccount>;
}

export function createVaultServiceClient(options: VaultServiceClientOptions): VaultServiceClient {
  const fetcher = options.fetch ?? fetch;
  // `https://vault.example.com/` would otherwise produce `//api/...`. Nothing else is rewritten.
  const vaultOrigin = options.vaultOrigin.replace(/\/+$/, '');
  return {
    async getAccount(sub, chain) {
      const params = chain ? new URLSearchParams({ chainId: String(chain.chainId), ...(chain.rpcUrl ? { rpcUrl: chain.rpcUrl } : {}) }) : null;
      let response: Response;
      try {
        response = await fetcher(`${vaultOrigin}/api/s2s/accounts/${encodeURIComponent(sub)}${params ? `?${params}` : ''}`, {
          headers: { Authorization: `Bearer ${options.serviceToken}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
      } catch {
        throw new VaultUnavailableError();
      }
      if (!response.ok) throw new VaultUnavailableError();

      const body = (await response.json().catch(() => null)) as (Record<string, unknown> & { exists?: unknown; address?: unknown; owner?: unknown }) | null;
      if (body?.exists === false) return { exists: false, address: null, owner: null };
      if (body?.exists === true && typeof body.address === 'string' && ADDRESS.test(body.address) && typeof body.owner === 'string' && ADDRESS.test(body.owner)) {
        return body as unknown as VaultServiceAccount;
      }
      throw new VaultUnavailableError();
    },
  };
}
