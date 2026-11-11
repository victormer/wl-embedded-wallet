import { describe, expect, it } from 'vitest';
import { randomBytes, utf8 } from '@wl-embedded-wallet/core/encoding';
import { buildAad, hkdfAesKey, openShareB, sealShareB } from '@wl-embedded-wallet/core/envelope';
import { generateRecoveryCode, openShareC, recoveryCodeToBytes, sealShareC } from '@wl-embedded-wallet/core/recovery-code';
import type { Envelope } from '@wl-embedded-wallet/core/types';
import { openShareA, sealShareA } from '../../server/kms';
import { flipBit, SET_ID, USER } from './helpers';

const IDS = { userId: USER, setId: SET_ID };
const OTHER_SET = '22222222-2222-4222-8222-222222222222';
const PLAIN = '0102030405060708090a0b0c0d0e0f101112131415';
const plainBytes = () => Uint8Array.from(Buffer.from(PLAIN, 'hex'));
const prf = randomBytes(32);
const code = recoveryCodeToBytes(generateRecoveryCode());

type Ids = { userId: string; setId: string };
type Kind = {
  name: string;
  seal: (ids: Ids) => Promise<Envelope>;
  open: (envelope: Envelope, ids: Ids) => Promise<unknown>;
};

const kinds: Kind[] = [
  { name: 'A (kms)', seal: (ids) => sealShareA(PLAIN, ids), open: (e, ids) => openShareA(e, ids) },
  { name: 'B (prf)', seal: (ids) => sealShareB(plainBytes(), prf, ids), open: (e, ids) => openShareB(e, prf, ids) },
  { name: 'C (argon2id)', seal: (ids) => sealShareC(plainBytes(), code, ids), open: (e, ids) => openShareC(e, code, ids) },
];

describe.each(kinds)('share $name envelope', ({ seal, open }) => {
  it('decrypts with the expected values', async () => {
    const opened = await open(await seal(IDS), IDS);
    const hex = typeof opened === 'string' ? opened : Buffer.from(opened as Uint8Array).toString('hex');
    expect(hex).toBe(PLAIN);
  });

  it.each(['ct', 'iv', 'salt'] as const)('a flipped bit in %s makes decryption fail', async (field) => {
    const envelope = await seal(IDS);
    await expect(open({ ...envelope, [field]: flipBit(envelope[field]) }, IDS)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects an envelope for another userId, even if its fields are rewritten', async () => {
    const foreign = await seal({ userId: 'mallory', setId: SET_ID });
    await expect(open({ ...foreign, userId: USER }, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects an envelope for another setId, even if its fields are rewritten', async () => {
    const foreign = await seal({ userId: USER, setId: OTHER_SET });
    await expect(open({ ...foreign, setId: SET_ID }, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects an unmodified envelope that does not match the expected slot', async () => {
    const foreign = await seal({ userId: USER, setId: OTHER_SET });
    await expect(open(foreign, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('uses a different IV for each encryption', async () => {
    const [first, second] = await Promise.all([seal(IDS), seal(IDS)]);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });
});

describe('AAD and positions', () => {
  it('has the format from the specification', () => {
    expect(new TextDecoder().decode(buildAad({ userId: 'u', setId: 's', share: 'B' }))).toBe('wl-embedded-wallet/envelope/v1|u|s|B');
  });

  it('rejects a share in another position, even if the share field is rewritten and the key is the same', async () => {
    const ikm = randomBytes(32);
    const { sealEnvelope, openEnvelope } = await import('@wl-embedded-wallet/core/envelope');
    const deriveKey = (salt: Uint8Array) => hkdfAesKey(ikm, salt, 'same-info');
    const envelope = await sealEnvelope({
      slot: { ...IDS, share: 'B' },
      kdf: 'prf-hkdf-sha256',
      kdfParams: {},
      plaintext: utf8('x'),
      deriveKey,
    });
    await expect(
      openEnvelope({
        envelope: { ...envelope, share: 'C' },
        slot: { ...IDS, share: 'C' },
        kdf: 'prf-hkdf-sha256',
        deriveKey,
      }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects an envelope with another kdf or a salt/iv of the wrong length', async () => {
    const envelope = await sealShareB(plainBytes(), prf, IDS);
    await expect(openShareB({ ...envelope, kdf: 'argon2id' }, prf, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    await expect(openShareB({ ...envelope, iv: 'AAAA' }, prf, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    await expect(openShareB({ ...envelope, salt: '!!!' }, prf, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('a different PRF output does not decrypt B', async () => {
    const envelope = await sealShareB(plainBytes(), prf, IDS);
    await expect(openShareB(envelope, randomBytes(32), IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('the derived key is not extractable', async () => {
    const key = await hkdfAesKey(randomBytes(32), randomBytes(16), 'info');
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});
