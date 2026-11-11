import type { UserOperationJson } from '@wl-embedded-wallet/core/operations';
import { buildDeploymentOperation, deploymentFactory, encodeSafeCalls, signSafeOperation, smartAccountFor, toRpcUserOperation, userOperationHash } from '@wl-embedded-wallet/core/safe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as postAaRpc } from '../../app/api/aa/rpc/route';
import { GET as getAaStatus } from '../../app/api/aa/status/route';
import { sponsorshipLimits } from '../../server/limits';
import { deploymentFees, gasWithMargin } from '../../server/sponsorship';
import { getSponsoredDeployment, setSessionChain } from '../../server/store';
import { startFakeRpc, type FakeRpc } from './fake-rpc';
import { RpcFailure, startFakeUpstream, type FakeUpstream } from './fake-upstream';
import { activeWallet, openSession, req, useRouteEnv } from './route-harness';

const CHAIN = 31001;
const GWEI = 1_000_000_000n;
const PAYMASTER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PAYMASTER_DATA = `0x${'ab'.repeat(65)}`;
const hex = (value: bigint) => `0x${value.toString(16)}`;
const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const account = smartAccountFor(owner.address);
const otherKey = generatePrivateKey();
const other = privateKeyToAccount(otherKey);

const signer = (key: `0x${string}`) => {
  const signing = privateKeyToAccount(key);
  return { address: signing.address, signHash: (hash: `0x${string}`) => signing.sign({ hash }) };
};
const sign = async (operation: UserOperationJson, key: `0x${string}` = ownerKey): Promise<UserOperationJson> => ({
  ...operation,
  signature: await signSafeOperation(operation, CHAIN, account, signer(key)),
});

useRouteEnv();

describe('POST /api/aa/rpc: server-built deployment', () => {
  let node: FakeRpc;
  let bundler: FakeUpstream;
  let paymaster: FakeUpstream;
  let cookie: string;
  // What the fakes answer; each test changes what it needs.
  let network: { gasPrice: bigint | string; priority: bigint | string };
  let estimate: Record<string, unknown>;
  let stub: () => unknown;
  let final: () => unknown;
  let send: (params: unknown[]) => unknown;

  const rpc = (method: string, params: unknown[] = [], session = cookie) => postAaRpc(req('/api/aa/rpc', { cookie: session, body: { method, params } }));
  const prepare = async (session = cookie) => {
    const response = await rpc('vault_prepareDeployment', [], session);
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: UserOperationJson }).result;
  };
  const sendRaw = (operation: Record<string, unknown>, entryPoint: string = account.entryPoint, session = cookie) => rpc('eth_sendUserOperation', [operation, entryPoint], session);
  const sendOp = (operation: UserOperationJson, entryPoint: string = account.entryPoint, session = cookie) => sendRaw(toRpcUserOperation(operation), entryPoint, session);
  // The gas price quote is not about any operation: only the calls that carry one count.
  const upstreamUserOps = () => paymaster.calls.length + bundler.calls.filter((call) => !['eth_getUserOperationReceipt', 'pimlico_getUserOperationGasPrice'].includes(call.method)).length;
  const chains = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url, paymasterContext: { sponsorshipPolicyId: 'server' }, ...extra } });

  const bundlerHandlers = (): Record<string, (params: unknown[]) => unknown> => ({
    eth_estimateUserOperationGas: () => estimate,
    eth_sendUserOperation: (params) => send(params),
    eth_getUserOperationReceipt: (params) => ({ userOpHash: params[0], success: true, receipt: { transactionHash: `0x${'cd'.repeat(32)}` } }),
  });

  beforeEach(async () => {
    network = { gasPrice: 10n * GWEI, priority: GWEI };
    estimate = { callGasLimit: hex(50_000n), verificationGasLimit: hex(400_000n), preVerificationGas: hex(60_000n) };
    stub = () => ({ paymaster: PAYMASTER, paymasterData: `0x${'00'.repeat(65)}`, paymasterVerificationGasLimit: hex(60_000n), paymasterPostOpGasLimit: hex(1n) });
    final = () => ({ paymaster: PAYMASTER, paymasterData: PAYMASTER_DATA });
    send = (params) => userOperationHash(
      // The real hash, as a bundler would compute it: it does not cover the signature.
      { ...(fromRpc(params[0] as Record<string, string>)), signature: '0x' },
      CHAIN,
      account,
    );
    const quantityOf = (value: bigint | string) => (typeof value === 'string' ? value : hex(value));
    node = await startFakeRpc(CHAIN, { eth_gasPrice: () => quantityOf(network.gasPrice), eth_maxPriorityFeePerGas: () => quantityOf(network.priority) });
    node.state.code[account.address.toLowerCase()] = '0x';
    node.state.callResult = addressWord(account.address);
    bundler = await startFakeUpstream(bundlerHandlers());
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
    for (const variable of ['AA_CHAINS', 'RPC_ALLOWED_HOSTS', 'RATE_LIMITS', 'AA_MAX_CALL_GAS_LIMIT', 'AA_MAX_FEE_PER_GAS', 'AA_DEPLOYMENT_RETRY_SECONDS']) delete process.env[variable];
  });

  describe('vault_prepareDeployment', () => {
    it('builds the deployment from the network fees, the bundler estimate and the paymaster, and records it', async () => {
      const operation = await prepare();
      expect(operation).toMatchObject({
        sender: account.address,
        nonce: '0',
        ...deploymentFactory(owner.address, account),
        callData: encodeSafeCalls([{ to: account.address, value: '0', data: '0x' }], account),
        // gasPrice * 200% + tip, the tip with its 20 % margin. This bundler has no gas price quote.
        maxFeePerGas: ((212n * GWEI) / 10n).toString(),
        maxPriorityFeePerGas: ((12n * GWEI) / 10n).toString(),
        // The estimate plus 20%.
        callGasLimit: '60000',
        verificationGasLimit: '480000',
        preVerificationGas: '72000',
        // Gas from the stub, address and data from the final response.
        paymaster: PAYMASTER,
        paymasterData: PAYMASTER_DATA,
        paymasterVerificationGasLimit: '60000',
        paymasterPostOpGasLimit: '1',
        signature: '0x',
      });
      // The policy is the server's, and the final data is requested for the estimated gas.
      expect(paymaster.calls.map((call) => call.params[3])).toEqual([{ sponsorshipPolicyId: 'server' }, { sponsorshipPolicyId: 'server' }]);
      expect(paymaster.of('pm_getPaymasterData')[0]![0]).toMatchObject({ callGasLimit: hex(60_000n), verificationGasLimit: hex(480_000n) });
      const record = await getSponsoredDeployment(CHAIN, account.address);
      expect(record).toMatchObject({ status: 'prepared', userId: 'alice', operationHash: userOperationHash(operation, CHAIN, account) });
      expect(JSON.parse(record!.operation)).toEqual(operation);
    });

    it('the bundler\'s paymaster gas estimate gets the margin too', async () => {
      estimate = { ...estimate, paymasterVerificationGasLimit: hex(70_000n), paymasterPostOpGasLimit: hex(10n) };
      expect(await prepare()).toMatchObject({ paymasterVerificationGasLimit: '84000', paymasterPostOpGasLimit: '12' });
    });

    it('the fee formula follows the network values, and the cap clamps it', async () => {
      network = { gasPrice: 3n * GWEI, priority: 2n * GWEI };
      expect(await prepare()).toMatchObject({ maxFeePerGas: ((84n * GWEI) / 10n).toString(), maxPriorityFeePerGas: ((24n * GWEI) / 10n).toString() });
      process.env.AA_MAX_FEE_PER_GAS = (5n * GWEI).toString();
      expect(await prepare()).toMatchObject({ maxFeePerGas: (5n * GWEI).toString(), maxPriorityFeePerGas: ((24n * GWEI) / 10n).toString() });
      process.env.AA_CHAINS = chains({ limits: { feeMultiplierPercent: '100', priorityFeeMultiplierPercent: '100' } });
      delete process.env.AA_MAX_FEE_PER_GAS;
      expect(await prepare()).toMatchObject({ maxFeePerGas: (5n * GWEI).toString(), maxPriorityFeePerGas: (2n * GWEI).toString() });
    });

    it("uses the bundler's pimlico_getUserOperationGasPrice quote as a floor, and falls back to the node without it", async () => {
      network = { gasPrice: 68n, priority: 50n };
      let quote: unknown = { slow: { maxFeePerGas: hex(1_000_000n), maxPriorityFeePerGas: hex(900_000n) }, standard: { maxFeePerGas: hex(1_500_000n), maxPriorityFeePerGas: hex(1_100_000n) }, fast: { maxFeePerGas: hex(2_000_000n), maxPriorityFeePerGas: hex(1_500_000n) } };
      const quoting = await startFakeUpstream({ ...bundlerHandlers(), pimlico_getUserOperationGasPrice: () => quote });
      try {
        process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: quoting.url, paymasterUrl: paymaster.url } });
        expect(await prepare()).toMatchObject({ maxFeePerGas: '1800000', maxPriorityFeePerGas: '1320000' });
        expect(quoting.of('pimlico_getUserOperationGasPrice')).toEqual([[]]);
        // A malformed quote is ignored: the node's fees, with their margins.
        quote = { standard: { maxFeePerGas: 'lots', maxPriorityFeePerGas: hex(1n) } };
        expect(await prepare()).toMatchObject({ maxFeePerGas: '196', maxPriorityFeePerGas: '60' });
        // A quote above the cap stops the deployment before any operation reaches the paymaster.
        quote = { standard: { maxFeePerGas: hex(600n * GWEI), maxPriorityFeePerGas: hex(GWEI) } };
        const before = paymaster.calls.length;
        expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'FEES_TOO_HIGH' });
        expect(paymaster.calls.length).toBe(before);
      } finally {
        await quoting.close();
      }
    });

    it('a network priced above the cap is refused, before asking the paymaster', async () => {
      process.env.AA_MAX_FEE_PER_GAS = (5n * GWEI).toString();
      network = { gasPrice: 6n * GWEI, priority: GWEI };
      const response = await rpc('vault_prepareDeployment');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'FEES_TOO_HIGH' });
      network = { gasPrice: GWEI, priority: 6n * GWEI };
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'FEES_TOO_HIGH' });
      expect(upstreamUserOps()).toBe(0);
      expect(await getSponsoredDeployment(CHAIN, account.address)).toBeNull();
    });

    it('the margin is clamped to the cap, and an estimate above the cap is refused', async () => {
      process.env.AA_MAX_CALL_GAS_LIMIT = '55000';
      expect(await prepare()).toMatchObject({ callGasLimit: '55000' });
      estimate = { ...estimate, callGasLimit: hex(55_001n) };
      const response = await rpc('vault_prepareDeployment');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
    });

    it.each([
      ['verificationGasLimit', 'maxVerificationGasLimit'],
      ['preVerificationGas', 'maxPreVerificationGas'],
      ['paymasterVerificationGasLimit', 'maxPaymasterVerificationGasLimit'],
      ['paymasterPostOpGasLimit', 'maxPaymasterPostOpGasLimit'],
    ] as const)('an estimated %s above its cap is refused', async (field, cap) => {
      estimate = { ...estimate, [field]: hex(sponsorshipLimits(CHAIN)[cap] + 1n) };
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
      expect(paymaster.of('pm_getPaymasterData')).toHaveLength(0);
    });

    it('paymaster gas above the caps is refused, from the stub or the final data', async () => {
      stub = () => ({ paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: hex(10_000_000n), paymasterPostOpGasLimit: hex(1n) });
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
      stub = () => ({ paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: hex(1n), paymasterPostOpGasLimit: hex(1n) });
      final = () => ({ paymaster: PAYMASTER, paymasterData: PAYMASTER_DATA, paymasterPostOpGasLimit: hex(10_000_000n) });
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'GAS_LIMIT_EXCEEDED' });
      expect(await getSponsoredDeployment(CHAIN, account.address)).toBeNull();
    });

    const badPaymasterResponses: [string, () => unknown, 'stub' | 'final' | 'stub-and-final'][] = [
      ['a non-object stub', () => '0xdead', 'stub'],
      ['a paymaster that is not an address', () => ({ paymaster: 'paymaster.example', paymasterData: '0x' }), 'stub'],
      ['missing paymasterData', () => ({ paymaster: PAYMASTER }), 'final'],
      ['paymasterData that is not hex', () => ({ paymaster: PAYMASTER, paymasterData: '0xzz' }), 'final'],
      ['paymasterData of odd length', () => ({ paymaster: PAYMASTER, paymasterData: '0xabc' }), 'final'],
      ['oversized paymasterData', () => ({ paymaster: PAYMASTER, paymasterData: `0x${'ab'.repeat(5000)}` }), 'final'],
      ['a gas limit that is not a hex quantity', () => ({ paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: '-1' }), 'final'],
      ['no paymaster gas limits at all', () => ({ paymaster: PAYMASTER, paymasterData: '0x' }), 'stub-and-final'],
    ];
    it.each(badPaymasterResponses)('a paymaster response with a bad shape is refused: %s', async (_name, response, which) => {
      if (which === 'stub') stub = response;
      else if (which === 'final') final = response;
      else stub = final = response;
      const result = await rpc('vault_prepareDeployment');
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({ error: 'UPSTREAM_INVALID' });
      expect(await getSponsoredDeployment(CHAIN, account.address)).toBeNull();
    });

    it('a bundler estimate with a bad shape is refused', async () => {
      estimate = { callGasLimit: 50_000, verificationGasLimit: hex(1n), preVerificationGas: hex(1n) };
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'UPSTREAM_INVALID' });
      estimate = { verificationGasLimit: hex(1n), preVerificationGas: hex(1n) };
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'UPSTREAM_INVALID' });
    });

    it('an upstream error is passed on sanitized, and a node fee that is not a quantity is CHAIN_UNAVAILABLE', async () => {
      stub = () => {
        throw new RpcFailure('AA21 didn\'t pay prefund, see http://secret.example/key');
      };
      const response = await rpc('vault_prepareDeployment');
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'UPSTREAM_ERROR', rpcMessage: 'AA21 didn\'t pay prefund, see [url]' });
      network.gasPrice = '12 gwei';
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'CHAIN_UNAVAILABLE' });
    });

    it('takes no parameters, and an already deployed Safe gets nothing from the paymaster', async () => {
      expect((await rpc('vault_prepareDeployment', [{ callGasLimit: '0x1' }])).status).toBe(400);
      node.state.code[account.address.toLowerCase()] = '0x60';
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'ALREADY_DEPLOYED' });
      expect(upstreamUserOps()).toBe(0);
    });

    it('without a paymaster the same server-built path applies, within the same caps', async () => {
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url } });
      const operation = await prepare();
      expect(operation).toMatchObject({ paymaster: null, paymasterData: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, callGasLimit: '60000', maxFeePerGas: ((212n * GWEI) / 10n).toString() });
      expect(paymaster.calls).toHaveLength(0);
      const sent = await sendOp(await sign(operation));
      expect(sent.status).toBe(200);
      expect(bundler.of('eth_sendUserOperation')[0]![0]).not.toHaveProperty('paymaster');
      process.env.AA_MAX_CALL_GAS_LIMIT = '1000';
      // Already sent: a new one is not prepared, whatever the caps.
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'ALREADY_SPONSORED' });
    });
  });

  it.each(['pm_getPaymasterStubData', 'pm_getPaymasterData', 'eth_estimateUserOperationGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'pm_sponsorUserOperation'])(
    'the browser can no longer reach %s',
    async (method) => {
      const operation = toRpcUserOperation(await prepare());
      const before = { node: node.calls.length, upstream: upstreamUserOps() };
      const response = await rpc(method, method.startsWith('pm_') ? [operation, account.entryPoint, hex(BigInt(CHAIN)), {}] : method === 'eth_estimateUserOperationGas' ? [operation, account.entryPoint] : []);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
      expect({ node: node.calls.length, upstream: upstreamUserOps() }).toEqual(before);
    },
  );

  describe('eth_sendUserOperation', () => {
    it('forwards exactly the prepared operation with the owner\'s signature, and records the bundler\'s hash', async () => {
      const operation = await sign(await prepare());
      const response = await sendOp(operation);
      expect(response.status).toBe(200);
      const { result } = (await response.json()) as { result: string };
      expect(result).toBe(userOperationHash(operation, CHAIN, account));
      expect(bundler.of('eth_sendUserOperation')).toEqual([[toRpcUserOperation(operation), account.entryPoint]]);
      expect(await getSponsoredDeployment(CHAIN, account.address)).toMatchObject({ status: 'sent', userOpHash: result });
    });

    it('accepts the same operation in decimal or hex quantities and any address case', async () => {
      const operation = await sign(await prepare());
      const mixed = { ...toRpcUserOperation(operation), sender: operation.sender.toLowerCase(), callData: operation.callData.toUpperCase().replace('0X', '0x'), callGasLimit: operation.callGasLimit, nonce: '0' };
      expect((await sendRaw(mixed)).status).toBe(200);
    });

    // Each one is signed by the owner after the change: only the comparison with the prepared operation stops it.
    const mutations: [string, (operation: UserOperationJson) => UserOperationJson][] = [
      ['sender', (op) => ({ ...op, sender: smartAccountFor(other.address).address })],
      ['nonce', (op) => ({ ...op, nonce: '1' })],
      ['factory', (op) => ({ ...op, factory: OTHER })],
      ['factoryData', (op) => ({ ...op, factoryData: deploymentFactory(other.address).factoryData })],
      ['callData', (op) => ({ ...op, callData: encodeSafeCalls([{ to: OTHER, value: '1', data: '0x' }], account) })],
      ['callGasLimit', (op) => ({ ...op, callGasLimit: (BigInt(op.callGasLimit) + 1n).toString() })],
      ['verificationGasLimit', (op) => ({ ...op, verificationGasLimit: (BigInt(op.verificationGasLimit) * 2n).toString() })],
      ['preVerificationGas', (op) => ({ ...op, preVerificationGas: (BigInt(op.preVerificationGas) + 1n).toString() })],
      ['maxFeePerGas', (op) => ({ ...op, maxFeePerGas: (BigInt(op.maxFeePerGas) * 10n).toString() })],
      ['maxPriorityFeePerGas', (op) => ({ ...op, maxPriorityFeePerGas: (BigInt(op.maxPriorityFeePerGas) + 1n).toString() })],
      ['paymaster', (op) => ({ ...op, paymaster: OTHER })],
      ['paymasterData', (op) => ({ ...op, paymasterData: '0x1234' })],
      ['paymasterVerificationGasLimit', (op) => ({ ...op, paymasterVerificationGasLimit: (BigInt(op.paymasterVerificationGasLimit!) + 1n).toString() })],
      ['paymasterPostOpGasLimit', (op) => ({ ...op, paymasterPostOpGasLimit: (BigInt(op.paymasterPostOpGasLimit!) + 1n).toString() })],
    ];

    it.each(mutations)('a changed %s is refused and nothing is forwarded', async (_field, mutate) => {
      const prepared = await prepare();
      const response = await sendOp(await sign(mutate(prepared)));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
      expect(await getSponsoredDeployment(CHAIN, account.address)).toMatchObject({ status: 'prepared' });
      // The prepared operation itself still goes through.
      expect((await sendOp(await sign(prepared))).status).toBe(200);
    });

    it('a field the prepared operation does not have is refused', async () => {
      const operation = toRpcUserOperation(await sign(await prepare()));
      expect(await (await sendRaw({ ...operation, eip7702Auth: { address: OTHER } })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url } });
      const unsponsored = toRpcUserOperation(await sign(await prepare()));
      expect(await (await sendRaw({ ...unsponsored, paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: '0x1', paymasterPostOpGasLimit: '0x1' })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
    });

    it('a signature by another key, or a malformed one, is refused', async () => {
      const prepared = await prepare();
      expect(await (await sendOp(await sign(prepared, otherKey))).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(await (await sendOp({ ...prepared, signature: '0x' })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(await (await sendOp({ ...prepared, signature: `0x${'00'.repeat(77)}` })).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
    });

    it('another EntryPoint is refused', async () => {
      const operation = await sign(await prepare());
      const response = await sendOp(operation, OTHER);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_BODY' });
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
    });

    it('without a prepared operation nothing is forwarded', async () => {
      const response = await sendOp(await sign(prepareOffline()));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'DEPLOYMENT_NOT_PREPARED' });
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
    });

    it('sending the same operation again returns the recorded hash without forwarding it again', async () => {
      const operation = await sign(await prepare());
      const first = (await (await sendOp(operation)).json()) as { result: string };
      const again = await sendOp(operation);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(1);
    });

    it('after a deployment is sent, a different one is refused, and so is preparing another', async () => {
      const prepared = await prepare();
      expect((await sendOp(await sign(prepared))).status).toBe(200);
      const different = await sendOp(await sign({ ...prepared, callGasLimit: '1' }));
      expect(different.status).toBe(409);
      expect(await different.json()).toEqual({ error: 'ALREADY_SPONSORED' });
      const before = upstreamUserOps();
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'ALREADY_SPONSORED' });
      expect(upstreamUserOps()).toBe(before);
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(1);
    });

    it('after the retry window a new deployment can be prepared and sent, but only while the Safe is still not deployed', async () => {
      process.env.AA_DEPLOYMENT_RETRY_SECONDS = '60';
      expect((await sendOp(await sign(await prepare()))).status).toBe(200);
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 30_000);
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'ALREADY_SPONSORED' });
      vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
      network.gasPrice = 12n * GWEI;
      const retry = await prepare();
      expect(retry.maxFeePerGas).toBe(((252n * GWEI) / 10n).toString());
      expect((await sendOp(await sign(retry))).status).toBe(200);
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(2);
      vi.spyOn(Date, 'now').mockReturnValue(now + 130_000);
      node.state.code[account.address.toLowerCase()] = '0x60';
      expect(await (await rpc('vault_prepareDeployment')).json()).toEqual({ error: 'ALREADY_DEPLOYED' });
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
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(1);
      const hash = userOperationHash(operation, CHAIN, account);
      expect(bodies.filter((body) => body.result === hash).length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) expect([JSON.stringify({ result: hash }), JSON.stringify({ error: 'DEPLOYMENT_IN_PROGRESS' })]).toContain(JSON.stringify(body));
    });

    it('an upstream error releases the claim so the same operation can be sent again', async () => {
      const working = send;
      send = () => {
        throw new RpcFailure('AA25 invalid account nonce');
      };
      const operation = await sign(await prepare());
      const failed = await sendOp(operation);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: 'UPSTREAM_ERROR', rpcMessage: 'AA25 invalid account nonce' });
      expect(await getSponsoredDeployment(CHAIN, account.address)).toMatchObject({ status: 'prepared' });
      send = () => 'not a hash';
      expect(await (await sendOp(operation)).json()).toEqual({ error: 'UPSTREAM_INVALID' });
      expect(await getSponsoredDeployment(CHAIN, account.address)).toMatchObject({ status: 'prepared' });
      send = working;
      expect((await sendOp(operation)).status).toBe(200);
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(3);
    });

    it('a transport error releases the claim too', async () => {
      const operation = await sign(await prepare());
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: 'http://127.0.0.1:1/secret-key', paymasterUrl: paymaster.url } });
      const failed = await sendOp(operation);
      expect(await failed.text()).not.toContain('secret-key');
      expect(await getSponsoredDeployment(CHAIN, account.address)).toMatchObject({ status: 'prepared' });
      process.env.AA_CHAINS = chains();
      expect((await sendOp(operation)).status).toBe(200);
    });

    it('a Safe deployed in the meantime is not sent again', async () => {
      const operation = await sign(await prepare());
      node.state.code[account.address.toLowerCase()] = '0x60';
      expect(await (await sendOp(operation)).json()).toEqual({ error: 'ALREADY_DEPLOYED' });
      expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
    });
  });

  describe('eth_getUserOperationReceipt', () => {
    it('only for the hash recorded for this session\'s Safe and chain', async () => {
      const receipt = (hash: string, session = cookie) => rpc('eth_getUserOperationReceipt', [hash], session);
      const operation = await sign(await prepare());
      const hash = userOperationHash(operation, CHAIN, account);
      expect(await (await receipt(hash)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect((await sendOp(operation)).status).toBe(200);
      expect(await (await receipt(`0x${'ee'.repeat(32)}`)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect((await receipt('0x1234')).status).toBe(400);
      const ok = await receipt(hash.toUpperCase().replace('0X', '0x'));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ result: { success: true } });

      // Another user, with their own Safe, cannot ask for it.
      const bob = await openSession('bob');
      await activeWallet(bob, 'bob', other.address);
      await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
      expect(await (await receipt(hash, bob)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      // Nor on another chain of the same Safe.
      await setSessionChain(cookie, { chainId: CHAIN + 1, rpcUrl: node.url });
      process.env.AA_CHAINS = JSON.stringify({ [CHAIN + 1]: { bundlerUrl: bundler.url } });
      expect(await (await receipt(hash)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
      expect(bundler.of('eth_getUserOperationReceipt')).toHaveLength(1);
    });
  });

  it('another user\'s session neither prepares nor sends this Safe\'s deployment', async () => {
    const operation = await sign(await prepare());
    const bob = await openSession('bob');
    await activeWallet(bob, 'bob', other.address);
    await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
    expect(await (await sendOp(operation, account.entryPoint, bob)).json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
    expect(bundler.of('eth_sendUserOperation')).toHaveLength(0);
  });

  it('both routes are rate limited per user, with Retry-After', async () => {
    process.env.RATE_LIMITS = JSON.stringify({ aa: { sub: 2 } });
    expect((await getAaStatus(req('/api/aa/status', { method: 'GET', cookie }))).status).toBe(200);
    expect((await rpc('eth_getUserOperationReceipt', [`0x${'ee'.repeat(32)}`])).status).toBe(403);
    const limited = await rpc('vault_prepareDeployment');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await getAaStatus(req('/api/aa/status', { method: 'GET', cookie }))).status).toBe(429);
    expect(upstreamUserOps()).toBe(0);
    // Per user: another one still has its budget.
    const bob = await openSession('bob');
    await activeWallet(bob, 'bob', other.address);
    await setSessionChain(bob, { chainId: CHAIN, rpcUrl: node.url });
    expect((await getAaStatus(req('/api/aa/status', { method: 'GET', cookie: bob }))).status).toBe(200);
  });
});

describe('fee and gas rules', () => {
  const limits = { ...sponsorshipLimits(1, {}), maxFeePerGas: 500n, feeMultiplierPercent: 200n, priorityFeeMultiplierPercent: 100n };

  it('maxFeePerGas = gasPrice * multiplier + priority, clamped, with the priority never above it', () => {
    expect(deploymentFees(100n, 10n, limits)).toEqual({ maxFeePerGas: 210n, maxPriorityFeePerGas: 10n });
    expect(deploymentFees(300n, 10n, limits)).toEqual({ maxFeePerGas: 500n, maxPriorityFeePerGas: 10n });
    expect(deploymentFees(100n, 450n, limits)).toEqual({ maxFeePerGas: 500n, maxPriorityFeePerGas: 450n });
    expect(deploymentFees(500n, 0n, { ...limits, feeMultiplierPercent: 100n })).toEqual({ maxFeePerGas: 500n, maxPriorityFeePerGas: 0n });
    expect(() => deploymentFees(501n, 0n, limits)).toThrow('FEES_TOO_HIGH');
    expect(() => deploymentFees(1n, 501n, limits)).toThrow('FEES_TOO_HIGH');
  });

  it('the tip gets its own margin, and maxFeePerGas stays at least the tip', () => {
    const withTip = { ...limits, priorityFeeMultiplierPercent: 150n };
    expect(deploymentFees(100n, 10n, withTip)).toEqual({ maxFeePerGas: 215n, maxPriorityFeePerGas: 15n });
    expect(deploymentFees(100n, 400n, withTip)).toEqual({ maxFeePerGas: 500n, maxPriorityFeePerGas: 500n });
  });

  it("the bundler's quote is a floor for both fees, with the tip margin, and within the cap", () => {
    // Ethereum Sepolia: the node says 68 wei and a 50 wei tip, Pimlico wants about 1.1 Mwei.
    const sepolia = { ...sponsorshipLimits(1, {}), maxFeePerGas: 100n * GWEI };
    expect(deploymentFees(68n, 50n, sepolia, { maxFeePerGas: 1_500_000n, maxPriorityFeePerGas: 1_100_000n })).toEqual({
      maxFeePerGas: 1_800_000n,
      maxPriorityFeePerGas: 1_320_000n,
    });
    // A node above the quote wins.
    expect(deploymentFees(100n, 10n, { ...limits, priorityFeeMultiplierPercent: 120n }, { maxFeePerGas: 20n, maxPriorityFeePerGas: 5n })).toEqual({ maxFeePerGas: 212n, maxPriorityFeePerGas: 12n });
    // A quote above the cap is refused: underpricing it would only fail at send time.
    expect(() => deploymentFees(1n, 1n, limits, { maxFeePerGas: 501n, maxPriorityFeePerGas: 1n })).toThrow('FEES_TOO_HIGH');
    expect(() => deploymentFees(1n, 1n, limits, { maxFeePerGas: 10n, maxPriorityFeePerGas: 501n })).toThrow('FEES_TOO_HIGH');
    // A quote that ends up above the cap after the margin is clamped, like the node's.
    expect(deploymentFees(1n, 1n, { ...limits, priorityFeeMultiplierPercent: 200n }, { maxFeePerGas: 400n, maxPriorityFeePerGas: 300n })).toEqual({ maxFeePerGas: 500n, maxPriorityFeePerGas: 500n });
  });

  it('gas gets a 20% margin, clamped to the cap; above the cap it is refused', () => {
    expect(gasWithMargin(100n, 1000n)).toBe(120n);
    expect(gasWithMargin(900n, 1000n)).toBe(1000n);
    expect(gasWithMargin(1000n, 1000n)).toBe(1000n);
    expect(() => gasWithMargin(1001n, 1000n)).toThrow('GAS_LIMIT_EXCEEDED');
  });
});

/** An operation shaped like a prepared one, but that the server never recorded. */
function prepareOffline(): UserOperationJson {
  return { ...buildDeploymentOperation(owner.address, { maxFeePerGas: '1', maxPriorityFeePerGas: '1' }, account), callGasLimit: '1', verificationGasLimit: '1', preVerificationGas: '1', signature: '0x' };
}

function fromRpc(operation: Record<string, string>): UserOperationJson {
  const decimal = (value: string | undefined) => (value === undefined ? null : BigInt(value).toString());
  return {
    sender: operation.sender as `0x${string}`,
    nonce: BigInt(operation.nonce!).toString(),
    factory: operation.factory ?? null,
    factoryData: operation.factoryData ?? null,
    callData: operation.callData!,
    callGasLimit: BigInt(operation.callGasLimit!).toString(),
    verificationGasLimit: BigInt(operation.verificationGasLimit!).toString(),
    preVerificationGas: BigInt(operation.preVerificationGas!).toString(),
    maxFeePerGas: BigInt(operation.maxFeePerGas!).toString(),
    maxPriorityFeePerGas: BigInt(operation.maxPriorityFeePerGas!).toString(),
    paymaster: operation.paymaster ?? null,
    paymasterVerificationGasLimit: decimal(operation.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: decimal(operation.paymasterPostOpGasLimit),
    paymasterData: operation.paymasterData ?? null,
    signature: operation.signature ?? '0x',
  };
}
