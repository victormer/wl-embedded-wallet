import { predictSafeAddress } from './safe';
import { mnemonicToAccount } from 'viem/accounts';
import { WalletError } from './errors';
import { parseKit, type EmergencyKit } from './kit';
import { recoveryCodeToBytes } from './recovery-code';
import { openSeedBackup } from './seed-backup';
import { zero } from './encoding';

export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface OfflineCheck {
  ownerMatches: boolean;
  safeMatches: boolean;
  derivedOwner: `0x${string}`;
  derivedSafe: `0x${string}` | null;
  expectedOwner: string;
  expectedSafe: string;
}

export type OfflineRecovery = OfflineCheck & (
  | { ok: true; mnemonic: string }
  // Without the seed: what is inside is not the wallet the kit claims.
  | { ok: false }
);

export function deriveOwner(mnemonic: string): `0x${string}` {
  return mnemonicToAccount(mnemonic, { path: DERIVATION_PATH }).address;
}

function sameAddress(a: string, b: string | null): boolean {
  return b !== null && a.toLowerCase() === b.toLowerCase();
}

/** The Safe is recomputed from the owner and the manifest parameters: the kit alone never decides which address to show. */
export function checkWallet(mnemonic: string, kit: EmergencyKit): OfflineCheck {
  const { manifest } = kit;
  const derivedOwner = deriveOwner(mnemonic);
  let derivedSafe: `0x${string}` | null = null;
  try {
    derivedSafe = predictSafeAddress(derivedOwner, manifest.smartAccount);
  } catch {
    // Invalid Safe parameters: reported as a mismatch.
  }
  return {
    ownerMatches: sameAddress(manifest.expectedAddress, derivedOwner),
    safeMatches: sameAddress(manifest.smartAccount.address, derivedSafe),
    derivedOwner,
    derivedSafe,
    expectedOwner: manifest.expectedAddress,
    expectedSafe: manifest.smartAccount.address,
  };
}

/**
 * The core of the offline tool: kit + code, without a passkey or the server. Throws `WalletError`.
 * If the owner or the Safe does not match, the seed is not returned.
 */
export async function recoverFromKit(kitText: string, codeText: string): Promise<OfflineRecovery> {
  const kit = parseKit(kitText);
  if (!kit) throw new WalletError('INVALID_KIT');
  if (!kit.seedBackup) throw new WalletError('NO_SEED_BACKUP');
  if (kit.manifest.derivationPath !== DERIVATION_PATH) throw new WalletError('FORMAT_UNSUPPORTED');
  const code = recoveryCodeToBytes(codeText);
  try {
    const mnemonic = await openSeedBackup(kit.seedBackup, code, kit.manifest.expectedAddress);
    const check = checkWallet(mnemonic, kit);
    return check.ownerMatches && check.safeMatches ? { ...check, ok: true, mnemonic } : { ...check, ok: false };
  } finally {
    zero(code);
  }
}
