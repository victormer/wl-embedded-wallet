import { b64urlDecode, b64urlEncode, randomBytes, utf8, zero } from './encoding';
import { WalletError } from './errors';
import { assertRecoveryCodeBytes, DEFAULT_ARGON2_PARAMS, deriveRecoveryKey, parseArgon2Params } from './recovery-code';
import { isB64url, isRecord } from './schema';
import type { Argon2Params, SeedBackup } from './types';

export const SEED_BACKUP_LABEL = 'wl-embedded-wallet/seed-backup/v1';

const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEYS = new Set(['v', 'kdf', 'kdfParams', 'salt', 'iv', 'ct']);

/**
 * Its own label plus the owner. It cannot be confused with the C envelope, whose AAD starts with `wl-embedded-wallet/envelope/v1`,
 * and a backup moved into another kit does not decrypt. The owner always comes from the manifest, never from the backup.
 */
export function seedBackupAad(owner: string): Uint8Array<ArrayBuffer> {
  return utf8(`${SEED_BACKUP_LABEL}|${owner.toLowerCase()}`);
}

/** Shape only, and strict: an extra field also invalidates the kit. Decryption authenticates the content. */
export function isSeedBackup(value: unknown): value is SeedBackup {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => KEYS.has(key)) &&
    value.v === 1 &&
    value.kdf === 'argon2id' &&
    isRecord(value.kdfParams) &&
    isB64url(value.salt) &&
    isB64url(value.iv) &&
    isB64url(value.ct)
  );
}

/** Its own salt and nonce, even when the Argon2id parameters are those of C: the key never equals C's key. */
export async function sealSeedBackup(mnemonic: string, code: Uint8Array, owner: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<SeedBackup> {
  assertRecoveryCodeBytes(code);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const plaintext = utf8(mnemonic);
  try {
    const key = await deriveRecoveryKey(code, salt, params);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: seedBackupAad(owner) }, key, plaintext);
    return { v: 1, kdf: 'argon2id', kdfParams: { ...params }, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct: b64urlEncode(new Uint8Array(ct)) };
  } finally {
    zero(plaintext);
  }
}

/** `owner` is the expected value. `DECRYPT_FAILED` does not distinguish a wrong code from a tampered backup. */
export async function openSeedBackup(backup: SeedBackup, code: Uint8Array, owner: string): Promise<string> {
  assertRecoveryCodeBytes(code);
  if (!isSeedBackup(backup)) throw new WalletError('DECRYPT_FAILED');
  const params = parseArgon2Params(backup.kdfParams as unknown as Record<string, unknown>);
  try {
    const salt = b64urlDecode(backup.salt);
    const iv = b64urlDecode(backup.iv);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) throw new WalletError('DECRYPT_FAILED');
    const key = await deriveRecoveryKey(code, salt, params);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: seedBackupAad(owner) }, key, b64urlDecode(backup.ct)));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } finally {
      zero(plaintext);
    }
  } catch {
    throw new WalletError('DECRYPT_FAILED');
  }
}
