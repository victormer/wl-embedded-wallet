import { describe, expect, it, vi } from 'vitest';
import { b64urlEncode, hexEncode, randomBytes, sha256, utf8 } from '@wl-embedded-wallet/core/encoding';
import { getPrfOutput, passkeyUserHandle, prfSalt, PrfError, registerPasskeyWithPrf } from '../../lib/prf';

const RAW_ID = randomBytes(16);
const CREDENTIAL_ID = b64urlEncode(RAW_ID);
const OUTPUT = randomBytes(32);
const IDS = { userId: 'alice', setId: 'set-1' };

// The layout delivers the RP ID in the HTML.
vi.stubGlobal('document', {
  getElementById: () => ({ dataset: { rpId: 'vault.localhost', manifestPubkey: 'ab', brand: 'Brand' } }),
});

type Prf = { enabled?: boolean; results?: { first?: BufferSource } } | undefined;

function credential(prf: Prf) {
  return { rawId: RAW_ID.buffer, getClientExtensionResults: () => ({ prf }) } as unknown as PublicKeyCredential;
}

function container(onCreate: Prf, onGet?: Prf) {
  return {
    create: vi.fn(async () => credential(onCreate)),
    get: vi.fn(async () => credential(onGet)),
  } as unknown as CredentialsContainer & { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
}

describe('registerPasskeyWithPrf', () => {
  it('uses the create result if present, without calling get', async () => {
    const credentials = container({ enabled: true, results: { first: OUTPUT.buffer } });
    const result = await registerPasskeyWithPrf({ ...IDS, credentials });
    expect(result.prfSource).toBe('create');
    expect(result.credentialId).toBe(CREDENTIAL_ID);
    expect(hexEncode(result.prfOutput)).toBe(hexEncode(OUTPUT));
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it('calls get with the same eval if create only returns enabled', async () => {
    const credentials = container({ enabled: true }, { results: { first: OUTPUT.buffer } });
    const result = await registerPasskeyWithPrf({ ...IDS, credentials });
    expect(result.prfSource).toBe('get');
    expect(hexEncode(result.prfOutput)).toBe(hexEncode(OUTPUT));
    const created = credentials.create.mock.calls[0][0].publicKey;
    const got = credentials.get.mock.calls[0][0].publicKey;
    expect(hexEncode(got.extensions.prf.eval.first)).toBe(hexEncode(created.extensions.prf.eval.first));
    expect(hexEncode(got.allowCredentials[0].id)).toBe(hexEncode(RAW_ID));
    expect(got.userVerification).toBe('required');
    expect(got.rpId).toBe('vault.localhost');
  });

  it('requests what the spec requires in create', async () => {
    const credentials = container({ enabled: true, results: { first: OUTPUT } });
    await registerPasskeyWithPrf({ ...IDS, credentials });
    const { publicKey } = credentials.create.mock.calls[0][0];
    expect(publicKey.rp.id).toBe('vault.localhost');
    expect(publicKey.authenticatorSelection.residentKey).toBe('required');
    expect(publicKey.authenticatorSelection.userVerification).toBe('required');
    expect(hexEncode(publicKey.extensions.prf.eval.first)).toBe(hexEncode(await sha256(utf8('wl-embedded-wallet/share-b/prf/v1'))));
    expect(hexEncode(publicKey.user.id)).toBe(hexEncode(await passkeyUserHandle('alice', 'set-1')));
    expect(hexEncode(publicKey.user.id)).toBe(hexEncode(await sha256(utf8('alice|set-1'))));
  });

  it.each([
    ['enabled false', { enabled: false }],
    ['no extension', undefined],
    ['enabled missing', {}],
  ])('aborts registration with %s, without calling get', async (_label, prf) => {
    const credentials = container(prf as Prf);
    await expect(registerPasskeyWithPrf({ ...IDS, credentials })).rejects.toMatchObject({ reason: 'PRF_UNSUPPORTED' });
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it('aborts if enabled is true but get returns no result', async () => {
    const credentials = container({ enabled: true }, {});
    await expect(registerPasskeyWithPrf({ ...IDS, credentials })).rejects.toMatchObject({ reason: 'PRF_NOT_RETURNED' });
  });

  it('the user handle changes with each set and the salt is fixed', async () => {
    expect(hexEncode(await passkeyUserHandle('alice', 'a'))).not.toBe(hexEncode(await passkeyUserHandle('alice', 'b')));
    expect(hexEncode(await prfSalt())).toBe(hexEncode(await prfSalt()));
  });
});

describe('getPrfOutput', () => {
  it('rejects an output that is not 32 bytes', async () => {
    const credentials = container(undefined, { results: { first: new Uint8Array(16) } });
    await expect(getPrfOutput(CREDENTIAL_ID, { credentials })).rejects.toMatchObject({ reason: 'PRF_NOT_RETURNED' });
  });

  it('accepts a view and copies only its bytes', async () => {
    const backing = new Uint8Array(64).fill(7);
    const credentials = container(undefined, { results: { first: backing.subarray(8, 40) } });
    const output = await getPrfOutput(CREDENTIAL_ID, { credentials });
    expect(output).toHaveLength(32);
    expect(output.buffer.byteLength).toBe(32);
  });

  it('distinguishes cancellation from other failures', async () => {
    const cancel = { get: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } } as unknown as CredentialsContainer;
    const broken = { get: async () => { throw new Error('internal-secret-detail'); } } as unknown as CredentialsContainer;
    await expect(getPrfOutput(CREDENTIAL_ID, { credentials: cancel })).rejects.toMatchObject({ reason: 'CANCELLED' });
    const error = await getPrfOutput(CREDENTIAL_ID, { credentials: broken }).catch((e) => e);
    expect(error).toBeInstanceOf(PrfError);
    expect(error.reason).toBe('WEBAUTHN_FAILED');
    expect(error.message).not.toContain('internal-secret-detail');
  });
});
