import type { Envelope, Kdf, ShareName, SignedManifest } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isText = (value: unknown, pattern: RegExp, maxLength: number): value is string =>
  typeof value === 'string' && value.length <= maxLength && pattern.test(value);

export const isUuid = (value: unknown): value is string => isText(value, UUID, 36);
export const isB64url = (value: unknown, maxLength = 4096): value is string => isText(value, B64URL, maxLength);
export const isShareHex = (value: unknown): value is string => isText(value, HEX, 256);
export const isDigest = (value: unknown): value is string => isText(value, SHA256_HEX, 64);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape only: decryption and the manifest authenticate the content. */
export function isEnvelope(value: unknown, share: ShareName, kdf: Kdf): value is Envelope {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.share === share &&
    value.kdf === kdf &&
    typeof value.userId === 'string' &&
    isUuidLike(value.setId) &&
    isRecord(value.kdfParams) &&
    isB64url(value.salt) &&
    isB64url(value.iv) &&
    isB64url(value.ct)
  );
}

const isUuidLike = (value: unknown) => typeof value === 'string' && value.length <= 64;

export function isSignedManifest(value: unknown): value is SignedManifest {
  if (!isRecord(value) || !isB64url(value.signature) || !isRecord(value.manifest)) return false;
  const { manifest } = value;
  return (
    typeof manifest.userId === 'string' &&
    typeof manifest.setId === 'string' &&
    isRecord(manifest.shareDigests) &&
    typeof manifest.expectedAddress === 'string' &&
    isRecord(manifest.smartAccount) &&
    typeof manifest.smartAccount.address === 'string'
  );
}
