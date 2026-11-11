import { describe, expect, it } from 'vitest';
import { b64urlDecode, hexEncode } from '../src/encoding';
import { WalletError } from '../src/errors';
import { DEFAULT_ARGON2_PARAMS } from '../src/recovery-code';
import { isSeedBackup, openSeedBackup, sealSeedBackup, seedBackupAad } from '../src/seed-backup';
import { codeBytes, FAST, flipBit, OTHER_CODE } from './fixtures';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const failure = (run: () => Promise<unknown>) => run().then(() => 'no error', (error: WalletError) => error.code);

describe('seed backup', () => {
  it('decrypts with the same code and owner, and the seed is not in plaintext', async () => {
    const backup = await sealSeedBackup(MNEMONIC, codeBytes(), OWNER, FAST);
    expect(await openSeedBackup(backup, codeBytes(), OWNER)).toBe(MNEMONIC);
    expect(JSON.stringify(backup)).not.toContain('legal');
    expect(hexEncode(b64urlDecode(backup.ct))).not.toContain(hexEncode(new TextEncoder().encode('legal')));
    // Address letter case does not change the AAD.
    expect(await openSeedBackup(backup, codeBytes(), OWNER.toLowerCase())).toBe(MNEMONIC);
  });

  it('uses C\'s default parameters, with a fresh salt and nonce each time', async () => {
    const [a, b] = await Promise.all([sealSeedBackup(MNEMONIC, codeBytes(), OWNER), sealSeedBackup(MNEMONIC, codeBytes(), OWNER)]);
    expect(a.kdfParams).toEqual(DEFAULT_ARGON2_PARAMS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(b64urlDecode(a.salt)).toHaveLength(16);
    expect(b64urlDecode(a.iv)).toHaveLength(12);
  });

  it('the AAD has its own label and the owner: it cannot be confused with the C envelope', () => {
    const aad = new TextDecoder().decode(seedBackupAad(OWNER));
    expect(aad).toBe(`wl-embedded-wallet/seed-backup/v1|${OWNER.toLowerCase()}`);
    expect(aad.startsWith('wl-embedded-wallet/envelope/v1')).toBe(false);
  });

  it('rejects a wrong code, another owner and any tampered field', async () => {
    const backup = await sealSeedBackup(MNEMONIC, codeBytes(), OWNER, FAST);
    expect(await failure(() => openSeedBackup(backup, codeBytes(OTHER_CODE), OWNER))).toBe('DECRYPT_FAILED');
    expect(await failure(() => openSeedBackup(backup, codeBytes(), OTHER_OWNER))).toBe('DECRYPT_FAILED');
    for (const field of ['ct', 'iv', 'salt'] as const) {
      expect(await failure(() => openSeedBackup({ ...backup, [field]: flipBit(backup[field]) }, codeBytes(), OWNER))).toBe('DECRYPT_FAILED');
    }
    expect(await failure(() => openSeedBackup({ ...backup, salt: 'AAAA' }, codeBytes(), OWNER))).toBe('DECRYPT_FAILED');
    expect(await failure(() => openSeedBackup({ ...backup, kdfParams: { ...FAST, iterations: 2 } }, codeBytes(), OWNER))).toBe('DECRYPT_FAILED');
  });

  it('bounds Argon2id: abusive parameters never run', async () => {
    const backup = await sealSeedBackup(MNEMONIC, codeBytes(), OWNER, FAST);
    expect(await failure(() => openSeedBackup({ ...backup, kdfParams: { ...FAST, memorySize: 4_000_000 } }, codeBytes(), OWNER))).toBe('KDF_PARAMS_INVALID');
  });

  it('requires a well-formed code before deriving anything', async () => {
    expect(await failure(() => sealSeedBackup(MNEMONIC, new TextEncoder().encode('short'), OWNER, FAST))).toBe('BAD_RECOVERY_CODE');
    const backup = await sealSeedBackup(MNEMONIC, codeBytes(), OWNER, FAST);
    expect(await failure(() => openSeedBackup(backup, new TextEncoder().encode('short'), OWNER))).toBe('BAD_RECOVERY_CODE');
  });

  it('validates the shape strictly', async () => {
    const backup = await sealSeedBackup(MNEMONIC, codeBytes(), OWNER, FAST);
    expect(isSeedBackup(backup)).toBe(true);
    expect(isSeedBackup({ ...backup, extra: 1 })).toBe(false);
    expect(isSeedBackup({ ...backup, v: 2 })).toBe(false);
    expect(isSeedBackup({ ...backup, kdf: 'pbkdf2' })).toBe(false);
    expect(isSeedBackup({ ...backup, ct: 'not b64url!' })).toBe(false);
    const { salt: _salt, ...withoutSalt } = backup;
    expect(isSeedBackup(withoutSalt)).toBe(false);
    expect(isSeedBackup(null)).toBe(false);
  });
});
