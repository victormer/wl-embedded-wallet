import { asBuffer, b64urlDecode, b64urlEncode, randomBytes, utf8 } from './encoding';
import { PRF_SALT_LABEL } from './prf';
import { WalletError, type Envelope, type Kdf, type ShareName } from './types';

export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export interface EnvelopeSlot {
  userId: string;
  setId: string;
  share: ShareName;
}

export function buildAad({ userId, setId, share }: EnvelopeSlot): Uint8Array<ArrayBuffer> {
  return utf8(`wl-embedded-wallet/envelope/v1|${userId}|${setId}|${share}`);
}

/** Derives a non-extractable AES-256-GCM key. */
export async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', asBuffer(ikm), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: utf8(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealEnvelope(params: {
  slot: EnvelopeSlot;
  kdf: Kdf;
  kdfParams: Record<string, unknown>;
  plaintext: Uint8Array;
  deriveKey: (salt: Uint8Array) => Promise<CryptoKey>;
}): Promise<Envelope> {
  const { slot, kdf, kdfParams, plaintext, deriveKey } = params;
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: buildAad(slot) },
    key,
    asBuffer(plaintext),
  );
  return {
    v: 1,
    share: slot.share,
    userId: slot.userId,
    setId: slot.setId,
    kdf,
    kdfParams,
    salt: b64urlEncode(salt),
    iv: b64urlEncode(iv),
    ct: b64urlEncode(new Uint8Array(ct)),
  };
}

/**
 * `slot` holds the expected values (from the signed manifest), never the envelope's
 * own fields: otherwise, replacing the whole envelope would pass the AAD check.
 */
export async function openEnvelope(params: {
  envelope: Envelope;
  slot: EnvelopeSlot;
  kdf: Kdf;
  deriveKey: (salt: Uint8Array) => Promise<CryptoKey>;
}): Promise<Uint8Array<ArrayBuffer>> {
  const { envelope, slot, kdf, deriveKey } = params;
  if (
    envelope?.v !== 1 ||
    envelope.share !== slot.share ||
    envelope.userId !== slot.userId ||
    envelope.setId !== slot.setId ||
    envelope.kdf !== kdf
  ) {
    throw new WalletError('DECRYPT_FAILED');
  }
  try {
    const salt = b64urlDecode(envelope.salt);
    const iv = b64urlDecode(envelope.iv);
    const ct = b64urlDecode(envelope.ct);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) throw new WalletError('DECRYPT_FAILED');
    const key = await deriveKey(salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(slot) },
      key,
      ct,
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof WalletError) throw error;
    throw new WalletError('DECRYPT_FAILED');
  }
}

function shareBInfo(slot: EnvelopeSlot): string {
  return `wl-embedded-wallet/share-b/aes/v1|${slot.userId}|${slot.setId}`;
}

export function sealShareB(plaintext: Uint8Array, prf: Uint8Array, ids: { userId: string; setId: string }): Promise<Envelope> {
  const slot: EnvelopeSlot = { ...ids, share: 'B' };
  return sealEnvelope({
    slot,
    kdf: 'prf-hkdf-sha256',
    kdfParams: { hash: 'SHA-256', prfSaltLabel: PRF_SALT_LABEL },
    plaintext,
    deriveKey: (salt) => hkdfAesKey(prf, salt, shareBInfo(slot)),
  });
}

export function openShareB(envelope: Envelope, prf: Uint8Array, ids: { userId: string; setId: string }): Promise<Uint8Array<ArrayBuffer>> {
  const slot: EnvelopeSlot = { ...ids, share: 'B' };
  return openEnvelope({
    envelope,
    slot,
    kdf: 'prf-hkdf-sha256',
    deriveKey: (salt) => hkdfAesKey(prf, salt, shareBInfo(slot)),
  });
}
