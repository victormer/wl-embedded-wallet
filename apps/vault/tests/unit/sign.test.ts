import { deploymentCalls, encodeSafeCalls, predictSafeAddress, recoverSafeMessageSigner, recoverSafeOperationSigner, requestHash, smartAccountFor, buildDeploymentOperation, buildTransactionOperation, buildUserOperation } from '@wl-embedded-wallet/core/safe';
import { encodeFunctionData, parseAbi } from 'viem';
import type { UserOperationRequest } from '@wl-embedded-wallet/sdk/protocol';
import { combineMnemonic } from '@tetherto/wdk-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from '@wl-embedded-wallet/core/encoding';
import { handleWorkerRequest } from '@wl-embedded-wallet/core/signer';
import { signManifest, WDK_UTILS_VERSION } from '@wl-embedded-wallet/core/manifest';
import type { SendTransactionWorkerRequest, SignRequest, SignWorkerRequest } from '@wl-embedded-wallet/core/types';
import { CHAIN_ID, expectOk, flipBit, makeSecrets, makeServer, SET_ID, USER } from './helpers';

vi.mock('@tetherto/wdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tetherto/wdk-utils')>();
  return { ...actual, combineMnemonic: vi.fn(actual.combineMnemonic) };
});

const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const TYPED_DATA = {
  domain: { name: 'Example App', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  types: {
    Mail: [
      { name: 'to', type: 'address' },
      { name: 'contents', type: 'string' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  primaryType: 'Mail',
  message: { to: TO, contents: 'Hello', amount: '5' },
};

const OPERATION: UserOperationRequest = {
  calls: [{ to: TO, value: '1000000000000000' }],
  nonce: '3',
  callGasLimit: '100000',
  verificationGasLimit: '200000',
  preVerificationGas: '60000',
  maxFeePerGas: '30000000000',
  maxPriorityFeePerGas: '1000000000',
};

async function setup() {
  const server = makeServer();
  const secrets = makeSecrets();
  const enrolled = expectOk(
    await handleWorkerRequest({ op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() }, server.deps),
  );
  const { signed, encB } = enrolled.enrolled!;
  vi.mocked(combineMnemonic).mockClear();
  const signRequest = (request: SignRequest): SignWorkerRequest => ({ op: 'sign', chainId: CHAIN_ID, signed, encB, prf: secrets.prf(), request });
  return { server, secrets, safe: enrolled.address, owner: enrolled.owner, signed, encB, signRequest };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('op sign', () => {
  it('the account is the Safe predicted from the owner', async () => {
    const { safe, owner } = await setup();
    expect(safe).toBe(predictSafeAddress(owner));
    expect(safe).not.toBe(owner);
  });

  it('a message is signed as the Safe: SafeMessage bound to the Safe and the chain', async () => {
    const { server, safe, owner, signRequest } = await setup();
    const request = { kind: 'message', message: 'Hello, world' } as const;
    const response = expectOk(await handleWorkerRequest(signRequest(request), server.deps));
    const signature = response.signature!;
    expect(response.address).toBe(safe);
    expect(await recoverSafeMessageSigner(safe, CHAIN_ID, requestHash(request), signature)).toBe(owner);
    expect(await recoverSafeMessageSigner(safe, CHAIN_ID + 1, requestHash(request), signature)).not.toBe(owner);
    expect(await recoverSafeMessageSigner(owner, CHAIN_ID, requestHash(request), signature)).not.toBe(owner);
    expect(await recoverSafeMessageSigner(safe, CHAIN_ID, requestHash({ kind: 'message', message: 'Other' }), signature)).not.toBe(owner);
  });

  it('EIP-712 is signed as the Safe', async () => {
    const { server, safe, owner, signRequest } = await setup();
    const request = { kind: 'typedData', typedData: TYPED_DATA } as const;
    const response = expectOk(await handleWorkerRequest(signRequest(request), server.deps));
    expect(await recoverSafeMessageSigner(safe, CHAIN_ID, requestHash(request), response.signature!)).toBe(owner);
    const altered = { kind: 'typedData', typedData: { ...TYPED_DATA, message: { ...TYPED_DATA.message, amount: '6' } } } as const;
    expect(await recoverSafeMessageSigner(safe, CHAIN_ID, requestHash(altered), response.signature!)).not.toBe(owner);
  });

  it('signs a UserOperation with the Safe as sender, without a factory, recoverable to the owner', async () => {
    const { server, safe, owner, signRequest } = await setup();
    const response = expectOk(await handleWorkerRequest(signRequest({ kind: 'userOperation', userOperation: OPERATION }), server.deps));
    const operation = response.userOperation!;
    expect(operation).toMatchObject({ sender: safe, factory: null, factoryData: null, nonce: '3', paymaster: null, signature: response.signature });
    expect(operation.callData).toBe(encodeSafeCalls(OPERATION.calls));
    expect(await recoverSafeOperationSigner(operation, CHAIN_ID)).toBe(owner);
    expect(await recoverSafeOperationSigner(operation, CHAIN_ID + 1)).not.toBe(owner);
    expect(await recoverSafeOperationSigner({ ...operation, callData: encodeSafeCalls([{ to: safe, value: '0' }]) }, CHAIN_ID)).not.toBe(owner);
    expect(await recoverSafeOperationSigner({ ...operation, sender: owner }, CHAIN_ID)).not.toBe(owner);
  });

  it('sends nothing to the chain: only requests A and the status', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('should not be called');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { server, signRequest } = await setup();
    const before = server.fetched.length;
    for (const request of [
      { kind: 'message', message: 'x' },
      { kind: 'typedData', typedData: TYPED_DATA },
      { kind: 'userOperation', userOperation: OPERATION },
    ] as SignRequest[]) {
      expectOk(await handleWorkerRequest(signRequest(request), server.deps));
    }
    expect(server.fetched.length - before).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('each signature rebuilds the seed again and overwrites prf', async () => {
    const { server, signRequest } = await setup();
    const first = signRequest({ kind: 'message', message: 'one' });
    const second = signRequest({ kind: 'message', message: 'two' });
    expectOk(await handleWorkerRequest(first, server.deps));
    expectOk(await handleWorkerRequest(second, server.deps));
    expect(combineMnemonic).toHaveBeenCalledTimes(2);
    expect(first.prf.every((byte) => byte === 0)).toBe(true);
  });

  it('the response carries neither seed nor shares', async () => {
    const { server, signRequest } = await setup();
    const response = await handleWorkerRequest(signRequest({ kind: 'message', message: 'x' }), server.deps);
    expect(Object.keys(response).sort()).toEqual(['address', 'ok', 'owner', 'signature', 'wdkVersionMismatch']);
    expect(JSON.stringify(response)).not.toContain(server.posted[0]!.shareA);
  });

  it('warns if the wdk-utils version changes', async () => {
    const { server, signed, encB, secrets } = await setup();
    const other = signManifest({ ...signed.manifest, wdkUtilsVersion: `${WDK_UTILS_VERSION}-other` }, server.signingKey);
    const response = expectOk(
      await handleWorkerRequest({ op: 'sign', chainId: CHAIN_ID, signed: other, encB, prf: secrets.prf(), request: { kind: 'message', message: 'x' } }, server.deps),
    );
    expect(response.wdkVersionMismatch).toBe(true);
  });

  describe('does not sign', () => {
    const message: SignRequest = { kind: 'message', message: 'x' };

    it('if the Safe is not deployed on that chain: the worker decides by asking the server', async () => {
      const { server, signRequest } = await setup();
      server.chain.status = { ...server.chain.status, deployed: false, deployable: true };
      const response = await handleWorkerRequest(signRequest(message), server.deps);
      expect(response).toEqual({ ok: false, code: 'WALLET_NOT_DEPLOYED' });
      expect(server.fetched).toHaveLength(0);
      expect(combineMnemonic).not.toHaveBeenCalled();
    });

    it('if the request chain is not the session chain', async () => {
      const { server, signRequest } = await setup();
      const response = await handleWorkerRequest({ ...signRequest(message), chainId: CHAIN_ID + 1 }, server.deps);
      expect(response).toEqual({ ok: false, code: 'CHAIN_MISMATCH' });
      expect(server.fetched).toHaveLength(0);
    });

    it('with an invalid manifest signature', async () => {
      const { server, signed, encB, secrets } = await setup();
      const response = await handleWorkerRequest(
        { op: 'sign', chainId: CHAIN_ID, signed: { ...signed, signature: flipBit(signed.signature) }, encB, prf: secrets.prf(), request: message },
        server.deps,
      );
      expect(response).toEqual({ ok: false, code: 'MANIFEST_INVALID' });
      expect(combineMnemonic).not.toHaveBeenCalled();
      expect(server.fetched).toHaveLength(0);
    });

    it('with a wrong passkey', async () => {
      const { server, signed, encB } = await setup();
      const response = await handleWorkerRequest({ op: 'sign', chainId: CHAIN_ID, signed, encB, prf: randomBytes(32), request: message }, server.deps);
      expect(response).toEqual({ ok: false, code: 'DECRYPT_FAILED' });
      expect(server.fetched).toHaveLength(0);
    });

    it('if the seed does not match the owner', async () => {
      const { server, signed, encB, secrets } = await setup();
      const other = '0x0000000000000000000000000000000000000001';
      const manifest = signManifest({ ...signed.manifest, expectedAddress: other, smartAccount: smartAccountFor(other) }, server.signingKey);
      const response = await handleWorkerRequest({ op: 'sign', chainId: CHAIN_ID, signed: manifest, encB, prf: secrets.prf(), request: message }, server.deps);
      expect(response).toEqual({ ok: false, code: 'ADDRESS_MISMATCH' });
    });

    it.each([
      ['unknown kind', { kind: 'other' }],
      ['message that is not text', { kind: 'message', message: 5 }],
      ['EIP-1559 transaction', { kind: 'transaction', transaction: {} }],
    ])('with %s, without reaching reconstruction', async (_label, request) => {
      const { server, signRequest } = await setup();
      const response = await handleWorkerRequest(signRequest(request as SignRequest), server.deps);
      expect(response).toEqual({ ok: false, code: 'INTERNAL' });
      expect(server.fetched).toHaveLength(0);
      expect(combineMnemonic).not.toHaveBeenCalled();
    });
  });
});

describe('op deploy', () => {
  const FEES = { maxFeePerGas: '30000000000', maxPriorityFeePerGas: '1000000000' };
  const notDeployed = { deployed: false, deployable: true };

  it('signs only the deployment of this owner\'s Safe', async () => {
    const { server, signed, encB, secrets, safe, owner } = await setup();
    server.chain.status = { ...server.chain.status, ...notDeployed };
    const userOperation = { ...buildDeploymentOperation(owner, FEES), callGasLimit: '100000', verificationGasLimit: '900000', preVerificationGas: '90000' };
    const response = expectOk(await handleWorkerRequest({ op: 'deploy', chainId: CHAIN_ID, signed, encB, prf: secrets.prf(), userOperation }, server.deps));
    expect(response.userOperation).toMatchObject({ sender: safe, factory: userOperation.factory, signature: response.signature });
    expect(response.userOperation!.callData).toBe(encodeSafeCalls(deploymentCalls(safe)));
    expect(await recoverSafeOperationSigner(response.userOperation!, CHAIN_ID)).toBe(owner);
  });

  it.each([
    ['another sender', (op: ReturnType<typeof buildDeploymentOperation>) => ({ ...op, sender: TO as `0x${string}` })],
    ['another call', (op: ReturnType<typeof buildDeploymentOperation>) => ({ ...op, callData: encodeSafeCalls([{ to: TO, value: '1' }]) })],
    ['another factory', (op: ReturnType<typeof buildDeploymentOperation>) => ({ ...op, factory: TO })],
    ['another nonce', (op: ReturnType<typeof buildDeploymentOperation>) => ({ ...op, nonce: '1' })],
    ['no factory', (op: ReturnType<typeof buildDeploymentOperation>) => ({ ...op, factory: null, factoryData: null })],
  ])('does not use the seed with %s', async (_label, change) => {
    const { server, signed, encB, secrets, owner } = await setup();
    server.chain.status = { ...server.chain.status, ...notDeployed };
    const userOperation = change(buildDeploymentOperation(owner, FEES));
    const response = await handleWorkerRequest({ op: 'deploy', chainId: CHAIN_ID, signed, encB, prf: secrets.prf(), userOperation }, server.deps);
    expect(response).toEqual({ ok: false, code: 'INTERNAL' });
    expect(server.fetched).toHaveLength(0);
    expect(combineMnemonic).not.toHaveBeenCalled();
  });

  it('does not sign if already deployed or the chain is not supported', async () => {
    const { server, signed, encB, secrets, owner } = await setup();
    const userOperation = buildDeploymentOperation(owner, FEES);
    const response = await handleWorkerRequest({ op: 'deploy', chainId: CHAIN_ID, signed, encB, prf: secrets.prf(), userOperation }, server.deps);
    expect(response).toEqual({ ok: false, code: 'CHAIN_NOT_SUPPORTED' });
    expect(server.fetched).toHaveLength(0);
  });

  it('a signing UserOperation never carries a factory', () => {
    expect(buildUserOperation(TO as `0x${string}`, OPERATION)).toMatchObject({ factory: null, factoryData: null });
  });
});

describe('op send-transaction', () => {
  const FEES = { maxFeePerGas: '30000000000', maxPriorityFeePerGas: '1000000000' };
  const CALL = { to: TO as `0x${string}`, value: '1000000000000000', data: '0xa9059cbb' as `0x${string}` };
  const DELEGATECALL = parseAbi(['function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)']);

  async function sendSetup() {
    const context = await setup();
    // What the vault server returns after estimating: gas filled in, still the dummy signature.
    const userOperation = { ...buildTransactionOperation(context.safe, CALL, '4', FEES), callGasLimit: '100000', verificationGasLimit: '200000', preVerificationGas: '60000' };
    const request = (changes: Partial<SendTransactionWorkerRequest> = {}): SendTransactionWorkerRequest => ({
      op: 'send-transaction',
      chainId: CHAIN_ID,
      signed: context.signed,
      encB: context.encB,
      prf: context.secrets.prf(),
      transaction: CALL,
      userOperation,
      ...changes,
    });
    return { ...context, userOperation, request };
  }

  it('signs the reviewed call from the deployed Safe, recoverable to the owner', async () => {
    const { server, safe, owner, userOperation, request } = await sendSetup();
    const response = expectOk(await handleWorkerRequest(request(), server.deps));
    expect(response).toMatchObject({ address: safe, owner, signature: expect.stringMatching(/^0x[0-9a-f]+$/) });
    expect(response.userOperation).toEqual({ ...userOperation, signature: response.signature });
    expect(await recoverSafeOperationSigner(response.userOperation!, CHAIN_ID)).toBe(owner);
    expect(await recoverSafeOperationSigner(response.userOperation!, CHAIN_ID + 1)).not.toBe(owner);
    expect(await recoverSafeOperationSigner({ ...response.userOperation!, nonce: '5' }, CHAIN_ID)).not.toBe(owner);
    expect(Object.keys(response).sort()).toEqual(['address', 'ok', 'owner', 'signature', 'userOperation', 'wdkVersionMismatch']);
    expect(server.fetched).toEqual([SET_ID]);
    expect(combineMnemonic).toHaveBeenCalledTimes(1);
  });

  it('a self-transfer of value without data is allowed', async () => {
    const { server, safe, owner, request } = await sendSetup();
    const transaction = { to: safe, value: '1' };
    const userOperation = { ...buildTransactionOperation(safe, transaction, '4', FEES), callGasLimit: '100000', verificationGasLimit: '200000', preVerificationGas: '60000' };
    const response = expectOk(await handleWorkerRequest(request({ transaction, userOperation }), server.deps));
    expect(await recoverSafeOperationSigner(response.userOperation!, CHAIN_ID)).toBe(owner);
  });

  it('overwrites prf, whether it signs or not', async () => {
    const { server, request } = await sendSetup();
    const signed = request();
    expectOk(await handleWorkerRequest(signed, server.deps));
    expect(signed.prf.every((byte) => byte === 0)).toBe(true);
    const refused = request({ chainId: CHAIN_ID + 1 });
    expect((await handleWorkerRequest(refused, server.deps)).ok).toBe(false);
    expect(refused.prf.every((byte) => byte === 0)).toBe(true);
  });

  describe('does not use the seed', () => {
    const expectRefused = async (setupResult: Awaited<ReturnType<typeof sendSetup>>, req: SendTransactionWorkerRequest, code: string) => {
      const response = await handleWorkerRequest(req, setupResult.server.deps);
      expect(response).toEqual({ ok: false, code });
      expect(setupResult.server.fetched).toHaveLength(0);
      expect(combineMnemonic).not.toHaveBeenCalled();
    };

    it.each([
      ['another call', (op: Record<string, unknown>) => ({ ...op, callData: encodeSafeCalls([{ to: TO, value: '1' }]) })],
      ['a batch of the same call', (op: Record<string, unknown>) => ({ ...op, callData: encodeSafeCalls([CALL, CALL]) })],
      [
        'a delegatecall of the same call',
        (op: Record<string, unknown>) => ({
          ...op,
          callData: encodeFunctionData({ abi: DELEGATECALL, functionName: 'executeUserOpWithErrorString', args: [CALL.to, BigInt(CALL.value), CALL.data, 1] }),
        }),
      ],
      ['another sender', (op: Record<string, unknown>) => ({ ...op, sender: TO })],
      ['a factory', (op: Record<string, unknown>, owner: string) => ({ ...op, ...buildDeploymentOperation(owner, FEES), callData: op.callData, sender: op.sender })],
    ])('INTERNAL with an operation that executes %s', async (_label, change) => {
      const context = await sendSetup();
      const userOperation = change(context.userOperation as unknown as Record<string, unknown>, context.owner) as unknown as SendTransactionWorkerRequest['userOperation'];
      await expectRefused(context, context.request({ userOperation }), 'INTERNAL');
    });

    it('CALL_NOT_ALLOWED for a call from the Safe to itself with data', async () => {
      const context = await sendSetup();
      const transaction = { to: context.safe, value: '0', data: '0x0d582f13' as `0x${string}` };
      const userOperation = buildTransactionOperation(context.safe, transaction, '4', FEES);
      await expectRefused(context, context.request({ transaction, userOperation }), 'CALL_NOT_ALLOWED');
    });

    it('WALLET_NOT_DEPLOYED when the server says the Safe is not deployed on that chain', async () => {
      const context = await sendSetup();
      context.server.chain.status = { ...context.server.chain.status, deployed: false, deployable: true };
      await expectRefused(context, context.request(), 'WALLET_NOT_DEPLOYED');
    });

    it('CHAIN_MISMATCH when the request chain is not the session chain', async () => {
      const context = await sendSetup();
      await expectRefused(context, context.request({ chainId: CHAIN_ID + 1 }), 'CHAIN_MISMATCH');
    });

    it('MANIFEST_INVALID with a tampered manifest signature', async () => {
      const context = await sendSetup();
      await expectRefused(context, context.request({ signed: { ...context.signed, signature: flipBit(context.signed.signature) } }), 'MANIFEST_INVALID');
    });
  });
});
