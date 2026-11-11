import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { combineMnemonic } from '@tetherto/wdk-utils';
import { recoverSafeMessageSigner, recoverSafeOperationSigner, requestHash, type SafeMessageRequest } from '@wl-embedded-wallet/core/safe';
import { recoverTypedDataAddress } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getTool } from '../../app/recovery-tool/route';
import { hexEncode } from '@wl-embedded-wallet/core/encoding';
import { openShareB } from '@wl-embedded-wallet/core/envelope';
import { buildKit, parseKit } from '@wl-embedded-wallet/core/kit';
import { buildManifest, signManifest } from '@wl-embedded-wallet/core/manifest';
import { handleWorkerRequest } from '@wl-embedded-wallet/core/signer';
import { relinkTypedData } from '@wl-embedded-wallet/core/relink';
import { transferablesOf } from '../../lib/signer-client';
import type { OfflineSource, RecoverBC, RecoverKitCode, RelinkChallenge, SignRequest, WorkerRequest } from '@wl-embedded-wallet/core/types';
import { CHAIN_ID, expectOk, flipBit, makeSecrets, makeServer, SET_ID, USER } from './helpers';

const IDS = { userId: USER, setId: SET_ID };

async function enrolled() {
  const server = makeServer();
  const secrets = makeSecrets();
  const response = expectOk(await handleWorkerRequest({ op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() }, server.deps));
  const { signed, encB, encC, seedBackup } = response.enrolled!;
  const bc = (): RecoverBC => ({ op: 'recover', combo: 'B+C', signed, encB, encC, prf: secrets.prf(), code: secrets.code() });
  const kitCode = (): RecoverKitCode => ({ op: 'recover', combo: 'kit+code', signed, seedBackup, code: secrets.code() });
  return { server, secrets, signed, encB, encC, seedBackup, bc, kitCode, owner: response.owner, safe: response.address };
}

const otherCode = () => makeSecrets().code();

describe('seed backup at enrollment', () => {
  it('the kit carries it, not the server: the POST body does not have it and the seed never travels in the clear', async () => {
    const { server, seedBackup, encC, signed, encB, secrets } = await enrolled();
    const posted = JSON.stringify(server.posted);
    expect(seedBackup.v).toBe(1);
    expect(Object.keys(server.posted[0])).not.toContain('seedBackup');
    for (const value of [seedBackup.ct, seedBackup.salt, seedBackup.iv]) expect(posted).not.toContain(value);

    const shareB = hexEncode(await openShareB(encB, secrets.prf(), IDS));
    const mnemonic = await combineMnemonic([server.posted[0].shareA, shareB]);
    expect(posted).not.toContain(mnemonic);
    expect(JSON.stringify(seedBackup)).not.toContain(mnemonic);

    // Its own salt and nonce, with the same parameters as C.
    expect(seedBackup.salt).not.toBe(encC.salt);
    expect(seedBackup.iv).not.toBe(encC.iv);
    expect(seedBackup.kdfParams).toEqual(encC.kdfParams);

    const kit = buildKit({ rpId: 'vault.localhost', credentialId: 'cred', encB, encC, signed, seedBackup });
    expect(kit.v).toBe(2);
    expect(parseKit(JSON.stringify(kit))).toEqual(kit);
  });

  it('kit and code are enough: they give the same seed, without asking the server for anything', async () => {
    const { server, kitCode, owner, safe, signed, secrets, encB } = await enrolled();
    const fetched = server.fetched.length;
    const exported = expectOk(await handleWorkerRequest({ op: 'export-recovered', source: kitCode() }, server.deps));
    expect(exported).toMatchObject({ owner, address: safe });
    const shareB = hexEncode(await openShareB(encB, secrets.prf(), IDS));
    expect(exported.mnemonic).toBe(await combineMnemonic([server.posted[0].shareA, shareB]));
    expect(server.fetched.length).toBe(fetched);
    // Only the export returns the seed.
    expect(expectOk(await handleWorkerRequest({ op: 'recover', combo: 'kit+code', signed, seedBackup: kitCode().seedBackup, code: secrets.code() }, server.deps)).mnemonic).toBeUndefined();
  });

  it('kit and code: wrong code, tampered backup, another user\'s kit and tampered manifest', async () => {
    const mine = await enrolled();
    const theirs = await enrolled();
    const run = (source: RecoverKitCode) => handleWorkerRequest(source, mine.server.deps);
    expect(await run({ ...mine.kitCode(), code: otherCode() })).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(await run({ ...mine.kitCode(), seedBackup: { ...mine.seedBackup, ct: flipBit(mine.seedBackup.ct) } })).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(await run({ ...mine.kitCode(), seedBackup: theirs.seedBackup })).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(await run(theirs.kitCode())).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
    expect(await run({ ...mine.kitCode(), signed: { ...mine.signed, signature: flipBit(mine.signed.signature) } })).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
  });

  it('if the backup cannot be opened, enrollment stops before sending anything', async () => {
    const server = makeServer();
    const secrets = makeSecrets();
    const code = secrets.code();
    code[0] = 0x21; // Not a character of the code alphabet.
    const response = await handleWorkerRequest({ op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code }, server.deps);
    expect(response).toEqual({ ok: false, code: 'BAD_RECOVERY_CODE' });
    expect(server.posted).toEqual([]);
  });
});

describe('B+C in operation', () => {
  const REQUESTS: SafeMessageRequest[] = [
    { kind: 'message', message: 'Hello' },
    { kind: 'typedData', typedData: { domain: { name: 'App', version: '1', chainId: CHAIN_ID }, types: { Payment: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Payment', message: { amount: '5' } } },
  ];

  for (const request of REQUESTS) {
    it(`signs ${request.kind} as the Safe, on that chain, without a server`, async () => {
      for (const source of ['bc', 'kitCode'] as const) {
        const wallet = await enrolled();
        const deps = { ...wallet.server.deps, fetchChainStatus: () => Promise.reject(new Error('must not ask')), fetchShareA: () => Promise.reject(new Error('must not request A')), postShares: () => Promise.reject(new Error('must not write')) };
        const response = expectOk(await handleWorkerRequest({ op: 'sign-recovered', chainId: CHAIN_ID, source: wallet[source](), request }, deps));
        expect(await recoverSafeMessageSigner(wallet.safe, CHAIN_ID, requestHash(request), response.signature!)).toBe(wallet.owner);
      }
    });
  }

  it('signs a UserOperation without sending it', async () => {
    const wallet = await enrolled();
    const userOperation = { calls: [{ to: wallet.owner, value: '1' }], nonce: '0', callGasLimit: '100000', verificationGasLimit: '100000', preVerificationGas: '50000', maxFeePerGas: '10', maxPriorityFeePerGas: '1' };
    const response = expectOk(await handleWorkerRequest({ op: 'sign-recovered', chainId: CHAIN_ID, source: wallet.bc(), request: { kind: 'userOperation', userOperation } }, wallet.server.deps));
    expect(response.userOperation?.sender).toBe(wallet.safe);
    expect(response.userOperation?.factory).toBeNull();
    expect(await recoverSafeOperationSigner(response.userOperation!, CHAIN_ID, wallet.signed.manifest.smartAccount)).toBe(wallet.owner);
  });

  it('a signature from one chain is not valid on another', async () => {
    const wallet = await enrolled();
    const request = { kind: 'message', message: 'Hello' } as const;
    const response = expectOk(await handleWorkerRequest({ op: 'sign-recovered', chainId: CHAIN_ID, source: wallet.bc(), request }, wallet.server.deps));
    expect(await recoverSafeMessageSigner(wallet.safe, CHAIN_ID + 1, requestHash(request), response.signature!)).not.toBe(wallet.owner);
  });

  it('rejects an invalid chain or an unknown request before using the seed', async () => {
    const wallet = await enrolled();
    expect(await handleWorkerRequest({ op: 'sign-recovered', chainId: 0, source: wallet.bc(), request: { kind: 'message', message: 'x' } }, wallet.server.deps)).toEqual({ ok: false, code: 'CHAIN_NOT_SUPPORTED' });
    expect(await handleWorkerRequest({ op: 'sign-recovered', chainId: 1, source: wallet.bc(), request: { kind: 'other' } as never }, wallet.server.deps)).toEqual({ ok: false, code: 'INTERNAL' });
  });

  it('a wrong code or passkey neither signs nor exports', async () => {
    const wallet = await enrolled();
    const request: SignRequest = { kind: 'message', message: 'Hello' };
    const badCode: OfflineSource = { ...wallet.bc(), code: otherCode() };
    expect(await handleWorkerRequest({ op: 'sign-recovered', chainId: 1, source: badCode, request }, wallet.server.deps)).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    expect(await handleWorkerRequest({ op: 'export-recovered', source: badCode }, wallet.server.deps)).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
    const badPrf: OfflineSource = { ...wallet.bc(), prf: makeSecrets().prf() };
    expect(await handleWorkerRequest({ op: 'export-recovered', source: badPrf }, wallet.server.deps)).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });

  it('export with B+C gives the seed, and its buffers are zeroed', async () => {
    const wallet = await enrolled();
    const source = wallet.bc();
    const response = expectOk(await handleWorkerRequest({ op: 'export-recovered', source }, wallet.server.deps));
    expect(response.mnemonic?.split(' ')).toHaveLength(12);
    expect(source.prf.every((byte) => byte === 0)).toBe(true);
    expect(source.code.every((byte) => byte === 0)).toBe(true);
  });

  it('re-enrolls with B+C and with kit and code: same Safe, new shares and backup', async () => {
    for (const kind of ['bc', 'kitCode'] as const) {
      const wallet = await enrolled();
      const fresh = makeSecrets();
      const setId = crypto.randomUUID();
      const response = expectOk(
        await handleWorkerRequest({ op: 'enroll', userId: USER, setId, credentialId: 'new', prf: fresh.prf(), code: fresh.code(), source: wallet[kind]() }, wallet.server.deps),
      );
      expect(response.address).toBe(wallet.safe);
      expect(response.owner).toBe(wallet.owner);
      expect(response.enrolled?.signed.manifest.setId).toBe(setId);
      expect(response.enrolled?.seedBackup.ct).not.toBe(wallet.seedBackup.ct);
      // The new backup opens with the new code, and the old one still opens with the old code: the server cannot revoke it.
      const newSource: RecoverKitCode = { op: 'recover', combo: 'kit+code', signed: response.enrolled!.signed, seedBackup: response.enrolled!.seedBackup, code: fresh.code() };
      expectOk(await handleWorkerRequest(newSource, wallet.server.deps));
      expectOk(await handleWorkerRequest(wallet.kitCode(), wallet.server.deps));
    }
  });

  it('re-enrolling from another account only works with the wallet the server already has linked', async () => {
    const wallet = await enrolled();
    const fresh = makeSecrets();
    const enroll = (linkedOwner?: string): WorkerRequest => ({ op: 'enroll', userId: 'other-account', setId: crypto.randomUUID(), credentialId: 'new', prf: fresh.prf(), code: fresh.code(), source: wallet.kitCode(), linkedOwner });
    expect(await handleWorkerRequest(enroll(), wallet.server.deps)).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
    expect(await handleWorkerRequest(enroll('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'), wallet.server.deps)).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
    const linked = await handleWorkerRequest(enroll(wallet.owner), {
      ...wallet.server.deps,
      postShares: async (body) =>
        signManifest(
          buildManifest({ userId: 'other-account', setId: body.setId, shareDigests: body.shareDigests, expectedAddress: body.expectedAddress, smartAccount: body.smartAccount, wdkUtilsVersion: body.wdkUtilsVersion }),
          wallet.server.signingKey,
        ),
    });
    expect(expectOk(linked).address).toBe(wallet.safe);
  });
});

describe('relink signature', () => {
  const relinkOf = (wallet: Awaited<ReturnType<typeof enrolled>>): RelinkChallenge => ({
    safe: wallet.safe,
    owner: wallet.owner,
    newSub: 'new-account',
    issuer: 'https://login.test',
    vaultOrigin: 'https://vault.test',
    nonce: 'nonce',
    expiresAt: 1_900_000_000,
  });

  it('the owner signs it, with B+C or with kit and code, without calling the server', async () => {
    for (const kind of ['bc', 'kitCode'] as const) {
      const wallet = await enrolled();
      const relink = relinkOf(wallet);
      const response = expectOk(await handleWorkerRequest({ op: 'sign-relink', source: wallet[kind](), relink }, wallet.server.deps));
      expect(await recoverTypedDataAddress({ ...relinkTypedData(relink), signature: response.signature! })).toBe(wallet.owner);
    }
  });

  it('a request for another wallet never uses the seed', async () => {
    const wallet = await enrolled();
    const other = await enrolled();
    expect(await handleWorkerRequest({ op: 'sign-relink', source: wallet.bc(), relink: { ...relinkOf(wallet), owner: other.owner } }, wallet.server.deps)).toEqual({ ok: false, code: 'ADDRESS_MISMATCH' });
    expect(await handleWorkerRequest({ op: 'sign-relink', source: wallet.bc(), relink: { ...relinkOf(wallet), safe: other.safe } }, wallet.server.deps)).toEqual({ ok: false, code: 'ADDRESS_MISMATCH' });
  });
});

describe('new kit for a wallet with an old kit', () => {
  it('with A+B and with B+C, checking the code against C', async () => {
    const wallet = await enrolled();
    const { signed, encB, encC, secrets } = wallet;
    const ab = expectOk(await handleWorkerRequest({ op: 'upgrade-kit', source: { op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, encC, code: secrets.code() }, wallet.server.deps));
    const bc = expectOk(await handleWorkerRequest({ op: 'upgrade-kit', source: wallet.bc(), encC, code: secrets.code() }, wallet.server.deps));
    for (const response of [ab, bc]) {
      expectOk(await handleWorkerRequest({ op: 'recover', combo: 'kit+code', signed, seedBackup: response.seedBackup!, code: secrets.code() }, wallet.server.deps));
    }
    expect(ab.seedBackup?.salt).not.toBe(bc.seedBackup?.salt);
  });

  it('a wrong code generates nothing, even if the passkey is valid', async () => {
    const wallet = await enrolled();
    const { signed, encB, encC, secrets } = wallet;
    expect(await handleWorkerRequest({ op: 'upgrade-kit', source: { op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, encC, code: otherCode() }, wallet.server.deps)).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
  });

  it('C from another set is not valid', async () => {
    const wallet = await enrolled();
    const other = await enrolled();
    const { signed, encB, secrets } = wallet;
    // It opens with its own code, but its digest is not the one in the signed manifest.
    expect(await handleWorkerRequest({ op: 'upgrade-kit', source: { op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, encC: other.encC, code: other.secrets.code() }, wallet.server.deps)).toEqual({ ok: false, code: 'SHARE_TAMPERED' });
  });
});

describe('transfer to the worker', () => {
  it('includes the buffers of the new operations', async () => {
    const wallet = await enrolled();
    const bc = wallet.bc();
    const kitCode = wallet.kitCode();
    const request = { kind: 'message', message: 'x' } as const;
    expect(transferablesOf({ op: 'sign-recovered', chainId: 1, source: bc, request })).toEqual([bc.prf.buffer, bc.code.buffer]);
    expect(transferablesOf({ op: 'export-recovered', source: kitCode })).toEqual([kitCode.code.buffer]);
    expect(transferablesOf(kitCode)).toEqual([kitCode.code.buffer]);
    const code = makeSecrets().code();
    expect(transferablesOf({ op: 'upgrade-kit', source: bc, encC: wallet.encC, code })).toEqual([bc.prf.buffer, bc.code.buffer, code.buffer]);
  });
});

describe('GET /recovery-tool', () => {
  beforeAll(() => {
    if (!existsSync(resolve('../../packages/recovery-tool/dist/wl-embedded-wallet-recovery.html'))) {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: resolve('../../packages/recovery-tool'), stdio: 'pipe' });
    }
  });

  it('serves the tool as a download, without user data', async () => {
    const response = await getTool();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(await response.text()).toContain('offline-tool');
  });
});
