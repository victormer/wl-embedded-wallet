import { describe, expect, it } from 'vitest';
import {
  confirmationMatches,
  DEFAULT_ARGON2_PARAMS,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openShareC,
  parseArgon2Params,
  pickConfirmationGroups,
  recoveryCodeToBytes,
  sealShareC,
} from '../src/recovery-code';
import { SET_ID, USER } from './fixtures';

const IDS = { userId: USER, setId: SET_ID };
const LIGHT = { memorySize: 1024, iterations: 1, parallelism: 1, hashLength: 32 };
const plain = () => new Uint8Array([1, 2, 3, 4]);

describe('recovery code', () => {
  it('is 26 grouped Crockford characters', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('normalizes lowercase, hyphens, spaces and I/L/O', () => {
    const code = generateRecoveryCode();
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(normalizeRecoveryCode('ILO'.padEnd(26, '0'))).toBe('110'.padEnd(26, '0'));
  });

  it.each(['', 'ABC', '0'.repeat(25), '0'.repeat(27), 'U'.repeat(26)])('rejects the format of %j', (input) => {
    expect(() => normalizeRecoveryCode(input)).toThrowError('BAD_RECOVERY_CODE');
  });

  it('confirms with two groups', () => {
    const code = generateRecoveryCode();
    const groups = code.split('-');
    const picked = pickConfirmationGroups();
    expect(new Set(picked).size).toBe(2);
    expect(confirmationMatches(code, { [picked[0]]: groups[picked[0]], [picked[1]]: groups[picked[1]].toLowerCase() })).toBe(true);
    expect(confirmationMatches(code, { [picked[0]]: groups[picked[0]], [picked[1]]: '????' })).toBe(false);
    expect(confirmationMatches(code, {})).toBe(false);
  });
});

describe('Share C with Argon2id', () => {
  it('stores the spec default parameters in the envelope', async () => {
    const envelope = await sealShareC(plain(), recoveryCodeToBytes(generateRecoveryCode()), IDS);
    expect(envelope.kdf).toBe('argon2id');
    expect(envelope.kdfParams).toEqual({ memorySize: 65536, iterations: 3, parallelism: 1, hashLength: 32 });
  });

  it('a wrong code does not decrypt', async () => {
    const envelope = await sealShareC(plain(), recoveryCodeToBytes(generateRecoveryCode()), IDS, LIGHT);
    await expect(openShareC(envelope, recoveryCodeToBytes(generateRecoveryCode()), IDS)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('reads the parameters from the envelope, not hardcoded ones', async () => {
    const code = recoveryCodeToBytes(generateRecoveryCode());
    const envelope = await sealShareC(plain(), code, IDS, LIGHT);
    expect(envelope.kdfParams).toEqual(LIGHT);
    expect(LIGHT).not.toEqual(DEFAULT_ARGON2_PARAMS);
    expect(await openShareC(envelope, code, IDS)).toEqual(plain());
    // With other parameters the key changes: proves the envelope's parameters are used.
    await expect(
      openShareC({ ...envelope, kdfParams: { ...LIGHT, iterations: 2 } }, code, IDS),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it.each([
    ['excessive memory', { ...LIGHT, memorySize: 1048577 }],
    ['too many iterations', { ...LIGHT, iterations: 11 }],
    ['excessive parallelism', { ...LIGHT, parallelism: 5 }],
    ['different hashLength', { ...LIGHT, hashLength: 64 }],
    ['non-integers', { ...LIGHT, iterations: 1.5 }],
    ['wrong types', { ...LIGHT, memorySize: '1024' }],
    ['missing', {}],
  ])('rejects kdfParams with %s before deriving', async (_label, kdfParams) => {
    expect(() => parseArgon2Params(kdfParams)).toThrowError('KDF_PARAMS_INVALID');
    const code = recoveryCodeToBytes(generateRecoveryCode());
    const envelope = await sealShareC(plain(), code, IDS, LIGHT);
    await expect(openShareC({ ...envelope, kdfParams }, code, IDS)).rejects.toMatchObject({ code: 'KDF_PARAMS_INVALID' });
  });
});
