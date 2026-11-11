import { ed25519 } from '@noble/curves/ed25519.js';
import { smartAccountFor } from '../src/safe';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { b64urlEncode, hexEncode, randomBytes } from '../src/encoding';
import { buildKit, type EmergencyKit } from '../src/kit';
import { sealSeedBackup } from '../src/seed-backup';
import type { Argon2Params, Envelope } from '../src/types';

export const CODE = '0123456789ABCDEFGHJKMNPQRS';
export const OTHER_CODE = 'SRQPNMKJHGFEDCBA9876543210';
export const codeBytes = (code = CODE) => new TextEncoder().encode(code);

// Low parameters: the logic does not depend on the cost, and Argon2id at 64 MiB would make the suite very slow.
export const FAST: Argon2Params = { memorySize: 256, iterations: 1, parallelism: 1, hashLength: 32 };

const envelope = (share: 'B' | 'C', kdf: Envelope['kdf'], userId: string, setId: string): Envelope => ({
  v: 1,
  share,
  userId,
  setId,
  kdf,
  kdfParams: {},
  salt: b64urlEncode(randomBytes(16)),
  iv: b64urlEncode(randomBytes(12)),
  ct: b64urlEncode(randomBytes(40)),
});

export async function makeKit(options: { mnemonic?: string; code?: string; backupOf?: string } = {}): Promise<{ kit: EmergencyKit; mnemonic: string; owner: `0x${string}` }> {
  const mnemonic = options.mnemonic ?? generateMnemonic(english);
  const owner = mnemonicToAccount(mnemonic).address;
  const userId = 'alice';
  const setId = crypto.randomUUID();
  const kit = buildKit({
    rpId: 'vault.localhost',
    credentialId: 'Y3JlZA',
    encB: envelope('B', 'prf-hkdf-sha256', userId, setId),
    encC: envelope('C', 'argon2id', userId, setId),
    signed: {
      signature: 'AAAA',
      manifest: {
        v: 1,
        userId,
        setId,
        n: 3,
        k: 2,
        format: 'bip39-en/wdk-utils-hex',
        wdkUtilsVersion: 'x',
        shareDigests: { A: 'a', B: 'b', C: 'c' },
        expectedAddress: owner,
        derivationPath: "m/44'/60'/0'/0/0",
        smartAccount: smartAccountFor(owner),
        createdAt: new Date(0).toISOString(),
      },
    },
    seedBackup: await sealSeedBackup(options.backupOf ?? mnemonic, codeBytes(options.code), owner, FAST),
  });
  return { kit, mnemonic, owner };
}

export function flipBit(b64url: string): string {
  const bytes = Buffer.from(b64url, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

export const USER = 'alice';
export const SET_ID = '11111111-1111-4111-8111-111111111111';

export function makeKeys() {
  const { secretKey, publicKey } = ed25519.keygen();
  return { signingKey: hexEncode(secretKey), manifestPubKey: hexEncode(publicKey) };
}
