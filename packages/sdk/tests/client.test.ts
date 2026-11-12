import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultClient, VaultError, type VaultHost, type VaultPopup } from '../src/client';
import { VAULT_PROTOCOL, VAULT_WINDOW_NAME, type UserOperationRequest, type VaultRequest } from '../src/protocol';

const ORIGIN = 'http://vault.localhost:4301';
const ADDRESS = '0x00000000000000000000000000000000000000aa';
const OWNER = '0x00000000000000000000000000000000000000bb';
const SIGNATURE = '0x1234';
const USER_OP_HASH = `0x${'aa'.repeat(32)}`;
const TRANSACTION_HASH = `0x${'bb'.repeat(32)}`;
// What the vault returns for a signed UserOperation: the operation it built for the Safe, with the same signature.
const SIGNED_USER_OPERATION = {
  sender: ADDRESS,
  nonce: '0',
  factory: null,
  factoryData: null,
  callData: '0xabcdef',
  callGasLimit: '1',
  verificationGasLimit: '1',
  preVerificationGas: '1',
  maxFeePerGas: '2',
  maxPriorityFeePerGas: '1',
  paymaster: null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit: null,
  paymasterData: null,
  signature: SIGNATURE,
};
const CHAIN = { chainId: 31001 };
const READY = { protocol: VAULT_PROTOCOL, type: 'ready' };

class FakePopup implements VaultPopup {
  closed = false;
  closeCalls = 0;
  sent: { message: VaultRequest; targetOrigin: string }[] = [];
  postMessage(message: unknown, targetOrigin: string) {
    this.sent.push({ message: message as VaultRequest, targetOrigin });
  }
  close() {
    this.closeCalls += 1;
    this.closed = true;
  }
}

function setup(options: { blocked?: boolean; getToken?: () => Promise<unknown>; timeoutMs?: number } = {}) {
  const popup = new FakePopup();
  const listeners = new Set<(event: MessageEvent) => void>();
  const open = vi.fn((_url: string, _target: string, _features: string) => (options.blocked ? null : popup));
  let tokens = 0;
  const getToken = vi.fn((options.getToken ?? (async () => `token-${++tokens}`)) as () => Promise<string>);
  const host: VaultHost = {
    open,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    setInterval: (handler, ms) => setInterval(handler, ms) as unknown as number,
    clearInterval: (id) => clearInterval(id),
  };
  const client = createVaultClient({ vaultOrigin: ORIGIN, getToken, host, timeoutMs: options.timeoutMs });
  const dispatch = (data: unknown, event: { origin?: string; source?: unknown } = {}) => {
    for (const listener of [...listeners]) {
      listener({ data, origin: event.origin ?? ORIGIN, source: event.source ?? popup } as MessageEvent);
    }
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { client, popup, open, getToken, listeners, dispatch, flush, host };
}

const result = (id: string, body: Record<string, unknown>) => ({ protocol: VAULT_PROTOCOL, type: 'result', id, ...body });

/** Checks whether a promise is still pending after the microtask queue is drained. */
async function isPending(promise: Promise<unknown>) {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise.catch(() => undefined), Promise.resolve(marker)]);
  return winner === marker;
}

describe('createVaultClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the action route with the fixed window name and no token in the URL', async () => {
    const { client, open, getToken } = setup();
    void client.activate().catch(() => undefined);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]).toEqual(expect.arrayContaining([`${ORIGIN}/activate`, VAULT_WINDOW_NAME]));
    expect(getToken).not.toHaveBeenCalled();
  });

  it('opens the popup synchronously, within the user gesture', () => {
    const { client, open } = setup();
    void client.signMessage(CHAIN, 'hello').catch(() => undefined);
    expect(open).toHaveBeenCalledWith(`${ORIGIN}/sign`, VAULT_WINDOW_NAME, expect.any(String));
  });

  it('completes a signature: ready, fresh token, request to the exact origin, and result', async () => {
    const { client, popup, dispatch, flush, listeners } = setup();
    const promise = client.signMessage(CHAIN, 'hello');
    dispatch(READY);
    await flush();

    expect(popup.sent).toHaveLength(1);
    const { message, targetOrigin } = popup.sent[0];
    expect(targetOrigin).toBe(ORIGIN);
    expect(message).toMatchObject({
      protocol: VAULT_PROTOCOL,
      type: 'request',
      token: 'token-1',
      action: { kind: 'sign', request: { kind: 'message', message: 'hello' } },
    });

    dispatch(result(message.id, { ok: true, address: ADDRESS, owner: OWNER, signature: SIGNATURE }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER, signature: SIGNATURE });
    expect(listeners.size).toBe(0);
    expect(popup.closed).toBe(false);
  });

  it('sends each kind of sign request', async () => {
    const typedData = { domain: {}, types: {}, primaryType: 'Permit', message: {} };
    for (const [call, request] of [
      [(c: ReturnType<typeof setup>['client']) => c.signTypedData(CHAIN, typedData), { kind: 'typedData', typedData }],
    ] as const) {
      const { client, popup, dispatch, flush } = setup();
      const promise = call(client);
      dispatch(READY);
      await flush();
      expect(popup.sent[0].message.action).toEqual({ kind: 'sign', chain: CHAIN, request });
      dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER, signature: SIGNATURE }));
      await promise;
    }
  });

  it('signUserOperation returns the signed operation', async () => {
    const userOperation: UserOperationRequest = { calls: [{ to: ADDRESS, value: '1' }], nonce: '0', callGasLimit: '1', verificationGasLimit: '1', preVerificationGas: '1', maxFeePerGas: '2', maxPriorityFeePerGas: '1' };
    const { client, popup, dispatch, flush } = setup();
    const promise = client.signUserOperation(CHAIN, userOperation);
    dispatch(READY);
    await flush();
    expect(popup.sent[0].message.action).toEqual({ kind: 'sign', chain: CHAIN, request: { kind: 'userOperation', userOperation } });
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER, signature: SIGNATURE, userOperation: { ...SIGNED_USER_OPERATION, extra: 'dropped' } }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER, signature: SIGNATURE, userOperation: SIGNED_USER_OPERATION });
  });

  it('getToken receives the network with its RPC, but the popup only receives the chainId', async () => {
    const { client, popup, dispatch, flush, getToken } = setup();
    const chain = { chainId: 31001, rpcUrl: 'https://rpc.example' };
    const promise = client.deploy(chain);
    dispatch(READY);
    await flush();
    expect(getToken).toHaveBeenCalledWith(chain);
    expect(popup.sent[0].message.action).toEqual({ kind: 'deploy', chain: { chainId: 31001 } });
    expect(JSON.stringify(popup.sent[0].message)).not.toContain('rpc.example');
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH });
  });

  it('deploy of an already deployed Safe carries no hashes', async () => {
    const { client, popup, dispatch, flush, open } = setup();
    const promise = client.deploy(CHAIN);
    expect(open.mock.calls[0][0]).toBe(`${ORIGIN}/deploy`);
    dispatch(READY);
    await flush();
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('relink opens its route in the vault and only returns the addresses', async () => {
    const { client, popup, dispatch, flush, open } = setup();
    const promise = client.relink();
    expect(open.mock.calls[0][0]).toBe(`${ORIGIN}/relink`);
    dispatch(READY);
    await flush();
    expect(popup.sent[0].message.action).toEqual({ kind: 'relink' });
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER, signature: SIGNATURE }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('relink propagates the vault rejection', async () => {
    const { client, popup, dispatch, flush } = setup();
    const promise = client.relink();
    dispatch(READY);
    await flush();
    dispatch(result(popup.sent[0].message.id, { ok: false, code: 'WALLET_ALREADY_EXISTS' }));
    await expect(promise).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
  });

  it('export never returns the seed, even if the vault sent it', async () => {
    const { client, popup, dispatch, flush, open } = setup();
    const promise = client.export();
    expect(open.mock.calls[0][0]).toBe(`${ORIGIN}/export`);
    dispatch(READY);
    await flush();
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER, mnemonic: 'never' }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('removes the listener when done: a previous operation does not answer the next one\'s ready', async () => {
    const { client, popup, dispatch, flush, listeners, getToken } = setup();
    const first = client.unlock();
    dispatch(READY);
    await flush();
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await first;
    expect(listeners.size).toBe(0);

    const second = client.recover();
    expect(listeners.size).toBe(1);
    dispatch(READY);
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(popup.sent).toHaveLength(2);
    expect(popup.sent[1].message.action).toEqual({ kind: 'recover' });
    dispatch(result(popup.sent[1].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await second;
  });

  it('two clients on the same window: the second cancels the first and removes its listener', async () => {
    const { client, popup, dispatch, flush, listeners, host, getToken } = setup();
    const other = createVaultClient({ vaultOrigin: ORIGIN, getToken, host });
    const first = client.unlock();
    const assertion = expect(first).rejects.toMatchObject({ code: 'SUPERSEDED' });
    const second = other.recover();
    await assertion;
    expect(listeners.size).toBe(1);
    dispatch(READY);
    await flush();
    expect(popup.sent).toHaveLength(1);
    expect(popup.sent[0].message.action).toEqual({ kind: 'recover' });
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await second;
  });

  it('resolves unlock, recover and activate with the address', async () => {
    for (const method of ['activate', 'unlock', 'recover'] as const) {
      const { client, popup, dispatch, flush, open } = setup();
      const promise = client[method]();
      expect(open.mock.calls[0][0]).toBe(`${ORIGIN}/${method}`);
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
      await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
    }
  });

  it('rejects with the code the vault returns', async () => {
    const { client, popup, dispatch, flush } = setup();
    const promise = client.signMessage(CHAIN, 'hello');
    dispatch(READY);
    await flush();
    dispatch(result(popup.sent[0].message.id, { ok: false, code: 'USER_REJECTED' }));
    await expect(promise).rejects.toMatchObject({ code: 'USER_REJECTED' });
    await expect(promise).rejects.toBeInstanceOf(VaultError);
  });

  it('ignores messages from another origin', async () => {
    const { client, popup, dispatch, flush, getToken } = setup();
    const promise = client.activate();
    dispatch(READY, { origin: 'http://evil.localhost' });
    await flush();
    expect(getToken).not.toHaveBeenCalled();
    expect(popup.sent).toHaveLength(0);

    dispatch(READY);
    await flush();
    const { id } = popup.sent[0].message;
    dispatch(result(id, { ok: true, address: '0xevil', owner: OWNER }), { origin: 'http://evil.localhost' });
    expect(await isPending(promise)).toBe(true);
    dispatch(result(id, { ok: true, address: ADDRESS, owner: OWNER }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('ignores messages from another window on the same origin', async () => {
    const { client, popup, dispatch, flush, getToken } = setup();
    const promise = client.activate();
    const other = new FakePopup();
    dispatch(READY, { source: other });
    await flush();
    expect(getToken).not.toHaveBeenCalled();

    dispatch(READY);
    await flush();
    const { id } = popup.sent[0].message;
    dispatch(result(id, { ok: true, address: '0xother', owner: OWNER }), { source: other });
    expect(await isPending(promise)).toBe(true);
    dispatch(result(id, { ok: true, address: ADDRESS, owner: OWNER }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('ignores results with another id or protocol, and malformed messages', async () => {
    const { client, popup, dispatch, flush } = setup();
    const promise = client.activate();
    dispatch(READY);
    await flush();
    const { id } = popup.sent[0].message;

    dispatch(result('other-id', { ok: true, address: '0xold', owner: OWNER }));
    dispatch({ protocol: 'other/v1', type: 'result', id, ok: true, address: '0xold', owner: OWNER });
    dispatch(null);
    dispatch('ready');
    dispatch({ protocol: VAULT_PROTOCOL, type: 'other', id, ok: true });
    expect(await isPending(promise)).toBe(true);

    dispatch(result(id, { ok: true, address: ADDRESS, owner: OWNER }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('every ready requests a fresh token, because tokens are single-use', async () => {
    const { client, popup, dispatch, flush, getToken } = setup();
    const promise = client.activate();
    dispatch(READY);
    await flush();
    dispatch(READY);
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(popup.sent.map((sent) => sent.message.token)).toEqual(['token-1', 'token-2']);
    expect(popup.sent[0].message.id).toBe(popup.sent[1].message.id);
    dispatch(result(popup.sent[1].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await promise;
  });

  it('with two consecutive readies, only the most recent is answered', async () => {
    const { client, popup, dispatch, flush } = setup();
    const promise = client.activate();
    dispatch(READY);
    dispatch(READY);
    await flush();
    expect(popup.sent).toHaveLength(1);
    expect(popup.sent[0].message.token).toBe('token-2');
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await promise;
  });

  it('POPUP_BLOCKED when window.open returns null', async () => {
    const { client, getToken } = setup({ blocked: true });
    await expect(client.activate()).rejects.toMatchObject({ code: 'POPUP_BLOCKED' });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('POPUP_CLOSED when the popup closes before finishing, and stops listening', async () => {
    const { client, popup, listeners } = setup();
    const promise = client.activate();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'POPUP_CLOSED' });
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(listeners.size).toBe(0);
  });

  it('TOKEN_UNAVAILABLE when the server provides no token, without sending anything', async () => {
    const { client, popup, dispatch } = setup({ getToken: () => Promise.reject(new Error('401')) });
    const promise = client.activate();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TOKEN_UNAVAILABLE' });
    dispatch(READY);
    await assertion;
    expect(popup.sent).toHaveLength(0);
  });

  it('a new operation replaces the pending one on the same window', async () => {
    const { client, popup, dispatch, flush } = setup();
    const first = client.activate();
    const assertion = expect(first).rejects.toMatchObject({ code: 'SUPERSEDED' });
    const second = client.unlock();
    await assertion;
    dispatch(READY);
    await flush();
    expect(popup.sent).toHaveLength(1);
    expect(popup.sent[0].message.action).toEqual({ kind: 'unlock' });
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await expect(second).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it('the error does not include the token', async () => {
    const { client, popup, dispatch, flush } = setup();
    const promise = client.activate();
    dispatch(READY);
    await flush();
    dispatch(result(popup.sent[0].message.id, { ok: false, code: 'UNAUTHORIZED' }));
    const error = await promise.catch((caught: Error) => caught);
    expect(String((error as Error).message)).not.toContain('token-1');
  });
  it('POPUP_CLOSED when the popup closes while getToken is pending, and the late token is never sent', async () => {
    let release: (token: string) => void = () => undefined;
    const { client, popup, dispatch, listeners } = setup({ getToken: () => new Promise((resolve) => (release = resolve)) });
    const promise = client.activate();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'POPUP_CLOSED' });
    dispatch(READY);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    release('late-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.sent).toHaveLength(0);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('POPUP_CLOSED when the popup closes after the request was sent, and a late result is ignored', async () => {
    const { client, popup, dispatch, flush, listeners } = setup();
    const promise = client.signMessage(CHAIN, 'hello');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'POPUP_CLOSED' });
    dispatch(READY);
    await flush();
    expect(popup.sent).toHaveLength(1);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed token for an older ready does not fail the operation when a newer ready is being answered', async () => {
    let calls = 0;
    const { client, popup, dispatch, flush } = setup({ getToken: () => (++calls === 1 ? Promise.reject(new Error('stale')) : Promise.resolve('token-2')) });
    const promise = client.activate();
    dispatch(READY);
    dispatch(READY);
    await flush();
    expect(popup.sent).toHaveLength(1);
    expect(popup.sent[0].message.token).toBe('token-2');
    dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
    await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER });
  });

  it.each([
    ['undefined', async () => undefined],
    ['an empty string', async () => ''],
    ['an object', async () => ({ token: 'x' })],
  ])('TOKEN_UNAVAILABLE when getToken resolves with %s, without sending anything', async (_name, getToken) => {
    const { client, popup, dispatch, listeners } = setup({ getToken });
    const promise = client.activate();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TOKEN_UNAVAILABLE' });
    dispatch(READY);
    await assertion;
    expect(popup.sent).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });

  it('INTERNAL when the request cannot be posted, and stops listening', async () => {
    const { client, popup, dispatch, listeners } = setup();
    popup.postMessage = () => {
      throw new Error('DataCloneError');
    };
    const promise = client.signTypedData(CHAIN, { domain: {}, types: {}, primaryType: 'Permit', message: {} });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'INTERNAL' });
    dispatch(READY);
    await assertion;
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('INTERNAL when window.open throws', async () => {
    const { client, open } = setup();
    open.mockImplementation(() => {
      throw new Error('blocked by sandbox');
    });
    await expect(client.activate()).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  describe('result validation', () => {
    type Client = ReturnType<typeof setup>['client'];
    const userOperation: UserOperationRequest = { calls: [{ to: ADDRESS, value: '1' }], nonce: '0', callGasLimit: '1', verificationGasLimit: '1', preVerificationGas: '1', maxFeePerGas: '2', maxPriorityFeePerGas: '1' };
    const typedData = { domain: {}, types: {}, primaryType: 'Permit', message: {} };
    const ACCOUNT = { ok: true, address: ADDRESS, owner: OWNER };
    const SIGNED = { ...ACCOUNT, signature: SIGNATURE };
    const SIGNED_OP = { ...SIGNED, userOperation: SIGNED_USER_OPERATION };
    const SENT = { ...ACCOUNT, chainId: CHAIN.chainId, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH };
    const sentWithout = (field: string) => {
      const { [field]: _removed, ...rest } = SENT as Record<string, unknown>;
      return rest;
    };
    const op = (changes: Record<string, unknown>) => ({ ...SIGNED_OP, userOperation: { ...SIGNED_USER_OPERATION, ...changes } });
    const withoutField = (field: string) => {
      const { [field]: _removed, ...rest } = SIGNED_USER_OPERATION as Record<string, unknown>;
      return { ...SIGNED_OP, userOperation: rest };
    };

    const actions: Record<string, (client: Client) => Promise<unknown>> = {
      activate: (c) => c.activate(),
      unlock: (c) => c.unlock(),
      recover: (c) => c.recover(),
      export: (c) => c.export(),
      relink: (c) => c.relink(),
      deploy: (c) => c.deploy(CHAIN),
      signMessage: (c) => c.signMessage(CHAIN, 'hello'),
      signTypedData: (c) => c.signTypedData(CHAIN, typedData),
      signUserOperation: (c) => c.signUserOperation(CHAIN, userOperation),
      sendTransaction: (c) => c.sendTransaction({ chain: CHAIN, to: ADDRESS, value: 1n }),
    };
    const valid: Record<string, Record<string, unknown>> = {
      activate: ACCOUNT,
      unlock: ACCOUNT,
      recover: ACCOUNT,
      export: ACCOUNT,
      relink: ACCOUNT,
      deploy: { ...ACCOUNT, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH },
      signMessage: SIGNED,
      signTypedData: SIGNED,
      signUserOperation: SIGNED_OP,
      sendTransaction: SENT,
    };

    // Shapes that are malformed for every action.
    const common: [string, Record<string, unknown>][] = [
      ['ok: true without addresses', { ok: true }],
      ['an address that is not 20 bytes', { ...ACCOUNT, address: '0x1234' }],
      ['an address that is not hex', { ...ACCOUNT, address: `0x${'zz'.repeat(20)}` }],
      ['an address without 0x', { ...ACCOUNT, address: '00'.repeat(20) }],
      ['an owner that is not 20 bytes', { ...ACCOUNT, owner: `${OWNER}00` }],
      ['a missing owner', { ok: true, address: ADDRESS }],
      ['an address that is not a string', { ...ACCOUNT, address: 1 }],
      ['ok: false without a code', { ok: false }],
      ['ok: false with an empty code', { ok: false, code: '' }],
      ['ok: false with a code that is not a string', { ok: false, code: 42 }],
      ['no ok', { address: ADDRESS, owner: OWNER }],
      ['ok that is not a boolean', { ok: 'true', address: ADDRESS, owner: OWNER }],
    ];
    const specific: [string, string, Record<string, unknown>][] = [
      ['deploy', 'a userOpHash that is not 32 bytes', { ...ACCOUNT, userOpHash: '0xaa', transactionHash: TRANSACTION_HASH }],
      ['deploy', 'a transactionHash that is not hex', { ...ACCOUNT, userOpHash: USER_OP_HASH, transactionHash: `0x${'zz'.repeat(32)}` }],
      ['deploy', 'a userOpHash without a transactionHash', { ...ACCOUNT, userOpHash: USER_OP_HASH }],
      ['deploy', 'a transactionHash without a userOpHash', { ...ACCOUNT, transactionHash: TRANSACTION_HASH }],
      ['deploy', 'a null hash', { ...ACCOUNT, userOpHash: null, transactionHash: null }],
      ['signMessage', 'no signature', ACCOUNT],
      ['signMessage', 'an empty signature', { ...ACCOUNT, signature: '0x' }],
      ['signMessage', 'a signature of odd length', { ...ACCOUNT, signature: '0x123' }],
      ['signMessage', 'a signature that is not hex', { ...ACCOUNT, signature: '0xzz' }],
      ['signMessage', 'a signature that is not a string', { ...ACCOUNT, signature: 1234 }],
      ['signTypedData', 'no signature', ACCOUNT],
      ['signTypedData', 'a signature without 0x', { ...ACCOUNT, signature: '1234' }],
      ['signUserOperation', 'no signature', { ...ACCOUNT, userOperation: SIGNED_USER_OPERATION }],
      ['signUserOperation', 'no userOperation', SIGNED],
      ['signUserOperation', 'a userOperation that is not an object', { ...SIGNED, userOperation: 'op' }],
      ['signUserOperation', 'a userOperation without callData', withoutField('callData')],
      ['signUserOperation', 'a userOperation without paymaster', withoutField('paymaster')],
      ['signUserOperation', 'a userOperation for another sender', op({ sender: `0x${'cc'.repeat(20)}` })],
      ['signUserOperation', 'a userOperation with another signature', op({ signature: '0x5678' })],
      ['signUserOperation', 'a hex quantity', op({ nonce: '0x1' })],
      ['signUserOperation', 'a quantity with leading zeros', op({ callGasLimit: '01' })],
      ['signUserOperation', 'a numeric quantity', op({ maxFeePerGas: 2 })],
      ['signUserOperation', 'a factory that is not an address', op({ factory: '0x1234' })],
      ['signUserOperation', 'callData that is not hex', op({ callData: 'abcdef' })],
      ['signUserOperation', 'paymasterData that is not hex', op({ paymasterData: '0xz' })],
      ['sendTransaction', 'no userOpHash', sentWithout('userOpHash')],
      ['sendTransaction', 'no transactionHash', sentWithout('transactionHash')],
      ['sendTransaction', 'a userOpHash that is not 32 bytes', { ...SENT, userOpHash: '0xaa' }],
      ['sendTransaction', 'a transactionHash that is 31 bytes', { ...SENT, transactionHash: `0x${'bb'.repeat(31)}` }],
      ['sendTransaction', 'a transactionHash that is not hex', { ...SENT, transactionHash: `0x${'zz'.repeat(32)}` }],
      ['sendTransaction', 'a null hash', { ...SENT, userOpHash: null }],
      ['sendTransaction', 'no chainId', sentWithout('chainId')],
      ['sendTransaction', 'another chainId', { ...SENT, chainId: CHAIN.chainId + 1 }],
      ['sendTransaction', 'a chainId that is a string', { ...SENT, chainId: String(CHAIN.chainId) }],
    ];
    const cases: [string, string, Record<string, unknown>][] = [
      ...Object.keys(actions).flatMap((action) => common.map(([name, body]) => [action, name, body] as [string, string, Record<string, unknown>])),
      ...specific,
    ];

    it.each(cases)('%s: %s rejects with PROTOCOL_ERROR at once and stops listening', async (action, _name, body) => {
      const { client, popup, dispatch, flush, listeners } = setup({ timeoutMs: 60_000 });
      const promise = actions[action](client);
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, body));
      await expect(promise).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      await expect(promise).rejects.toBeInstanceOf(VaultError);
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(popup.closeCalls).toBe(0);
    });

    it.each(Object.keys(actions))('%s: a well-formed result still resolves and clears every timer', async (action) => {
      const { client, popup, dispatch, flush, listeners } = setup({ timeoutMs: 60_000 });
      const promise = actions[action](client);
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, valid[action]));
      const { ok: _ok, ...expected } = valid[action];
      await expect(promise).resolves.toEqual(expected);
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts a userOperation with a factory and a paymaster, and a checksummed address', async () => {
      const checksummed = '0xAbCdEf0000000000000000000000000000000000';
      const full = {
        ...SIGNED_USER_OPERATION,
        sender: checksummed.toLowerCase(),
        factory: `0x${'dd'.repeat(20)}`,
        factoryData: '0x01',
        paymaster: `0x${'ee'.repeat(20)}`,
        paymasterVerificationGasLimit: '100',
        paymasterPostOpGasLimit: '0',
        paymasterData: '0x',
      };
      const { client, popup, dispatch, flush } = setup();
      const promise = client.signUserOperation(CHAIN, userOperation);
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, { ok: true, address: checksummed, owner: OWNER, signature: SIGNATURE, userOperation: full }));
      await expect(promise).resolves.toEqual({ address: checksummed, owner: OWNER, signature: SIGNATURE, userOperation: full });
    });
  });

  describe('timeoutMs', () => {
    it('rejects with TIMEOUT, closes the popup and stops listening', async () => {
      const { client, popup, listeners } = setup({ timeoutMs: 5_000 });
      const promise = client.activate();
      const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await isPending(promise)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(popup.closeCalls).toBe(1);
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('counts from opening the popup, also while getToken is pending, and never sends the late token', async () => {
      let release: (token: string) => void = () => undefined;
      const { client, popup, dispatch } = setup({ timeoutMs: 1_000, getToken: () => new Promise((resolve) => (release = resolve)) });
      const promise = client.signMessage(CHAIN, 'hello');
      const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      dispatch(READY);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      release('late-token');
      await vi.advanceTimersByTimeAsync(0);
      expect(popup.sent).toHaveLength(0);
    });

    it('a popup without close() still times out', async () => {
      const { client, popup } = setup({ timeoutMs: 1_000 });
      (popup as { close?: () => void }).close = undefined;
      const promise = client.activate();
      const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    });

    it('a result before the deadline cancels it', async () => {
      const { client, popup, dispatch, flush } = setup({ timeoutMs: 1_000 });
      const promise = client.activate();
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
      await promise;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(popup.closeCalls).toBe(0);
    });

    it('a superseded operation does not close the popup the next one uses', async () => {
      const { client, popup, dispatch, flush } = setup({ timeoutMs: 1_000 });
      const first = client.activate();
      const assertion = expect(first).rejects.toMatchObject({ code: 'SUPERSEDED' });
      await vi.advanceTimersByTimeAsync(600);
      const second = client.unlock();
      await assertion;
      await vi.advanceTimersByTimeAsync(600);
      expect(popup.closeCalls).toBe(0);
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
      await expect(second).resolves.toEqual({ address: ADDRESS, owner: OWNER });
    });

    it('without timeoutMs, an operation waits for as long as the popup is open', async () => {
      const { client, popup } = setup();
      const promise = client.activate();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(await isPending(promise)).toBe(true);
      expect(popup.closeCalls).toBe(0);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '1000'])('rejects timeoutMs %s when the client is created', (timeoutMs) => {
      const host = setup().host;
      expect(() => createVaultClient({ vaultOrigin: ORIGIN, getToken: async () => 't', host, timeoutMs: timeoutMs as number })).toThrow(RangeError);
    });
  });

  describe('sendTransaction', () => {
    const TO = `0x${'cc'.repeat(20)}` as const;
    const SENT = { ok: true, address: ADDRESS, owner: OWNER, chainId: CHAIN.chainId, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH };
    type Request = Parameters<ReturnType<typeof setup>['client']['sendTransaction']>[0];

    async function posted(request: Request) {
      const context = setup();
      const promise = context.client.sendTransaction(request);
      context.dispatch(READY);
      await context.flush();
      return { ...context, promise, message: context.popup.sent[0].message };
    }

    it('opens /transaction and posts the call with only the chainId', async () => {
      const chain = { chainId: CHAIN.chainId, rpcUrl: 'https://rpc.example' };
      const { open, getToken, message, promise, dispatch } = await posted({ chain, to: TO, value: 5n, data: '0xa9059cbb' });
      expect(open).toHaveBeenCalledWith(`${ORIGIN}/transaction`, VAULT_WINDOW_NAME, expect.any(String));
      expect(getToken).toHaveBeenCalledWith(chain);
      expect(message.action).toEqual({ kind: 'transaction', chain: { chainId: CHAIN.chainId }, transaction: { to: TO, value: '5', data: '0xa9059cbb' } });
      expect(JSON.stringify(message)).not.toContain('rpc.example');
      dispatch(result(message.id, SENT));
      await expect(promise).resolves.toEqual({ address: ADDRESS, owner: OWNER, chainId: CHAIN.chainId, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH });
    });

    it.each([
      ['a bigint value', { value: 10n ** 18n }, { value: '1000000000000000000' }],
      ['a decimal string value', { value: '42' }, { value: '42' }],
      ['no value', {}, { value: '0' }],
      ['a zero bigint', { value: 0n }, { value: '0' }],
      ['the maximum uint256', { value: (1n << 256n) - 1n }, { value: ((1n << 256n) - 1n).toString() }],
      ['empty data, which is dropped', { data: '0x' }, { value: '0' }],
      ['uppercase hex data', { data: '0xABCDEF' }, { value: '0', data: '0xABCDEF' }],
    ] as [string, Partial<Request>, Record<string, string>][])('normalizes %s', async (_label, input, expected) => {
      const { message } = await posted({ chain: CHAIN, to: TO, ...input });
      expect((message.action as { transaction: unknown }).transaction).toEqual({ to: TO, ...expected });
    });

    it.each([
      ['a short to', { to: '0x1234' }],
      ['a to without 0x', { to: 'cc'.repeat(20) }],
      ['a missing to', { to: undefined }],
      ['a negative bigint value', { value: -1n }],
      ['a negative string value', { value: '-1' }],
      ['a hex value', { value: '0x10' }],
      ['a float value', { value: '1.5' }],
      ['a number value', { value: 1 }],
      ['a value with leading zeros', { value: '01' }],
      ['a bigint value above 2^256-1', { value: 1n << 256n }],
      ['a string value above 2^256-1', { value: (1n << 256n).toString() }],
      ['odd-length data', { data: '0x123' }],
      ['data that is not hex', { data: '0xzz' }],
      ['data without 0x', { data: 'abcd' }],
      ['no chain', { chain: undefined }],
      ['a chainId of 0', { chain: { chainId: 0 } }],
      ['a fractional chainId', { chain: { chainId: 1.5 } }],
      ['a string chainId', { chain: { chainId: '1' } }],
    ] as [string, Record<string, unknown>][])('INVALID_REQUEST without opening the popup for %s', async (_label, changes) => {
      const { client, open, getToken, listeners } = setup();
      const request = { chain: CHAIN, to: TO, value: 1n, ...changes } as unknown as Request;
      const promise = client.sendTransaction(request);
      expect(open).not.toHaveBeenCalled();
      await expect(promise).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(promise).rejects.toBeInstanceOf(VaultError);
      expect(getToken).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    });

    it('INVALID_REQUEST for a request that is not an object', async () => {
      const { client, open } = setup();
      await expect(client.sendTransaction(null as unknown as Request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(open).not.toHaveBeenCalled();
    });

    it('a malformed request does not supersede the pending operation', async () => {
      const { client, popup, dispatch, flush } = setup();
      const pending = client.activate();
      await expect(client.sendTransaction({ chain: CHAIN, to: '0x12' as `0x${string}` })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      dispatch(READY);
      await flush();
      dispatch(result(popup.sent[0].message.id, { ok: true, address: ADDRESS, owner: OWNER }));
      await expect(pending).resolves.toEqual({ address: ADDRESS, owner: OWNER });
    });

    it('drops fields the action does not define', async () => {
      const { message, promise, dispatch } = await posted({ chain: CHAIN, to: TO });
      dispatch(result(message.id, { ...SENT, signature: SIGNATURE, userOperation: SIGNED_USER_OPERATION, mnemonic: 'never' }));
      const resolved = await promise;
      expect(resolved).toEqual({ address: ADDRESS, owner: OWNER, chainId: CHAIN.chainId, userOpHash: USER_OP_HASH, transactionHash: TRANSACTION_HASH });
      expect(Object.keys(resolved).sort()).toEqual(['address', 'chainId', 'owner', 'transactionHash', 'userOpHash']);
    });

    it.each(['TRANSACTION_REVERTED', 'USER_REJECTED', 'WALLET_NOT_DEPLOYED', 'CALL_NOT_ALLOWED'])('propagates %s from the vault', async (code) => {
      const { message, promise, dispatch, listeners } = await posted({ chain: CHAIN, to: TO, value: '1' });
      dispatch(result(message.id, { ok: false, code }));
      await expect(promise).rejects.toMatchObject({ code });
      await expect(promise).rejects.toBeInstanceOf(VaultError);
      expect(listeners.size).toBe(0);
    });
  });
});
