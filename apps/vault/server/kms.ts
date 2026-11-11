import { hexDecode, hexEncode, zero } from '@wl-embedded-wallet/core/encoding';
import { hkdfAesKey, openEnvelope, sealEnvelope, type EnvelopeSlot } from '@wl-embedded-wallet/core/envelope';
import type { Envelope } from '@wl-embedded-wallet/core/types';

const MASTER_KEY_BYTES = 32;

function masterKey(): Uint8Array<ArrayBuffer> {
  const key = hexDecode(process.env.MASTER_KEY ?? '');
  if (key.length !== MASTER_KEY_BYTES) throw new Error('MASTER_KEY must be 32 bytes in hex');
  return key;
}

function deriveKey(slot: EnvelopeSlot) {
  return async (salt: Uint8Array) => {
    const master = masterKey();
    try {
      return await hkdfAesKey(master, salt, `wl-embedded-wallet/share-a/kms/v1|${slot.userId}|${slot.setId}`);
    } finally {
      zero(master);
    }
  };
}

/** Simulates KMS/HSM encryption. `shareA` is the share in hex. */
export async function sealShareA(shareA: string, ids: { userId: string; setId: string }): Promise<Envelope> {
  const slot: EnvelopeSlot = { ...ids, share: 'A' };
  const plaintext = hexDecode(shareA);
  try {
    return await sealEnvelope({ slot, kdf: 'kms', kdfParams: {}, plaintext, deriveKey: deriveKey(slot) });
  } finally {
    zero(plaintext);
  }
}

export async function openShareA(envelope: Envelope, ids: { userId: string; setId: string }): Promise<string> {
  const slot: EnvelopeSlot = { ...ids, share: 'A' };
  const plaintext = await openEnvelope({ envelope, slot, kdf: 'kms', deriveKey: deriveKey(slot) });
  try {
    return hexEncode(plaintext);
  } finally {
    zero(plaintext);
  }
}
