import { DEFAULT_SAFE_PARAMS, predictSafeAddress, smartAccountFor } from '@wl-embedded-wallet/core/safe';
import { combineMnemonic, splitMnemonic } from '@tetherto/wdk-utils';
import { describe, expect, it, vi } from 'vitest';
import { hexDecode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import { openShareB, sealShareB } from '@wl-embedded-wallet/core/envelope';
import { buildManifest, deriveAddress, shareDigest, signManifest, WDK_UTILS_VERSION } from '@wl-embedded-wallet/core/manifest';
import { generateRecoveryCode, openShareC, recoveryCodeToBytes, sealShareC } from '@wl-embedded-wallet/core/recovery-code';
import { handleWorkerRequest, type SignerDeps } from '@wl-embedded-wallet/core/signer';
import type { Manifest, RecoverRequest, SignedManifest } from '@wl-embedded-wallet/core/types';
import { expectOk, flipBit, makeKeys, makeSecrets, makeServer, SET_ID, USER } from './helpers';

// Spy over the real implementation: does not change the cryptography, only counts calls.
vi.mock('@tetherto/wdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tetherto/wdk-utils')>();
  return { ...actual, combineMnemonic: vi.fn(actual.combineMnemonic) };
});

const SET_2 = '33333333-3333-4333-8333-333333333333';
const MNEMONIC = 'test test test test test test test test test test test junk';

async function enrolled(setId = SET_ID) {
  const server = makeServer();
  const secrets = makeSecrets();
  const response = expectOk(
    await handleWorkerRequest(
      { op: 'enroll', userId: USER, setId, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() },
      server.deps,
    ),
  );
  // Enrollment calls combineMnemonic in verifyRecovery: the spy should only count the recovery.
  vi.mocked(combineMnemonic).mockClear();
  return { server, secrets, address: response.address, owner: response.owner, wdkVersionMismatch: response.wdkVersionMismatch, ...response.enrolled! };
}

function requests(e: Awaited<ReturnType<typeof enrolled>>) {
  const { signed, encB, encC, secrets } = e;
  return {
    'A+B': (): RecoverRequest => ({ op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }),
    'A+C': (): RecoverRequest => ({ op: 'recover', combo: 'A+C', signed, encC, code: secrets.code() }),
    'B+C': (): RecoverRequest => ({ op: 'recover', combo: 'B+C', signed, encB, encC, prf: secrets.prf(), code: secrets.code() }),
  };
}

const failing = (overrides: Partial<SignerDeps>, base: SignerDeps): SignerDeps => ({ ...base, ...overrides });

describe('enrollment', () => {
  it('sends A, encB, encC and digests, and returns the signed manifest', async () => {
    const e = await enrolled();
    const [body] = e.server.posted;
    expect(body.setId).toBe(SET_ID);
    expect(body.credentialId).toBe('cred');
    expect(body.expectedAddress).toBe(e.owner);
    expect(body.smartAccount.address).toBe(e.address);
    expect(predictSafeAddress(e.owner)).toBe(e.address);
    expect(body.wdkUtilsVersion).toBe(WDK_UTILS_VERSION);
    expect(body.shareDigests.A).toBe(await shareDigest(body.shareA));
    expect(body.encB.kdf).toBe('prf-hkdf-sha256');
    expect(body.encC.kdf).toBe('argon2id');
    expect(e.signed.manifest.expectedAddress).toBe(e.owner);
    expect(e.signed.manifest.smartAccount.address).toBe(e.address);
    expect(e.wdkVersionMismatch).toBe(false);
  });

  it('each enrollment generates a new 12-word seed', async () => {
    const [first, second] = await Promise.all([enrolled(), enrolled()]);
    expect(first.address).not.toBe(second.address);
    const b = await openShareB(first.encB, first.secrets.prf(), { userId: USER, setId: SET_ID });
    const hexB = Buffer.from(b).toString('hex');
    expect((await combineMnemonic([first.server.posted[0].shareA, hexB])).split(' ')).toHaveLength(12);
  });

  it('aborts if the server returns a signed manifest that does not match what was sent', async () => {
    const server = makeServer();
    const secrets = makeSecrets();
    const response = await handleWorkerRequest(
      { op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() },
      failing(
        {
          async postShares(body) {
            const signed = await server.deps.postShares(body);
            const other = '0x0000000000000000000000000000000000000001';
            const manifest = { ...signed.manifest, expectedAddress: other, smartAccount: smartAccountFor(other) };
            return signManifest(manifest, server.signingKey);
          },
        },
        server.deps,
      ),
    );
    expect(response).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
  });

  it('aborts if the returned manifest signature is not from the pinned key', async () => {
    const server = makeServer();
    const secrets = makeSecrets();
    const response = await handleWorkerRequest(
      { op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() },
      { ...server.deps, manifestPubKey: makeKeys().manifestPubKey },
    );
    expect(response).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
  });

  it('a code with an invalid format never calls the API', async () => {
    const server = makeServer();
    const response = await handleWorkerRequest(
      { op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: randomBytes(32), code: new Uint8Array(3) },
      server.deps,
    );
    expect(response).toEqual({ ok: false, code: 'BAD_RECOVERY_CODE' });
    expect(server.posted).toHaveLength(0);
  });
});

describe('recovery', () => {
  it.each(['A+B', 'A+C', 'B+C'] as const)('%s returns the expected address and nothing else', async (combo) => {
    const e = await enrolled();
    const response = await handleWorkerRequest(requests(e)[combo](), e.server.deps);
    expect(response).toEqual({ ok: true, address: e.address, owner: e.owner, wdkVersionMismatch: false });
  });

  it('B+C makes no API calls', async () => {
    const e = await enrolled();
    const noNetwork = failing(
      {
        fetchShareA: vi.fn(async () => {
          throw new Error('should not be called');
        }),
        postShares: vi.fn(async () => {
          throw new Error('should not be called');
        }),
      },
      e.server.deps,
    );
    expect(expectOk(await handleWorkerRequest(requests(e)['B+C'](), noNetwork)).address).toBe(e.address);
    expect(noNetwork.fetchShareA).not.toHaveBeenCalled();
    expect(noNetwork.postShares).not.toHaveBeenCalled();
  });

  it('a wrong passkey or code never requests A from the server', async () => {
    const e = await enrolled();
    const { signed, encB, encC } = e;
    const wrongPrf = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB, prf: randomBytes(32) }, e.server.deps);
    const wrongCode = await handleWorkerRequest(
      { op: 'recover', combo: 'A+C', signed, encC, code: recoveryCodeToBytes(generateRecoveryCode()) },
      e.server.deps,
    );
    expect(wrongPrf).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(wrongCode).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(e.server.fetched).toHaveLength(0);
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('a code with an invalid format returns BAD_RECOVERY_CODE', async () => {
    const e = await enrolled();
    const response = await handleWorkerRequest(
      { op: 'recover', combo: 'A+C', signed: e.signed, encC: e.encC, code: new Uint8Array(26) },
      e.server.deps,
    );
    expect(response).toEqual({ ok: false, code: 'BAD_RECOVERY_CODE' });
  });

  it('a manifest with a tampered digest and no re-signing aborts before decrypting and combining', async () => {
    const e = await enrolled();
    const tampered: SignedManifest = {
      ...e.signed,
      manifest: { ...e.signed.manifest, shareDigests: { ...e.signed.manifest.shareDigests, B: 'ff'.repeat(32) } },
    };
    const response = await handleWorkerRequest(
      { op: 'recover', combo: 'A+B', signed: tampered, encB: e.encB, prf: e.secrets.prf() },
      e.server.deps,
    );
    expect(response).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
    expect(e.server.fetched).toHaveLength(0);
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('an invalid signature aborts before combining', async () => {
    const e = await enrolled();
    const signed = { ...e.signed, signature: flipBit(e.signed.signature) };
    const response = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB: e.encB, prf: e.secrets.prf() }, e.server.deps);
    expect(response).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('a mismatching digest, in a properly signed manifest, aborts before combining', async () => {
    const e = await enrolled();
    const manifest: Manifest = {
      ...e.signed.manifest,
      shareDigests: { ...e.signed.manifest.shareDigests, B: 'ff'.repeat(32) },
    };
    const signed = signManifest(manifest, e.server.signingKey);
    const response = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB: e.encB, prf: e.secrets.prf() }, e.server.deps);
    expect(response).toEqual({ ok: false, code: 'SHARE_TAMPERED' });
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('a share A tampered with by the server is detected before combining', async () => {
    const e = await enrolled();
    const honest = e.server.posted[0].shareA;
    const flipped = (Number.parseInt(honest[0], 16) ^ 1).toString(16) + honest.slice(1);
    for (const shareA of [flipped, 'zz', '']) {
      const response = await handleWorkerRequest(
        requests(e)['A+B'](),
        failing({ fetchShareA: async () => shareA }, e.server.deps),
      );
      expect(response).toEqual({ ok: false, code: 'SHARE_TAMPERED' });
    }
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('a different expected address returns ADDRESS_MISMATCH, even if the manifest is properly signed', async () => {
    const e = await enrolled();
    const owner = deriveAddress(MNEMONIC);
    const manifest = { ...e.signed.manifest, expectedAddress: owner, smartAccount: smartAccountFor(owner) };
    const signed = signManifest(manifest, e.server.signingKey);
    const response = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB: e.encB, prf: e.secrets.prf() }, e.server.deps);
    expect(response).toEqual({ ok: false, code: 'ADDRESS_MISMATCH' });
  });

  it('a tampered Safe in a properly signed manifest aborts without decrypting or requesting A', async () => {
    const e = await enrolled();
    const fetched = e.server.fetched.length;
    const smartAccount = { ...e.signed.manifest.smartAccount, address: '0x0000000000000000000000000000000000000001' as const };
    const signed = signManifest({ ...e.signed.manifest, smartAccount }, e.server.signingKey);
    const response = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB: e.encB, prf: e.secrets.prf() }, e.server.deps);
    expect(response).toEqual({ ok: false, code: 'ADDRESS_MISMATCH' });
    expect(e.server.fetched).toHaveLength(fetched);
  });

  it('a rotation keeps the signed parameters even if the defaults change', async () => {
    const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const params = { ...DEFAULT_SAFE_PARAMS, saltNonce: '0x01' as const };
    expect(smartAccountFor(owner, params).address).not.toBe(predictSafeAddress(owner));
    expect(smartAccountFor(owner, params).address).toBe(predictSafeAddress(owner, params));
  });

  it('an unsupported format aborts before decrypting', async () => {
    const e = await enrolled();
    const signed = signManifest({ ...e.signed.manifest, format: 'other' }, e.server.signingKey);
    const response = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB: e.encB, prf: randomBytes(32) }, e.server.deps);
    expect(response).toEqual({ ok: false, code: 'FORMAT_UNSUPPORTED' });
  });

  it('a properly signed envelope from another set does not pass: the AAD is built from the manifest', async () => {
    const first = await enrolled(SET_ID);
    const second = await enrolled(SET_2);
    const response = await handleWorkerRequest(
      { op: 'recover', combo: 'A+B', signed: first.signed, encB: { ...second.encB, setId: SET_ID }, prf: second.secrets.prf() },
      first.server.deps,
    );
    expect(response).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });

  it('shares mixed from two sets, with a manifest that accepts them, fail in combineMnemonic', async () => {
    const { signingKey, manifestPubKey } = makeKeys();
    const ids = { userId: USER, setId: SET_ID };
    const [a1] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    const [, b2, c2] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    const prf = randomBytes(32);
    const code = generateRecoveryCode();
    const encB = await sealShareB(hexDecode(b2), prf, ids);
    const encC = await sealShareC(hexDecode(c2), recoveryCodeToBytes(code), ids);
    const signed = signManifest(
      buildManifest({
        ...ids,
        shareDigests: { A: await shareDigest(a1), B: await shareDigest(b2), C: await shareDigest(c2) },
        expectedAddress: deriveAddress(MNEMONIC),
        wdkUtilsVersion: WDK_UTILS_VERSION,
      }),
      signingKey,
    );
    const response = await handleWorkerRequest(
      { op: 'recover', combo: 'A+B', signed, encB, prf },
      { manifestPubKey, fetchShareA: async () => a1, postShares: async () => signed, fetchChainStatus: async () => { throw new Error('no'); } },
    );
    expect(response).toEqual({ ok: false, code: 'COMBINE_FAILED' });
    // Control check: B and C do belong to the same set.
    await expect(openShareC(encC, recoveryCodeToBytes(code), ids)).resolves.toBeDefined();
  });

  it('a different wdk-utils version does not abort, but warns', async () => {
    const e = await enrolled();
    const signed = signManifest({ ...e.signed.manifest, wdkUtilsVersion: '0.0.1' }, e.server.signingKey);
    const response = await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB: e.encB, prf: e.secrets.prf() }, e.server.deps);
    expect(response).toEqual({ ok: true, address: e.address, owner: e.owner, wdkVersionMismatch: true });
  });

  it('zeroes prf and code, whether it succeeds or fails', async () => {
    const e = await enrolled();
    const prf = e.secrets.prf();
    const code = e.secrets.code();
    expectOk(await handleWorkerRequest({ op: 'recover', combo: 'B+C', signed: e.signed, encB: e.encB, encC: e.encC, prf, code }, e.server.deps));
    expect(prf.every((byte) => byte === 0)).toBe(true);
    expect(code.every((byte) => byte === 0)).toBe(true);

    const badPrf = randomBytes(32);
    await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed: e.signed, encB: e.encB, prf: badPrf }, e.server.deps);
    expect(badPrf.every((byte) => byte === 0)).toBe(true);
  });

  it('network and session errors propagate as a code', async () => {
    const e = await enrolled();
    const { WalletError } = await import('@wl-embedded-wallet/core/types');
    for (const code of ['NETWORK', 'UNAUTHORIZED'] as const) {
      const response = await handleWorkerRequest(
        requests(e)['A+B'](),
        failing({ fetchShareA: async () => { throw new WalletError(code); } }, e.server.deps),
      );
      expect(response).toEqual({ ok: false, code });
    }
  });
});

describe('re-enrollment from A+C', () => {
  it('creates a new set with the same seed, a new passkey and code, incompatible with the previous one', async () => {
    const old = await enrolled(SET_ID);
    const fresh = makeSecrets();
    const response = expectOk(
      await handleWorkerRequest(
        {
          op: 'enroll',
          userId: USER,
          setId: SET_2,
          credentialId: 'cred-2',
          prf: fresh.prf(),
          code: fresh.code(),
          source: { op: 'recover', combo: 'A+C', signed: old.signed, encC: old.encC, code: old.secrets.code() },
        },
        old.server.deps,
      ),
    );
    expect(response.address).toBe(old.address);
    const { signed, encB, encC } = response.enrolled!;
    expect(signed.manifest.setId).toBe(SET_2);
    expect(signed.manifest.shareDigests).not.toEqual(old.signed.manifest.shareDigests);

    for (const req of [
      { op: 'recover', combo: 'A+B', signed, encB, prf: fresh.prf() },
      { op: 'recover', combo: 'A+C', signed, encC, code: fresh.code() },
      { op: 'recover', combo: 'B+C', signed, encB, encC, prf: fresh.prf(), code: fresh.code() },
    ] as RecoverRequest[]) {
      expect(expectOk(await handleWorkerRequest(req, old.server.deps)).address).toBe(old.address);
    }

    // The old credentials do not open the new set.
    const oldCode = await handleWorkerRequest(
      { op: 'recover', combo: 'A+C', signed, encC, code: old.secrets.code() },
      old.server.deps,
    );
    expect(oldCode).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });

  it('with a wrong source code it creates nothing', async () => {
    const old = await enrolled(SET_ID);
    const fresh = makeSecrets();
    const before = old.server.posted.length;
    const response = await handleWorkerRequest(
      {
        op: 'enroll',
        userId: USER,
        setId: SET_2,
        credentialId: 'cred-2',
        prf: fresh.prf(),
        code: fresh.code(),
        source: { op: 'recover', combo: 'A+C', signed: old.signed, encC: old.encC, code: fresh.code() },
      },
      old.server.deps,
    );
    expect(response).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(old.server.posted).toHaveLength(before);
  });

  it('rejects a source from another user', async () => {
    const old = await enrolled(SET_ID);
    const fresh = makeSecrets();
    const response = await handleWorkerRequest(
      {
        op: 'enroll',
        userId: 'mallory',
        setId: SET_2,
        credentialId: 'cred-2',
        prf: fresh.prf(),
        code: fresh.code(),
        source: { op: 'recover', combo: 'A+C', signed: old.signed, encC: old.encC, code: old.secrets.code() },
      },
      old.server.deps,
    );
    expect(response).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
  });
});
