import { predictSafeAddress } from '@wl-embedded-wallet/core/safe';
import { combineMnemonic } from '@tetherto/wdk-utils';
import { mnemonicToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from '@wl-embedded-wallet/core/encoding';
import { signManifest } from '@wl-embedded-wallet/core/manifest';
import { handleWorkerRequest } from '@wl-embedded-wallet/core/signer';
import type { WorkerResponse } from '@wl-embedded-wallet/core/types';
import { expectOk, flipBit, makeSecrets, makeServer, SET_ID, USER } from './helpers';

vi.mock('@tetherto/wdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tetherto/wdk-utils')>();
  return { ...actual, combineMnemonic: vi.fn(actual.combineMnemonic) };
});

async function setup() {
  const server = makeServer();
  const secrets = makeSecrets();
  const enrolled = expectOk(
    await handleWorkerRequest(
      { op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() },
      server.deps,
    ),
  );
  vi.mocked(combineMnemonic).mockClear();
  return { server, secrets, enrolled, ...enrolled.enrolled! };
}

function expectNoSeed(response: WorkerResponse, code: string) {
  expect(response).toEqual({ ok: false, code });
}

describe('op export', () => {
  afterEach(() => {
    vi.mocked(combineMnemonic).mockClear();
  });

  it('returns the seed, and it derives the expected address', async () => {
    const { server, secrets, signed, encB, enrolled } = await setup();
    const response = expectOk(await handleWorkerRequest({ op: 'export', signed, encB, prf: secrets.prf() }, server.deps));
    expect(response.mnemonic?.split(' ')).toHaveLength(12);
    expect(mnemonicToAccount(response.mnemonic!).address).toBe(enrolled.owner);
    expect(predictSafeAddress(enrolled.owner)).toBe(enrolled.address);
    expect(response.address).toBe(enrolled.address);
  });

  it('wipes the received PRF', async () => {
    const { server, secrets, signed, encB } = await setup();
    const prf = secrets.prf();
    await handleWorkerRequest({ op: 'export', signed, encB, prf }, server.deps);
    expect([...prf].every((byte) => byte === 0)).toBe(true);
  });

  it('a manifest with an invalid signature does not return it and never gets to combine', async () => {
    const { server, secrets, signed, encB } = await setup();
    const tampered = { ...signed, signature: flipBit(signed.signature) };
    expectNoSeed(await handleWorkerRequest({ op: 'export', signed: tampered, encB, prf: secrets.prf() }, server.deps), 'MANIFEST_INVALID');
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('a tampered digest, even if properly signed, does not return it', async () => {
    const { server, secrets, signed, encB } = await setup();
    const manifest = { ...signed.manifest, shareDigests: { ...signed.manifest.shareDigests, A: '0'.repeat(64) } };
    const resigned = signManifest(manifest, server.signingKey);
    expectNoSeed(await handleWorkerRequest({ op: 'export', signed: resigned, encB, prf: secrets.prf() }, server.deps), 'SHARE_TAMPERED');
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('a substituted share A does not return it', async () => {
    const { server, secrets, signed, encB } = await setup();
    const deps = { ...server.deps, fetchShareA: async () => '01'.repeat(21) };
    expectNoSeed(await handleWorkerRequest({ op: 'export', signed, encB, prf: secrets.prf() }, deps), 'SHARE_TAMPERED');
  });

  it('a tampered envelope or a wrong passkey does not return it', async () => {
    const { server, secrets, signed, encB } = await setup();
    const altered = { ...encB, ct: flipBit(encB.ct) };
    expectNoSeed(await handleWorkerRequest({ op: 'export', signed, encB: altered, prf: secrets.prf() }, server.deps), 'DECRYPT_FAILED');
    expectNoSeed(await handleWorkerRequest({ op: 'export', signed, encB, prf: randomBytes(32) }, server.deps), 'DECRYPT_FAILED');
  });

  it('no other operation returns the seed', async () => {
    const { server, secrets, signed, encB, encC, enrolled } = await setup();
    const responses = [
      enrolled,
      await handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, server.deps),
      await handleWorkerRequest({ op: 'recover', combo: 'A+C', signed, encC, code: secrets.code() }, server.deps),
      await handleWorkerRequest({ op: 'recover', combo: 'B+C', signed, encB, encC, prf: secrets.prf(), code: secrets.code() }, server.deps),
      await handleWorkerRequest({ op: 'sign', chainId: 31001, signed, encB, prf: secrets.prf(), request: { kind: 'message', message: 'hello' } }, server.deps),
    ];
    for (const response of responses) expect(response).not.toHaveProperty('mnemonic');
  });
});
