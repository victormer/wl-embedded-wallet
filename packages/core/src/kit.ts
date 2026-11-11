import { isB64url, isEnvelope, isRecord, isSignedManifest } from './schema';
import { isSeedBackup } from './seed-backup';
import type { Envelope, SeedBackup, SignedManifest } from './types';

export const KIT_VERSION = 2;

/**
 * Never contains share A. Since `v: 2` it contains `seedBackup`: **kit + code are enough to obtain the seed**,
 * without a passkey or the server. That is why they must be stored separately. A `v: 1` kit remains readable.
 */
export interface EmergencyKit {
  v: 1 | 2;
  rpId: string;
  credentialId: string;
  encB: Envelope;
  encC: Envelope;
  manifest: SignedManifest['manifest'];
  signature: string;
  seedBackup?: SeedBackup;
}

export function buildKit(input: {
  rpId: string;
  credentialId: string;
  encB: Envelope;
  encC: Envelope;
  signed: SignedManifest;
  seedBackup?: SeedBackup;
}): EmergencyKit {
  return {
    v: input.seedBackup ? KIT_VERSION : 1,
    rpId: input.rpId,
    credentialId: input.credentialId,
    encB: input.encB,
    encC: input.encC,
    manifest: input.signed.manifest,
    signature: input.signed.signature,
    ...(input.seedBackup ? { seedBackup: input.seedBackup } : {}),
  };
}

/** Checks the shape: `v: 1` without a backup, `v: 2` always with one. Authenticity is decided by decryption or by the manifest signature. */
export function parseKit(text: string): EmergencyKit | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.rpId !== 'string' || !isB64url(value.credentialId)) return null;
  if (value.v === 1 ? 'seedBackup' in value : value.v !== KIT_VERSION || !isSeedBackup(value.seedBackup)) return null;
  if (!isEnvelope(value.encB, 'B', 'prf-hkdf-sha256') || !isEnvelope(value.encC, 'C', 'argon2id')) return null;
  if (!isSignedManifest({ manifest: value.manifest, signature: value.signature })) return null;
  return value as unknown as EmergencyKit;
}

export function kitFileName(setId: string): string {
  return `wl-embedded-wallet-kit-${setId.slice(0, 8)}.json`;
}
