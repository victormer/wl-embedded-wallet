import { createVaultServiceClient, VaultUnavailableError, type VaultServiceAccount } from '@wl-embedded-wallet/sdk/server';
import type { DemoChain } from './chains';

export { VaultUnavailableError };
export type VaultAccount = VaultServiceAccount;

/** The vault is the only source of the wallet address and of its state on each chain. */
export function fetchVaultAccount(sub: string, chain?: DemoChain): Promise<VaultAccount> {
  const client = createVaultServiceClient({ vaultOrigin: process.env.VAULT_ORIGIN ?? '', serviceToken: process.env.VAULT_SERVICE_TOKEN ?? '' });
  return client.getAccount(sub, chain ? { chainId: chain.chainId, rpcUrl: chain.rpcUrl } : undefined);
}
