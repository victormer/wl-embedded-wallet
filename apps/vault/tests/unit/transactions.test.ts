import type { UserOperationJson, VaultCall } from '@wl-embedded-wallet/core/operations';
import { encodeSafeCalls, signSafeOperation, smartAccountFor, toRpcUserOperation, userOperationHash } from '@wl-embedded-wallet/core/safe';
import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as postAaRpc } from '../../app/api/aa/rpc/route';
import { prepareTransaction as clientPrepareTransaction, upstreamErrorCode } from '../../lib/aa-client';
import type { ChainStatus } from '@wl-embedded-wallet/core/types';
import { sponsorshipLimits } from '../../server/limits';
import { fromRpcUserOperation, TRANSACTION_TTL_MS } from '../../server/transactions';
import { getPreparedTransaction, setSessionChain } from '../../server/store';
import { startFakeRpc, type FakeRpc } from './fake-rpc';
import { RpcFailure, startFakeUpstream, type FakeUpstream } from './fake-upstream';
import { activeWallet, expectRateLimited, openSession, req, useRouteEnv } from './route-harness';

const CHAIN = 31002;
const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;
const PAYMASTER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const PAYMASTER_DATA = `0x${'ab'.repeat(65)}`;
const NONCE = 7n;
const hex = (value: bigint) => `0x${value.toString(16)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;

// abstractionkit encodes a single call as `executeUserOpWithErrorString`; both take the operation (0 CALL, 1 DELEGATECALL) last.
const SAFE_4337_ABI = parseAbi([
  'function executeUserOp(address to, uint256 value, bytes data, uint8 operation)',
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
]);
const EXECUTE = 'executeUserOpWithErrorString';
const ENTRY_POINT_ABI = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256 nonce)']);

const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const account = smartAccountFor(owner.address);
const otherKey = generatePrivateKey();
const other = privateKeyToAccount(otherKey);
const otherAccount = smartAccountFor(other.address);

const signer = (key: `0x${string}`) => {
  const signing = privateKeyToAccount(key);
  return { address: signing.address, signHash: (hash: `0x${string}`) => signing.sign({ hash }) };
};
const sign = async (operation: UserOperationJson, key: `0x${string}` = ownerKey): Promise<UserOperationJson> => ({
  ...operation,
  signature: await signSafeOperation(operation, CHAIN, account, signer(key)),
});

const TRANSFER: VaultCall = { to: RECIPIENT, value: '1000', data: '0xa9059cbb' };

useRouteEnv();

describe('POST /api/aa/rpc: transactions from a deployed Safe', () => {
  let node: FakeRpc;
  let bundler: FakeUpstream;
  let paymaster: FakeUpstream;
  let cookie: string;
  // What the fakes answer; each test changes what it needs.
  let network: { gasPrice: bigint; priority: bigint; balance: bigint };
  let estimate: Record<string, unknown>;
  let stub: () => unknown;
  let final: () => unknown;
  let send: (params: unknown[]) => unknown;

  const rpc = (method: string, params: unknown[] = [], session = cookie) => postAaRpc(req('/api/aa/rpc', { cookie: session, body: { method, params } }));
  const prepareRaw = (call: unknown = TRANSFER, session = cookie) => rpc('vault_prepareTransaction', [call], session);
  const prepare = async (call: unknown = TRANSFER, session = cookie) => {
    const response = await prepareRaw(call, session);
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: UserOperationJson }).result;
  };
  const sendRaw = (operation: Record<string, unknown>, session = cookie) => rpc('eth_sendUserOperation', [operation, account.entryPoint], session);
  const sendOp = (operation: UserOperationJson, session = cookie) => sendRaw(toRpcUserOperation(operation), session);
  const forwarded = () => bundler.of('eth_sendUserOperation');
  // Calls that carry an operation: the gas price quote and receipts do not count.
  const upstreamUserOps = () => paymaster.calls.length + bundler.calls.filter((call) => ['eth_estimateUserOperationGas', 'eth_sendUserOperation'].includes(call.method)).length;
  const chains = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url, paymasterContext: { sponsorshipPolicyId: 'server' }, sponsorTransactions: true, ...extra } });
  const record = (operation: UserOperationJson) => getPreparedTransaction(CHAIN, account.address, userOperationHash(operation, CHAIN, account).toLowerCase());

  beforeEach(async () => {
    network = { gasPrice: 10n * GWEI, priority: GWEI, balance: ETHER };
    estimate = { callGasLimit: hex(50_000n), verificationGasLimit: hex(100_000n), preVerificationGas: hex(60_000n) };
    stub = () => ({ paymaster: PAYMASTER, paymasterData: `0x${'00'.repeat(65)}`, paymasterVerificationGasLimit: hex(60_000n), paymasterPostOpGasLimit: hex(1n) });
    final = () => ({ paymaster: PAYMASTER, paymasterData: PAYMASTER_DATA });
    // The real hash, as a bundler would compute it: it does not cover the signature.
    send = (params) => userOperationHash({ ...fromRpcUserOperation(params[0] as Record<string, unknown>)!, signature: '0x' }, CHAIN, account);
    node = await startFakeRpc(CHAIN, {
      eth_gasPrice: () => hex(network.gasPrice),
      eth_maxPriorityFeePerGas: () => hex(network.priority),
      eth_getBalance: () => hex(network.balance),
      eth_call: (params) => {
        const { to } = params[0] as { to: string };
        return to.toLowerCase() === account.entryPoint.toLowerCase() ? word(NONCE) : '0x';
      },
    });
    // Deployed: every address has code by default.
    node.state.defaultCode = '0x60';
    bundler = await startFakeUpstream({
      eth_estimateUserOperationGas: () => estimate,
      eth_sendUserOperation: (params) => send(params),
      eth_getUserOperationReceipt: (params) => ({ userOpHash: params[0], success: true, receipt: { transactionHash: `0x${'cd'.repeat(32)}` } }),
    });
    paymaster = await startFakeUpstream({ pm_getPaymasterStubData: () => stub(), pm_getPaymasterData: () => final() });
    process.env.RPC_ALLOWED_HOSTS = '127.0.0.1';
    process.env.AA_CHAINS = chains();
    cookie = await openSession('alice');
    await activeWallet(cookie, 'alice', owner.address);
    await setSessionChain(cookie, { chainId: CHAIN, rpcUrl: node.url });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([node.close(), bundler.close(), paymaster.close()]);
    for (const variable of ['AA_CHAINS', 'RPC_ALLOWED_HOSTS', 'RATE_LIMITS', 'AA_MAX_CALL_GAS_LIMIT', 'AA_MAX_FEE_PER_GAS']) delete process.env[variable];
  });

  describe('vault_prepareTransaction, sponsored', () => {
    it('builds the operation from the EntryPoint nonce, the network fees, the bundler estimate and the paymaster, and records it', async () => {
      const operation = await prepare();
      expect(operation).toEqual({
        sender: account.address,
        nonce: NONCE.toString(),
        factory: null,
        factoryData: null,
        callData: encodeSafeCalls([TRANSFER], account),
        // gasPrice * 200% + tip, the tip with its 20 % margin: as for the deployment.
        maxFeePerGas: ((212n * GWEI) / 10n).toString(),
        maxPriorityFeePerGas: ((12n * GWEI) / 10n).toString(),
        // The estimate plus 20 %.
        callGasLimit: '60000',
        verificationGasLimit: '120000',
        preVerificationGas: '72000',
        // Gas from the stub, address and data from the final response.
        paymaster: PAYMASTER,
        paymasterData: PAYMASTER_DATA,
        paymasterVerificationGasLimit: '60000',
        paymasterPostOpGasLimit: '1',
        signature: '0x',
      });
      // The nonce is the EntryPoint's, key 0, for this Safe.
      const nonceCall = node.calls.find((call) => call.method === 'eth_call')!;
      const { to, data } = nonceCall.params[0] as { to: string; data: `0x${string}` };
      expect(to.toLowerCase()).toBe(account.entryPoint.toLowerCase());
      expect(decodeFunctionData({ abi: ENTRY_POINT_ABI, data })).toEqual({ functionName: 'getNonce', args: [account.address, 0n] });
      // The policy is the server's, and the final data is requested for the estimated gas.
      expect(paymaster.calls.map((call) => call.method)).toEqual(['pm_getPaymasterStubData', 'pm_getPaymasterData']);
      expect(paymaster.calls.map((call) => call.params[3])).toEqual([{ sponsorshipPolicyId: 'server' }, { sponsorshipPolicyId: 'server' }]);
      expect(paymaster.of('pm_getPaymasterData')[0]![0]).toMatchObject({ callGasLimit: hex(60_000n), verificationGasLimit: hex(120_000n), nonce: hex(NONCE) });
      expect(bundler.of('eth_estimateUserOperationGas')[0]![0]).toMatchObject({ sender: account.address, nonce: hex(NONCE), paymaster: PAYMASTER });
      expect(await record(operation)).toMatchObject({ status: 'prepared', userId: 'alice', sponsored: true, userOpHash: null });
    });

    it('the builder only ever produces a CALL (operation 0), never a delegatecall', async () => {
      for (const call of [TRANSFER, { to: RECIPIENT, value: '0' }, { to: account.address, value: '5' }]) {
        const { callData } = await prepare(call);
        const decoded = decodeFunctionData({ abi: SAFE_4337_ABI, data: callData as `0x${string}` });
        expect(decoded.functionName).toBe(EXECUTE);
        expect(decoded.args[3]).toBe(0);
        expect(decoded.args[0].toLowerCase()).toBe(call.to.toLowerCase());
        expect(decoded.args[1]).toBe(BigInt(call.value));
      }
    });

    it('the bundler\'s paymaster gas estimate gets the margin too', async () => {
      estimate = { ...estimate, paymasterVerificationGasLimit: hex(70_000n), paymasterPostOpGasLimit: hex(10n) };
      expect(await prepare()).toMatchObject({ paymasterVerificationGasLimit: '84000', paymasterPostOpGasLimit: '12' });
    });

    it('preparing the same call twice gives the same operation, still to be signed', async () => {
      const first = await prepare();
      expect(await prepare()).toEqual(first);
      expect((await sendOp(await sign(first))).status).toBe(200);
      // Already sent: the same operation is not handed out again.
      const again = await prepareRaw();
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'TRANSACTION_IN_PROGRESS' });
    });
  });

  describe('caps', () => {
    it('an estimate above a cap is refused, and the margin is clamped to the cap', async () => {
      process.env.AA_MAX_CALL_GAS_LIMIT = '55000';
      expect(await prepare()).toMatchObject({ callGasLimit: '55000' });
      estimate = { ...estimate, callGasLimit: hex(55_001n) };
      const response = await prepareRaw();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
    });

    it.each([
      ['callGasLimit', 'maxCallGasLimit'],
      ['verificationGasLimit', 'maxVerificationGasLimit'],
      ['preVerificationGas', 'maxPreVerificationGas'],
      ['paymasterVerificationGasLimit', 'maxPaymasterVerificationGasLimit'],
      ['paymasterPostOpGasLimit', 'maxPaymasterPostOpGasLimit'],
    ] as const)('an estimated %s above its cap is refused before asking for the final paymaster data', async (field, cap) => {
      estimate = { ...estimate, [field]: hex(sponsorshipLimits(CHAIN)[cap] + 1n) };
      const response = await prepareRaw();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
      expect(paymaster.of('pm_getPaymasterData')).toHaveLength(0);
    });

    it('fees above the cap are refused before any operation goes upstream', async () => {
      process.env.AA_MAX_FEE_PER_GAS = (5n * GWEI).toString();
      network.gasPrice = 6n * GWEI;
      const response = await prepareRaw();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'FEES_TOO_HIGH' });
      network = { ...network, gasPrice: GWEI, priority: 6n * GWEI };
      expect(await (await prepareRaw()).json()).toEqual({ error: 'FEES_TOO_HIGH' });
      expect(upstreamUserOps()).toBe(0);
    });

    it('paymaster gas above the caps is refused, from the stub or the final data', async () => {
      stub = () => ({ paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: hex(10_000_000n), paymasterPostOpGasLimit: hex(1n) });
      expect(await (await prepareRaw()).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
      expect(bundler.of('eth_estimateUserOperationGas')).toHaveLength(0);
      stub = () => ({ paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: hex(1n), paymasterPostOpGasLimit: hex(1n) });
      final = () => ({ paymaster: PAYMASTER, paymasterData: PAYMASTER_DATA, paymasterPostOpGasLimit: hex(10_000_000n) });
      expect(await (await prepareRaw()).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
    });

    it('a paymaster that gives no gas limits at all is refused', async () => {
      stub = final = () => ({ paymaster: PAYMASTER, paymasterData: '0x' });
      const response = await prepareRaw();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'UPSTREAM_INVALID' });
    });

    it('the per-chain limits override applies', async () => {
      process.env.AA_CHAINS = chains({ limits: { maxCallGasLimit: '55000', maxFeePerGas: (20n * GWEI).toString() } });
      expect(await prepare()).toMatchObject({ callGasLimit: '55000', maxFeePerGas: (20n * GWEI).toString() });
      estimate = { ...estimate, callGasLimit: hex(55_001n) };
      expect(await (await prepareRaw()).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
      // And the env variable does not loosen it.
      process.env.AA_MAX_CALL_GAS_LIMIT = '1000000';
      expect(await (await prepareRaw()).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
    });
  });

  describe('what is refused before building', () => {
    it('a Safe that is not deployed gets NOT_DEPLOYED, without asking the paymaster or the bundler', async () => {
      node.state.code[account.address.toLowerCase()] = '0x';
      const response = await prepareRaw();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'NOT_DEPLOYED' });
      expect(paymaster.calls).toHaveLength(0);
      expect(bundler.calls).toHaveLength(0);
    });

    it('a call to the Safe itself with data is CALL_NOT_ALLOWED; without data it is allowed', async () => {
      for (const to of [account.address, account.address.toLowerCase()]) {
        const response = await prepareRaw({ to, value: '0', data: '0x0d582f13' });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'CALL_NOT_ALLOWED' });
      }
      expect(upstreamUserOps()).toBe(0);
      expect(node.calls.some((call) => call.method === 'eth_getCode')).toBe(false);
      expect(await prepare({ to: account.address, value: '1' })).toMatchObject({ callData: encodeSafeCalls([{ to: account.address, value: '1' }], account) });
      expect((await prepareRaw({ to: account.address, value: '0', data: '0x' })).status).toBe(200);
    });

    it('a value above the balance is INSUFFICIENT_FUNDS before any paymaster call, even when sponsored', async () => {
      network.balance = 999n;
      const response = await prepareRaw();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'INSUFFICIENT_FUNDS' });
      expect(upstreamUserOps()).toBe(0);
      // Sponsored, the gas is not the Safe's: the value alone is enough.
      network.balance = 1000n;
      expect(await prepare()).toMatchObject({ paymaster: PAYMASTER });
    });

    const invalid: [string, unknown[]][] = [
      ['no parameters', []],
      ['two calls', [TRANSFER, TRANSFER]],
      ['a call that is not an object', ['0xdeadbeef']],
      ['a missing to', [{ value: '0' }]],
      ['a to that is not an address', [{ to: '0x1234', value: '0' }]],
      ['a to with a bad checksum', [{ to: '0x70997970c51812dc3A010C7d01b50e0d17dc79C8', value: '0' }]],
      ['a missing value', [{ to: RECIPIENT }]],
      ['a value as a number', [{ to: RECIPIENT, value: 1 }]],
      ['a hex value', [{ to: RECIPIENT, value: '0x10' }]],
      ['a negative value', [{ to: RECIPIENT, value: '-1' }]],
      ['a fractional value', [{ to: RECIPIENT, value: '1.5' }]],
      ['a value above uint256', [{ to: RECIPIENT, value: (1n << 256n).toString() }]],
      ['data that is not hex', [{ to: RECIPIENT, value: '0', data: '0xzz' }]],
      ['data of odd length', [{ to: RECIPIENT, value: '0', data: '0xabc' }]],
      ['data without 0x', [{ to: RECIPIENT, value: '0', data: 'abcd' }]],
      ['an extra key', [{ to: RECIPIENT, value: '0', gas: '1' }]],
      ['an operation instead of a call', [{ to: RECIPIENT, value: '0', operation: 1 }]],
    ];
    it.each(invalid)('INVALID_BODY for %s, without going upstream', async (_name, params) => {
      const response = await rpc('vault_prepareTransaction', params);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_BODY' });
      expect(node.calls).toHaveLength(0);
      expect(upstreamUserOps()).toBe(0);
    });
  });

  describe('unsponsored', () => {
    const unsponsored: [string, () => Record<string, unknown>][] = [
      ['a paymaster without sponsorTransactions', () => ({ [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url } })],
      ['sponsorTransactions false', () => ({ [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url, sponsorTransactions: false } })],
      ['no paymaster', () => ({ [CHAIN]: { bundlerUrl: bundler.url } })],
    ];

    it.each(unsponsored)('with %s the operation has no paymaster fields and the paymaster is never asked', async (_name, config) => {
      process.env.AA_CHAINS = JSON.stringify(config());
      const operation = await prepare();
      expect(operation).toMatchObject({ paymaster: null, paymasterData: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, callGasLimit: '60000', nonce: NONCE.toString() });
      expect(paymaster.calls).toHaveLength(0);
      expect(bundler.of('eth_estimateUserOperationGas')[0]![0]).not.toHaveProperty('paymaster');
      expect(await record(operation)).toMatchObject({ sponsored: false });
      const sent = await sendOp(await sign(operation));
      expect(sent.status).toBe(200);
      expect(forwarded()[0]![0]).not.toHaveProperty('paymaster');
    });

    it('the balance must cover the value plus the prefund', async () => {
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url } });
      // (60000 + 120000 + 72000) gas at 21.2 gwei, plus the 1000 wei of the call.
      const prefund = 252_000n * ((212n * GWEI) / 10n);
      network.balance = prefund + 999n;
      const response = await prepareRaw();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'INSUFFICIENT_FUNDS' });
      expect(paymaster.calls).toHaveLength(0);
      network.balance = prefund + 1000n;
      expect((await prepareRaw()).status).toBe(200);
    });

    it('a balance below the value alone is refused before estimating', async () => {
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url } });
      network.balance = 0n;
      expect(await (await prepareRaw()).json()).toEqual({ error: 'INSUFFICIENT_FUNDS' });
      expect(upstreamUserOps()).toBe(0);
    });
  });

  describe('eth_sendUserOperation', () => {
    it('forwards exactly the prepared operation with the owner\'s signature, once, and returns the bundler\'s hash', async () => {
      const operation = await sign(await prepare());
      const response = await sendOp(operation);
      expect(response.status).toBe(200);
      const { result } = (await response.json()) as { result: string };
      expect(result).toBe(userOperationHash(operation, CHAIN, account));
      expect(forwarded()).toEqual([[toRpcUserOperation(operation), account.entryPoint]]);
      expect(await record(operation)).toMatchObject({ status: 'sent', userOpHash: result });
    });

    it('accepts the same operation in decimal or hex quantities and any address case', async () => {
      const operation = await sign(await prepare());
      const mixed = { ...toRpcUserOperation(operation), sender: operation.sender.toLowerCase(), callData: operation.callData.toUpperCase().replace('0X', '0x'), nonce: operation.nonce, paymaster: PAYMASTER.toUpperCase().replace('0X', '0x') };
      expect((await sendRaw(mixed)).status).toBe(200);
      expect(forwarded()).toEqual([[toRpcUserOperation(operation), account.entryPoint]]);
    });

    // Each one is signed by the owner after the change: only the comparison with the prepared operation stops it.
    const mutations: [string, (operation: UserOperationJson) => UserOperationJson][] = [
      ['sender', (op) => ({ ...op, sender: otherAccount.address })],
      ['nonce', (op) => ({ ...op, nonce: (BigInt(op.nonce) + 1n).toString() })],
      ['callData', (op) => ({ ...op, callData: encodeSafeCalls([{ ...TRANSFER, value: '1000000' }], account) })],
      ['callGasLimit', (op) => ({ ...op, callGasLimit: (BigInt(op.callGasLimit) + 1n).toString() })],
      ['verificationGasLimit', (op) => ({ ...op, verificationGasLimit: (BigInt(op.verificationGasLimit) * 2n).toString() })],
      ['preVerificationGas', (op) => ({ ...op, preVerificationGas: (BigInt(op.preVerificationGas) + 1n).toString() })],
      ['maxFeePerGas', (op) => ({ ...op, maxFeePerGas: (BigInt(op.maxFeePerGas) * 10n).toString() })],
      ['maxPriorityFeePerGas', (op) => ({ ...op, maxPriorityFeePerGas: (BigInt(op.maxPriorityFeePerGas) + 1n).toString() })],
      ['paymaster', (op) => ({ ...op, paymaster: OTHER })],
      ['paymasterVerificationGasLimit', (op) => ({ ...op, paymasterVerificationGasLimit: (BigInt(op.paymasterVerificationGasLimit!) + 1n).toString() })],
      ['paymasterPostOpGasLimit', (op) => ({ ...op, paymasterPostOpGasLimit: (BigInt(op.paymasterPostOpGasLimit!) + 1n).toString() })],
      ['paymasterData', (op) => ({ ...op, paymasterData: '0x1234' })],
      ['factory and factoryData added', (op) => ({ ...op, factory: account.factory, factoryData: '0x1234' })],
      ['paymaster fields removed', (op) => ({ ...op, paymaster: null, paymasterData: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null })],
      ['the call turned into a delegatecall', (op) => ({ ...op, callData: encodeFunctionData({ abi: SAFE_4337_ABI, functionName: EXECUTE, args: [TRANSFER.to, BigInt(TRANSFER.value), TRANSFER.data!, 1] }) })],
      ['the call sent through executeUserOp with delegatecall', (op) => ({ ...op, callData: encodeFunctionData({ abi: SAFE_4337_ABI, functionName: 'executeUserOp', args: [TRANSFER.to, BigInt(TRANSFER.value), TRANSFER.data!, 1] }) })],
      ['the call sent through executeUserOp with CALL', (op) => ({ ...op, callData: encodeFunctionData({ abi: SAFE_4337_ABI, functionName: 'executeUserOp', args: [TRANSFER.to, BigInt(TRANSFER.value), TRANSFER.data!, 0] }) })],
      ['the call turned into a multisend batch', (op) => ({ ...op, callData: encodeSafeCalls([TRANSFER, { to: OTHER, value: '1' }], account) })],
    ];

    it.each(mutations)('a changed %s is refused and nothing is forwarded', async (_field, mutate) => {
      const prepared = await prepare();
      const response = await sendOp(await sign(mutate(prepared)));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(forwarded()).toHaveLength(0);
      expect(await record(prepared)).toMatchObject({ status: 'prepared' });
      // The prepared operation itself still goes through.
      expect((await sendOp(await sign(prepared))).status).toBe(200);
    });

    it('the same call with operation 1 (delegatecall) differs from the prepared one in that byte only, and is refused', async () => {
      const prepared = await prepare();
      const encode = (operation: number) => encodeFunctionData({ abi: SAFE_4337_ABI, functionName: EXECUTE, args: [TRANSFER.to, BigInt(TRANSFER.value), TRANSFER.data!, operation] });
      expect(encode(0)).toBe(prepared.callData);
      expect(await (await sendOp(await sign({ ...prepared, callData: encode(1) }))).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(forwarded()).toHaveLength(0);
    });

    it('fields toRpcUserOperation would drop are compared too: factoryData without factory, a paymaster without its data', async () => {
      const signed = toRpcUserOperation(await sign(await prepare()));
      const { paymasterData: _, ...withoutPaymasterData } = signed;
      const { paymasterVerificationGasLimit: _v, ...withoutPaymasterGas } = signed;
      const { paymaster: _p, ...withoutPaymaster } = signed;
      for (const candidate of [
        { ...signed, factoryData: '0x1234' },
        { ...signed, factory: null, factoryData: '0x1234' },
        withoutPaymasterData,
        { ...signed, paymasterData: null },
        withoutPaymasterGas,
        { ...signed, paymasterPostOpGasLimit: null },
        withoutPaymaster,
      ]) {
        const response = await sendRaw(candidate);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      }
      expect(forwarded()).toHaveLength(0);
      // Explicit nulls for the fields it does not have are fine.
      expect((await sendRaw({ ...signed, factory: null, factoryData: null })).status).toBe(200);
    });

    it('an unknown extra key is refused', async () => {
      const operation = toRpcUserOperation(await sign(await prepare()));
      expect(await (await sendRaw({ ...operation, eip7702Auth: { address: OTHER } })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(forwarded()).toHaveLength(0);
    });

    it('a signature by another key, empty or of the wrong length is refused', async () => {
      const prepared = await prepare();
      for (const operation of [await sign(prepared, otherKey), { ...prepared, signature: '0x' }, { ...prepared, signature: `0x${'00'.repeat(77)}` }]) {
        const response = await sendOp(operation);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      }
      const signed = await sign(prepared);
      expect(await (await sendOp({ ...signed, signature: `${signed.signature}00` })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(await (await sendOp({ ...signed, signature: signed.signature.slice(0, -2) })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      const { signature: _, ...unsigned } = toRpcUserOperation(signed);
      expect(await (await sendRaw(unsigned)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(forwarded()).toHaveLength(0);
      expect((await sendOp(signed)).status).toBe(200);
    });

    it('a well-formed operation that was never prepared is refused', async () => {
      const prepared = await prepare();
      const never = await sign({ ...prepared, callData: encodeSafeCalls([{ to: OTHER, value: '1' }], account) });
      expect(await (await sendOp(never)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      // Nor one prepared for another Safe, sent from this session.
      const bob = await openSession('bob');
      await activeWallet(bob, 'bob', other.address);
      await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
      expect(await (await sendOp(await sign(prepared), bob)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(forwarded()).toHaveLength(0);
    });

    it('malformed fields are refused before any lookup', async () => {
      const operation = toRpcUserOperation(await sign(await prepare()));
      for (const broken of [{ ...operation, nonce: '-1' }, { ...operation, callData: '0xzz' }, { ...operation, sender: 'alice' }, { ...operation, paymaster: 'x' }]) {
        expect(await (await sendRaw(broken)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      }
      expect(forwarded()).toHaveLength(0);
    });

    it('sending the same signed operation again returns the same hash without forwarding it again', async () => {
      const operation = await sign(await prepare());
      const first = (await (await sendOp(operation)).json()) as { result: string };
      const again = await sendOp(operation);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      expect(forwarded()).toHaveLength(1);
      // Even after the preparation would have expired.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TRANSACTION_TTL_MS + 60_000);
      expect(await (await sendOp(operation)).json()).toEqual(first);
      expect(forwarded()).toHaveLength(1);
    });

    it('concurrent sends of the same operation forward it exactly once', async () => {
      const slow = send;
      send = async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return slow(params);
      };
      const operation = await sign(await prepare());
      const responses = await Promise.all(Array.from({ length: 4 }, () => sendOp(operation)));
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(forwarded()).toHaveLength(1);
      const hash = userOperationHash(operation, CHAIN, account);
      expect(bodies.filter((body) => body.result === hash).length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) expect([JSON.stringify({ result: hash }), JSON.stringify({ error: 'TRANSACTION_IN_PROGRESS' })]).toContain(JSON.stringify(body));
    });

    it('a bundler error releases the claim so the same signed operation can be sent again', async () => {
      const working = send;
      send = () => {
        throw new RpcFailure('AA25 invalid account nonce, see http://secret.example/key');
      };
      const operation = await sign(await prepare());
      const failed = await sendOp(operation);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: 'UPSTREAM_ERROR', rpcMessage: 'AA25 invalid account nonce, see [url]' });
      expect(await record(operation)).toMatchObject({ status: 'prepared' });
      send = () => 'not a hash';
      expect(await (await sendOp(operation)).json()).toEqual({ error: 'UPSTREAM_INVALID' });
      expect(await record(operation)).toMatchObject({ status: 'prepared' });
      send = working;
      expect((await sendOp(operation)).status).toBe(200);
      expect(forwarded()).toHaveLength(3);
    });

    it('an operation prepared more than TRANSACTION_TTL_MS ago is TRANSACTION_EXPIRED, and it can be prepared again', async () => {
      const operation = await sign(await prepare());
      const preparedAt = (await record(operation))!.preparedAt;
      vi.spyOn(Date, 'now').mockReturnValue(preparedAt + TRANSACTION_TTL_MS);
      const expired = await sendOp(operation);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toEqual({ error: 'TRANSACTION_EXPIRED' });
      expect(forwarded()).toHaveLength(0);
      // Same nonce, fees and gas: the same operation, recorded afresh.
      expect(await prepare()).toEqual({ ...operation, signature: '0x' });
      expect((await sendOp(operation)).status).toBe(200);
    });

    it('just before the TTL it still goes through', async () => {
      const operation = await sign(await prepare());
      const preparedAt = (await record(operation))!.preparedAt;
      vi.spyOn(Date, 'now').mockReturnValue(preparedAt + TRANSACTION_TTL_MS - 1000);
      expect((await sendOp(operation)).status).toBe(200);
    });
  });

  describe('eth_getUserOperationReceipt', () => {
    const receipt = (hash: string, session = cookie) => rpc('eth_getUserOperationReceipt', [hash], session);

    it('only for a transaction this Safe sent on this chain', async () => {
      const operation = await sign(await prepare());
      const hash = userOperationHash(operation, CHAIN, account);
      // Prepared but not sent.
      const early = await receipt(hash);
      expect(early.status).toBe(403);
      expect(await early.json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect((await sendOp(operation)).status).toBe(200);
      expect(await (await receipt(`0x${'ee'.repeat(32)}`)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      const ok = await receipt(hash.toUpperCase().replace('0X', '0x'));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ result: { success: true } });
      expect(bundler.of('eth_getUserOperationReceipt')).toEqual([[hash.toUpperCase().replace('0X', '0x')]]);

      // Another user, with their own Safe, cannot ask for it.
      const bob = await openSession('bob');
      await activeWallet(bob, 'bob', other.address);
      await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
      expect(await (await receipt(hash, bob)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      // Nor this Safe on another chain.
      await setSessionChain(cookie, { chainId: CHAIN + 1, rpcUrl: node.url });
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN + 1]: { bundlerUrl: bundler.url } });
      expect(await (await receipt(hash)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(bundler.of('eth_getUserOperationReceipt')).toHaveLength(1);
    });
  });

  describe('rate limits', () => {
    it('vault_prepareTransaction has its own per-user budget, and the other methods do not spend it', async () => {
      process.env.RATE_LIMITS = JSON.stringify({ transaction: { sub: 2, ip: 1000 } });
      // Neither receipts, nor sends, nor malformed requests count.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await rpc('eth_getUserOperationReceipt', [`0x${'ee'.repeat(32)}`])).status).toBe(403);
        expect((await rpc('vault_prepareTransaction', [{ to: RECIPIENT }])).status).toBe(400);
      }
      const operation = await prepare();
      expect((await sendOp(await sign(operation))).status).toBe(200);
      expect((await sendOp(await sign(operation))).status).toBe(200);
      expect((await prepareRaw({ to: RECIPIENT, value: '1' })).status).toBe(200);
      const before = upstreamUserOps();
      await expectRateLimited(await prepareRaw({ to: RECIPIENT, value: '2' }));
      expect(upstreamUserOps()).toBe(before);
      // The other methods still work.
      expect((await rpc('eth_getUserOperationReceipt', [userOperationHash(operation, CHAIN, account)])).status).toBe(200);
      // Per user: another one still has its budget.
      const bob = await openSession('bob');
      await activeWallet(bob, 'bob', other.address);
      await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
      expect((await prepareRaw(TRANSFER, bob)).status).toBe(200);
    });

    it('and a per-IP budget across users', async () => {
      process.env.RATE_LIMITS = JSON.stringify({ transaction: { ip: 2, sub: 1000 } });
      const bob = await openSession('bob');
      await activeWallet(bob, 'bob', other.address);
      await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
      expect((await prepareRaw()).status).toBe(200);
      expect((await prepareRaw(TRANSFER, bob)).status).toBe(200);
      await expectRateLimited(await prepareRaw({ to: RECIPIENT, value: '1' }, bob));
      await expectRateLimited(await prepareRaw({ to: RECIPIENT, value: '1' }));
      // vault_prepareDeployment is not counted against it.
      expect((await rpc('vault_prepareDeployment')).status).not.toBe(429);
    });
  });

  describe('upstream errors', () => {
    it('a bundler estimate error is UPSTREAM_ERROR with the message sanitized, and nothing is recorded', async () => {
      const failing = await startFakeUpstream({
        eth_estimateUserOperationGas: () => {
          throw new RpcFailure('AA23 reverted: execution reverted, see https://secret.example/key?apikey=1');
        },
      });
      try {
        process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: failing.url, paymasterUrl: paymaster.url, sponsorTransactions: true } });
        const response = await prepareRaw();
        expect(response.status).toBe(502);
        const body = (await response.json()) as { error: string; rpcMessage: string };
        expect(body.error).toBe('UPSTREAM_ERROR');
        expect(body.rpcMessage).toContain('AA23 reverted');
        expect(body.rpcMessage).not.toContain('secret.example');
        expect(upstreamErrorCode(body.rpcMessage, 'transaction')).toBe('TRANSACTION_FAILED');
      } finally {
        await failing.close();
      }
    });

    it('a paymaster policy rejection is passed on, for the client to map', async () => {
      stub = () => {
        throw new RpcFailure('sponsorship policy sp_x is not active');
      };
      const response = await prepareRaw();
      expect(response.status).toBe(502);
      const body = (await response.json()) as { rpcMessage: string };
      expect(body).toEqual({ error: 'UPSTREAM_ERROR', rpcMessage: 'sponsorship policy sp_x is not active' });
      expect(upstreamErrorCode(body.rpcMessage, 'transaction')).toBe('SPONSORSHIP_REJECTED');
    });

    it('a node that fails is CHAIN_UNAVAILABLE', async () => {
      const broken = await startFakeRpc(CHAIN, { eth_gasPrice: () => '12 gwei', eth_maxPriorityFeePerGas: () => '0x1', eth_getBalance: () => hex(ETHER), eth_call: () => word(0n) });
      try {
        await setSessionChain(cookie, { chainId: CHAIN, rpcUrl: broken.url });
        expect(await (await prepareRaw()).json()).toEqual({ error: 'CHAIN_UNAVAILABLE' });
        expect(upstreamUserOps()).toBe(0);
      } finally {
        await broken.close();
      }
    });

    it('an RPC for another network is CHAIN_MISMATCH, before anything else', async () => {
      node.state.chainId = CHAIN + 1;
      expect(await (await prepareRaw()).json()).toEqual({ error: 'CHAIN_MISMATCH' });
      expect(node.calls.map((call) => call.method)).toEqual(['eth_chainId']);
    });
  });
});

describe('upstreamErrorCode', () => {
  it.each([
    ["AA21 didn't pay prefund", 'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS'],
    ['UserOperation reverted during simulation with reason: AA21 didn\'t pay prefund', 'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS'],
    ['AA25 invalid account nonce', 'NONCE_CONFLICT', 'NONCE_CONFLICT'],
    ['Invalid nonce for this account', 'NONCE_CONFLICT', 'NONCE_CONFLICT'],
    ['AA33 reverted', 'SPONSORSHIP_REJECTED', 'SPONSORSHIP_REJECTED'],
    ['AA31 paymaster deposit too low', 'SPONSORSHIP_REJECTED', 'SPONSORSHIP_REJECTED'],
    ['sponsorship policy sp_x is not active', 'SPONSORSHIP_REJECTED', 'SPONSORSHIP_REJECTED'],
    ['Paymaster rejected the operation', 'SPONSORSHIP_REJECTED', 'SPONSORSHIP_REJECTED'],
    ['AA23 reverted', 'TRANSACTION_FAILED', 'DEPLOY_FAILED'],
    ['AA10 sender already constructed', 'TRANSACTION_FAILED', 'DEPLOY_FAILED'],
    ['execution reverted', 'CALL_REVERTED', 'DEPLOY_FAILED'],
    ['UserOperation execution reverted: 0x08c379a0', 'CALL_REVERTED', 'DEPLOY_FAILED'],
    ['something else entirely', 'TRANSACTION_FAILED', 'DEPLOY_FAILED'],
  ] as const)('%s → %s (transaction), %s (deployment)', (message, transaction, deploy) => {
    expect(upstreamErrorCode(message, 'transaction')).toBe(transaction);
    expect(upstreamErrorCode(message, 'deploy')).toBe(deploy);
  });
});

describe('aa-client prepareTransaction', () => {
  const sponsored = { transactionsSponsored: true } as ChainStatus;
  const unsponsored = { transactionsSponsored: false } as ChainStatus;
  const operation = (extra: Partial<UserOperationJson> = {}): UserOperationJson => ({
    sender: account.address,
    nonce: '0',
    factory: null,
    factoryData: null,
    callData: '0x',
    callGasLimit: '1',
    verificationGasLimit: '1',
    preVerificationGas: '1',
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '1',
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: '1',
    paymasterPostOpGasLimit: '1',
    paymasterData: '0x',
    signature: '0x',
    ...extra,
  });
  let answer: { status: number; body: unknown };
  const requests: { url: string; body: unknown }[] = [];

  beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const code = (status: ChainStatus = sponsored) => clientPrepareTransaction(TRANSFER, status).then(() => null, (error: { code?: string }) => error.code ?? String(error));

  it('asks the vault proxy for the call, and accepts an operation matching the network status', async () => {
    answer = { status: 200, body: { result: operation() } };
    expect(await clientPrepareTransaction(TRANSFER, sponsored)).toEqual(operation());
    expect(requests).toEqual([{ url: '/api/aa/rpc', body: { method: 'vault_prepareTransaction', params: [TRANSFER] } }]);
    answer = { status: 200, body: { result: operation({ paymaster: null, paymasterData: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null }) } };
    expect(await code(unsponsored)).toBeNull();
  });

  it('refuses an operation that does not match: sponsorship differs from the status, a factory, no fees', async () => {
    answer = { status: 200, body: { result: operation() } };
    expect(await code(unsponsored)).toBe('TRANSACTION_FAILED');
    answer = { status: 200, body: { result: operation({ paymaster: null }) } };
    expect(await code(sponsored)).toBe('TRANSACTION_FAILED');
    answer = { status: 200, body: { result: operation({ factory: account.factory }) } };
    expect(await code()).toBe('TRANSACTION_FAILED');
    answer = { status: 200, body: { result: { ...operation(), maxFeePerGas: 1 } } };
    expect(await code()).toBe('TRANSACTION_FAILED');
    answer = { status: 200, body: { result: null } };
    expect(await code()).toBe('TRANSACTION_FAILED');
  });

  it.each([
    [409, { error: 'NOT_DEPLOYED' }, 'WALLET_NOT_DEPLOYED'],
    [409, { error: 'INSUFFICIENT_FUNDS' }, 'INSUFFICIENT_FUNDS'],
    [403, { error: 'CALL_NOT_ALLOWED' }, 'CALL_NOT_ALLOWED'],
    [409, { error: 'TRANSACTION_EXPIRED' }, 'TRANSACTION_EXPIRED'],
    [409, { error: 'GAS_LIMIT_EXCEEDED' }, 'GAS_LIMIT_EXCEEDED'],
    [409, { error: 'CHAIN_MISMATCH' }, 'CHAIN_MISMATCH'],
    [502, { error: 'UPSTREAM_ERROR', rpcMessage: "AA21 didn't pay prefund" }, 'INSUFFICIENT_FUNDS'],
    [502, { error: 'UPSTREAM_ERROR', rpcMessage: 'execution reverted' }, 'CALL_REVERTED'],
    [502, { error: 'UPSTREAM_ERROR', rpcMessage: 'sponsorship policy sp_x is not active' }, 'SPONSORSHIP_REJECTED'],
    [502, { error: 'UPSTREAM_INVALID' }, 'TRANSACTION_FAILED'],
    [403, { error: 'OPERATION_NOT_ALLOWED' }, 'TRANSACTION_FAILED'],
    [401, { error: 'UNAUTHORIZED' }, 'UNAUTHORIZED'],
  ] as const)('a %i %j from the vault is %s', async (status, body, expected) => {
    answer = { status, body };
    expect(await code()).toBe(expected);
  });
});
