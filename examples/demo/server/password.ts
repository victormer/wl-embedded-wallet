import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptParams } from './db';

const PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
// Only used to spend the same time when the user does not exist.
const DUMMY_SALT = Buffer.alloc(SALT_BYTES).toString('base64url');

function derive(password: string, salt: string, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'base64url'), KEY_BYTES, { ...params, maxmem: MAX_MEMORY_BYTES }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<{ passwordHash: string; passwordSalt: string; params: ScryptParams }> {
  const passwordSalt = randomBytes(SALT_BYTES).toString('base64url');
  const key = await derive(password, passwordSalt, PARAMS);
  return { passwordHash: key.toString('base64url'), passwordSalt, params: PARAMS };
}

export async function verifyPassword(password: string, user: { passwordHash: string; passwordSalt: string; params: ScryptParams }): Promise<boolean> {
  const key = await derive(password, user.passwordSalt, user.params);
  return timingSafeEqual(key, Buffer.from(user.passwordHash, 'base64url'));
}

/** So that a login with an unknown email takes as long as one with a wrong password. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, PARAMS);
}
