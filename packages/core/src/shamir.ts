import { combineMnemonic } from '@tetherto/wdk-utils';
import { WalletError } from './types';

// `recoverMnemonic` and `verifyRecovery` are examples from the WDK guide, not exports of the package.
// https://docs.wdk.tether.io/tools/wdk-utils/guides/shamir-secret-sharing/

const MAX_SHARES = 255;

type MaybePromise<T> = T | Promise<T>;

function assertShareSubset(shares: string[], threshold: number, verifyShare: unknown): void {
  if (!Array.isArray(shares) || shares.length > MAX_SHARES) throw new WalletError('COMBINE_FAILED');
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > MAX_SHARES) throw new WalletError('COMBINE_FAILED');
  if (typeof verifyShare !== 'function') throw new WalletError('COMBINE_FAILED');
  if (shares.length < threshold) throw new WalletError('COMBINE_FAILED');
}

async function assertAuthentic(shares: string[], verifyShare: (share: string) => MaybePromise<boolean>): Promise<void> {
  for (const share of shares) {
    let authentic: boolean;
    try {
      authentic = await verifyShare(share);
    } catch {
      throw new WalletError('SHARE_TAMPERED');
    }
    if (authentic !== true) throw new WalletError('SHARE_TAMPERED');
  }
}

async function combine(shares: string[]): Promise<string> {
  try {
    return await combineMnemonic(shares);
  } catch {
    throw new WalletError('COMBINE_FAILED');
  }
}

/** Checks that a threshold-sized subset reconstructs exactly `mnemonic`. */
export async function verifyRecovery(
  mnemonic: string,
  retrievedShares: string[],
  options: { threshold: number; verifyShare: (share: string) => MaybePromise<boolean> },
): Promise<void> {
  assertShareSubset(retrievedShares, options.threshold, options.verifyShare);
  await assertAuthentic(retrievedShares, options.verifyShare);
  if ((await combine(retrievedShares)) !== mnemonic) throw new WalletError('COMBINE_FAILED');
}

/** Authenticates every share, reconstructs, and checks the wallet identity before returning the seed. */
export async function recoverMnemonic(
  recoveryShares: string[],
  options: {
    threshold: number;
    verifyShare: (share: string) => MaybePromise<boolean>;
    matchesExpectedWallet: (mnemonic: string) => MaybePromise<boolean>;
  },
): Promise<string> {
  assertShareSubset(recoveryShares, options.threshold, options.verifyShare);
  if (typeof options.matchesExpectedWallet !== 'function') throw new WalletError('ADDRESS_MISMATCH');
  await assertAuthentic(recoveryShares, options.verifyShare);
  const mnemonic = await combine(recoveryShares);
  let matches: boolean;
  try {
    matches = await options.matchesExpectedWallet(mnemonic);
  } catch {
    throw new WalletError('ADDRESS_MISMATCH');
  }
  if (matches !== true) throw new WalletError('ADDRESS_MISMATCH');
  return mnemonic;
}
