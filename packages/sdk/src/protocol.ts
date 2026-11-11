// postMessage protocol between the app (SDK) and the vault popup. It carries no secrets
// except the handoff token, which is single-use and is always posted to an exact origin.
import type { TypedDataRequest, UserOperationJson, UserOperationRequest, VaultCall, VaultSignRequest } from '@wl-embedded-wallet/core/operations';

export type { TypedDataRequest, UserOperationJson, UserOperationRequest, VaultCall, VaultSignRequest };

export const VAULT_PROTOCOL = 'wl-embedded-wallet/protocol/v1';

// Fixed name: the same window is reused across operations.
export const VAULT_WINDOW_NAME = 'wl-embedded-wallet-vault';

// `rpcUrl` never reaches the popup: only `getToken` receives it, and the integrator's backend decides
// whether to sign it into the token. The popup only gets `chainId`, which must match the token's.
export type VaultChain = { chainId: number; rpcUrl?: string };

// `kind` is also the popup route: /activate, /deploy, /sign, /unlock, /recover, /export or /relink.
export type VaultAction =
  | { kind: 'activate' }
  | { kind: 'deploy'; chain: { chainId: number } }
  | { kind: 'sign'; chain: { chainId: number }; request: VaultSignRequest }
  | { kind: 'unlock' }
  | { kind: 'recover' }
  // The seed never leaves the vault: the result only carries the addresses.
  | { kind: 'export' }
  // Links to this account, which has no wallet, a wallet the user proves they control by signing with its owner.
  | { kind: 'relink' };

export type VaultReady = { protocol: typeof VAULT_PROTOCOL; type: 'ready' };

export type VaultRequest = {
  protocol: typeof VAULT_PROTOCOL;
  type: 'request';
  id: string;
  token: string;
  action: VaultAction;
};

export type VaultResult = {
  protocol: typeof VAULT_PROTOCOL;
  type: 'result';
  id: string;
} & (
  | {
      ok: true;
      // The Safe, which is the user's account. `owner` is the Shamir-split key that controls it.
      address: `0x${string}`;
      owner: `0x${string}`;
      signature?: `0x${string}`;
      // For `userOperation`, the complete operation with its signature. It is not submitted on-chain.
      userOperation?: UserOperationJson;
      // `deploy` only. When absent, the Safe was already deployed and nothing was signed.
      userOpHash?: `0x${string}`;
      transactionHash?: `0x${string}`;
    }
  | { ok: false; code: string }
);
