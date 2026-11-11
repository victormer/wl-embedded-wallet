import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHandoffToken } from '@wl-embedded-wallet/sdk/server';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexEncode } from '@wl-embedded-wallet/core/encoding';
import { consumeHandoffToken, HandoffError } from '../../server/handoff';
import { openShareA, sealShareA } from '../../server/kms';
import { closeDb } from '../../server/store';
import { flipBit, SET_ID, USER } from './helpers';

const IDS = { userId: USER, setId: SET_ID };
const APP_ORIGIN = 'https://app.test';
const CLAIMS = { iss: 'https://login.test', aud: 'https://vault.test', origin: APP_ORIGIN };
const CONSUME = { origin: APP_ORIGIN };
const SHARE = '0102030405060708090a0b0c0d0e0f101112131415';

describe('kms', () => {
  it('seals and opens A', async () => {
    const envelope = await sealShareA(SHARE, IDS);
    expect(envelope.kdf).toBe('kms');
    expect(JSON.stringify(envelope)).not.toContain(SHARE);
    await expect(openShareA(envelope, IDS)).resolves.toBe(SHARE);
  });

  it('the salt is authenticated too', async () => {
    const envelope = await sealShareA(SHARE, IDS);
    await expect(openShareA({ ...envelope, salt: flipBit(envelope.salt) }, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('another MASTER_KEY does not open the envelope, and an invalid one fails', async () => {
    const envelope = await sealShareA(SHARE, IDS);
    const original = process.env.MASTER_KEY;
    try {
      process.env.MASTER_KEY = 'ab'.repeat(32);
      await expect(openShareA(envelope, IDS)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
      process.env.MASTER_KEY = 'abcd';
      await expect(sealShareA(SHARE, IDS)).rejects.toThrow('MASTER_KEY');
    } finally {
      process.env.MASTER_KEY = original;
    }
  });
});

describe('handoff token in the vault', () => {
  const { secretKey, publicKey } = ed25519.keygen();
  const PRIVATE = hexEncode(secretKey);
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wl-embedded-wallet-'));
    process.env.DATABASE_URL = `sqlite:${join(dir, 'vault.db')}`;
    process.env.HANDOFF_PUBLIC_KEY = hexEncode(publicKey);
    process.env.HANDOFF_ISSUER = CLAIMS.iss;
    process.env.HANDOFF_AUDIENCE = CLAIMS.aud;
  });

  afterEach(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.HANDOFF_PUBLIC_KEY;
    delete process.env.HANDOFF_ISSUER;
    delete process.env.HANDOFF_AUDIENCE;
  });

  it('returns the claims and rejects reuse', async () => {
    const token = createHandoffToken({ sub: USER, label: 'a@b.c', ...CLAIMS }, PRIVATE);
    await expect(consumeHandoffToken(token, CONSUME)).resolves.toMatchObject({ sub: USER, label: 'a@b.c' });
    await expect(consumeHandoffToken(token, CONSUME)).rejects.toThrowError('REPLAYED');
  });

  it('an invalid token does not consume its jti', async () => {
    const jti = 'jti-fixed';
    const expired = createHandoffToken({ sub: USER, label: 'l', jti, nowSeconds: Math.floor(Date.now() / 1000) - 120, ...CLAIMS }, PRIVATE);
    await expect(consumeHandoffToken(expired, CONSUME)).rejects.toThrowError('EXPIRED');
    const valid = createHandoffToken({ sub: USER, label: 'l', jti, ...CLAIMS }, PRIVATE);
    expect((await consumeHandoffToken(valid, CONSUME)).jti).toBe(jti);
  });

  it('rejects without a configured public key', async () => {
    delete process.env.HANDOFF_PUBLIC_KEY;
    const token = createHandoffToken({ sub: USER, label: 'l', ...CLAIMS }, PRIVATE);
    await expect(consumeHandoffToken(token, CONSUME)).rejects.toThrow(HandoffError);
  });
});
