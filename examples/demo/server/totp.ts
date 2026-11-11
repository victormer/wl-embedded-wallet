import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX = /^[0-9a-fA-F]{64}$/;

function key(): Buffer {
  const hex = process.env.DEMO_TOTP_KEY ?? '';
  if (!KEY_HEX.test(hex)) throw new Error('DEMO_TOTP_KEY must be 32 bytes in hex');
  return Buffer.from(hex, 'hex');
}

/** AES-256-GCM bound to the user: `iv.ct.tag` in b64url, for `users.totp_secret_enc`. */
export function sealTotpSecret(secret: string, userId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

export function openTotpSecret(sealed: string, userId: string): string {
  const [iv, ct, tag] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
