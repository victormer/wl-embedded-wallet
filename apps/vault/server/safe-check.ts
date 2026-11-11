import { DEFAULT_SAFE_PARAMS, smartAccountFor, type SmartAccountInfo } from '@wl-embedded-wallet/core/safe';
import { WalletAccountReadOnlyEvmErc4337 } from '@tetherto/wdk-wallet-evm-erc-4337';
import { canonicalize } from '@wl-embedded-wallet/core/manifest';
import { isRecord } from '@wl-embedded-wallet/core/schema';

/** The Safe of a new wallet: current parameters, and the same address WDK computes. */
export function isNewSmartAccount(value: unknown, owner: string): value is SmartAccountInfo {
  if (!isRecord(value)) return false;
  const expected = smartAccountFor(owner);
  const wdk = WalletAccountReadOnlyEvmErc4337.predictSafeAddress(owner, { safeModulesVersion: DEFAULT_SAFE_PARAMS.safeModulesVersion });
  return canonicalize(value) === canonicalize(expected) && wdk === expected.address;
}
