import { getPrfOutput } from './prf';
import type { Envelope, OfflineSource, SeedBackup, SignedManifest } from '@wl-embedded-wallet/core/types';

/** What allows operating without share A. It holds encrypted data, never the PRF output or the code. */
export type RecoveredWallet =
  | { combo: 'B+C'; signed: SignedManifest; encB: Envelope; encC: Envelope; credentialId: string; hasBackup: boolean }
  | { combo: 'kit+code'; signed: SignedManifest; seedBackup: SeedBackup; encB: Envelope; encC: Envelope; credentialId: string; hasBackup: true };

/** Each operation reconstructs and discards the seed. With B+C it asks for the passkey again, and `code` is copied because it is transferred to the worker. */
export async function sourceFor(wallet: RecoveredWallet, code: Uint8Array): Promise<OfflineSource> {
  if (wallet.combo === 'kit+code') return { op: 'recover', combo: 'kit+code', signed: wallet.signed, seedBackup: wallet.seedBackup, code: code.slice() };
  const prf = await getPrfOutput(wallet.credentialId);
  return { op: 'recover', combo: 'B+C', signed: wallet.signed, encB: wallet.encB, encC: wallet.encC, prf, code: code.slice() };
}
