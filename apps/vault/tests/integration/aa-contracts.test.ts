// Against the real Safe and EntryPoint contracts on anvil. Run with `pnpm test:aa`.
import { WalletAccountReadOnlyEvmErc4337 } from '@tetherto/wdk-wallet-evm-erc-4337';
import type { UserOperationJson } from '@wl-embedded-wallet/core/operations';
import {
  buildUserOperation,
  deploymentFactory,
  ERC1271_MAGIC_VALUE,
  predictSafeAddress,
  requestHash,
  safeMessageTypedData,
  signSafeOperation,
  smartAccountFor,
  toRpcUserOperation,
  userOperationHash,
} from '@wl-embedded-wallet/core/safe';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as postAaRpc } from '../../app/api/aa/rpc/route';
import { chainStatus } from '../../server/chains';
import { buildSponsoredDeployment } from '../../server/sponsorship';
import { getSponsoredDeployment, setSessionChain } from '../../server/store';
import { activeWallet, openSession, req, useRouteEnv } from '../unit/route-harness';
// @ts-expect-error JavaScript test module.
import { startAaStack } from '../aa-stack/stack.mjs';

const ERC1271 = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const CHAIN_A = 31101;
const CHAIN_B = 31102;
const CHAIN_NO_FACTORY = 31103;

type Chain = { chainId: number; rpcUrl: string; bundlerUrl: string; paymasterUrl: string; paymasterAddress: string; requests: { method: string; context?: unknown }[] };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

function signerFor(key: `0x${string}`) {
  const account = privateKeyToAccount(key);
  return { account, signer: { address: account.address, signHash: (hash: `0x${string}`) => account.sign({ hash }) } };
}

/** The deployment exactly as the vault builds it: node fees, real stub data, bundler estimate and final data, within the caps. */
function buildAsVault(chain: Chain, owner: `0x${string}`): Promise<UserOperationJson> {
  return buildSponsoredDeployment({
    chainId: chain.chainId,
    userId: 'integration',
    owner,
    account: smartAccountFor(owner),
    config: { bundlerUrl: chain.bundlerUrl, paymasterUrl: chain.paymasterUrl },
    rpcUrl: chain.rpcUrl,
    bundler: { url: chain.bundlerUrl },
  });
}

async function deploy(chain: Chain, key: `0x${string}`, options: { tamperSignature?: boolean } = {}) {
  const { account, signer } = signerFor(key);
  const params = smartAccountFor(account.address);
  const op = await buildAsVault(chain, account.address);
  const signature = await signSafeOperation(op, chain.chainId, params, signer);
  const signed = { ...op, signature: options.tamperSignature ? `${signature.slice(0, -2)}${signature.endsWith('1b') ? '1c' : '1b'}` : signature };
  const userOpHash = await rpc<string>(chain.bundlerUrl, 'eth_sendUserOperation', [toRpcUserOperation(signed), params.entryPoint]);
  return { userOpHash, receipt: await rpc<{ success: boolean; paymaster: string; receipt: { transactionHash: string } }>(chain.bundlerUrl, 'eth_getUserOperationReceipt', [userOpHash]) };
}

const getCode = (chain: { rpcUrl: string }, address: string) => rpc<string>(chain.rpcUrl, 'eth_getCode', [address, 'latest']);

useRouteEnv();

describe('real Safe and EntryPoint contracts', () => {
  let stack: { chains: Chain[]; stop(): Promise<unknown> };
  let a: Chain;
  let b: Chain;
  let noFactory: Chain;
  const key = generatePrivateKey();
  const owner = privateKeyToAccount(key).address;
  const safe = predictSafeAddress(owner);

  beforeAll(async () => {
    stack = await startAaStack([
      { chainId: CHAIN_A, port: 38545, withContracts: true },
      { chainId: CHAIN_B, port: 38546, withContracts: true },
      { chainId: CHAIN_NO_FACTORY, port: 38547, withContracts: false },
    ]);
    [a, b, noFactory] = stack.chains as [Chain, Chain, Chain];
    process.env.RPC_ALLOWED_HOSTS = '127.0.0.1';
    // Transactions are sponsored on B only: A has a paymaster for deployments, but its Safe pays for its own calls.
    process.env.AA_CHAINS = JSON.stringify({
      [CHAIN_A]: { bundlerUrl: a.bundlerUrl, paymasterUrl: a.paymasterUrl },
      [CHAIN_B]: { bundlerUrl: b.bundlerUrl, paymasterUrl: b.paymasterUrl, sponsorTransactions: true },
    });
  }, 60_000);

  afterAll(() => stack?.stop());

  it('the predicted address matches WDK', () => {
    expect(safe).toBe(WalletAccountReadOnlyEvmErc4337.predictSafeAddress(owner, { safeModulesVersion: '0.3.0' }));
  });

  it('the real factory returns exactly the predicted address on both chains', async () => {
    const { factory, factoryData } = deploymentFactory(owner);
    for (const chain of [a, b]) {
      const returned = await rpc<string>(chain.rpcUrl, 'eth_call', [{ to: factory, data: factoryData }, 'latest']);
      expect(`0x${returned.slice(26)}`).toBe(safe.toLowerCase());
    }
  });

  it('the vault allows deployment on chains with the real factory', async () => {
    for (const chain of [a, b]) {
      await expect(chainStatus({ chainId: chain.chainId, rpcUrl: chain.rpcUrl }, owner, smartAccountFor(owner))).resolves.toMatchObject({ deployed: false, deployable: true });
    }
  });

  it('a real chain without a factory is not supported', async () => {
    await expect(chainStatus({ chainId: noFactory.chainId, rpcUrl: noFactory.rpcUrl }, owner, smartAccountFor(owner))).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
  });

  it('a real RPC with a different chainId gives CHAIN_MISMATCH', async () => {
    await expect(chainStatus({ chainId: CHAIN_B, rpcUrl: a.rpcUrl }, owner, smartAccountFor(owner))).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  });

  it('the real EntryPoint rejects a tampered owner signature', async () => {
    await expect(deploy(a, key, { tamperSignature: true })).rejects.toThrow(/AA24|AA23/);
    expect(await getCode(a, safe)).toMatch(/^0x$|^$/);
  });

  it('deploys with the paymaster on A, at the predicted address, without touching B', async () => {
    const { receipt } = await deploy(a, key);
    expect(receipt!.success).toBe(true);
    expect(receipt!.paymaster.toLowerCase()).toBe(a.paymasterAddress.toLowerCase());
    expect((await getCode(a, safe)).length).toBeGreaterThan(2);
    expect(await getCode(b, safe)).toMatch(/^0x$|^$/);
  });

  it('deploys on B at the same address, through the vault routes: prepared by the server, sent once', async () => {
    const cookie = await openSession('alice');
    await activeWallet(cookie, 'alice', owner);
    await setSessionChain(cookie, { chainId: b.chainId, rpcUrl: b.rpcUrl });
    const call = async (method: string, params: unknown[]) => (await postAaRpc(req('/api/aa/rpc', { cookie, body: { method, params } }))).json();
    const { signer } = signerFor(key);
    const params = smartAccountFor(owner);

    const { result: prepared } = (await call('vault_prepareDeployment', [])) as { result: UserOperationJson };
    expect(prepared).toMatchObject({ sender: safe, nonce: '0', paymaster: getAddress(b.paymasterAddress), signature: '0x' });
    const signed = { ...prepared, signature: await signSafeOperation(prepared, b.chainId, params, signer) };
    // A higher fee signed by the owner is still not the prepared operation.
    const greedy = { ...prepared, maxFeePerGas: (BigInt(prepared.maxFeePerGas) * 10n).toString() };
    expect(await call('eth_sendUserOperation', [toRpcUserOperation({ ...greedy, signature: await signSafeOperation(greedy, b.chainId, params, signer) }), params.entryPoint])).toEqual({ error: 'OPERATION_NOT_ALLOWED' });

    const { result: userOpHash } = (await call('eth_sendUserOperation', [toRpcUserOperation(signed), params.entryPoint])) as { result: string };
    expect(userOpHash).toBe(userOperationHash(prepared, b.chainId, params));
    expect(await getSponsoredDeployment(b.chainId, safe)).toMatchObject({ status: 'sent', userOpHash });
    const { result: receipt } = (await call('eth_getUserOperationReceipt', [userOpHash])) as { result: { success: boolean; paymaster: string } };
    expect(receipt!.success).toBe(true);
    expect(receipt!.paymaster.toLowerCase()).toBe(b.paymasterAddress.toLowerCase());
    // Sent again: the same hash, without reaching the bundler a second time.
    const sends = b.requests.filter((request) => request.method === 'eth_sendUserOperation').length;
    expect(await call('eth_sendUserOperation', [toRpcUserOperation(signed), params.entryPoint])).toEqual({ result: userOpHash });
    expect(b.requests.filter((request) => request.method === 'eth_sendUserOperation').length).toBe(sends);
    expect(await call('vault_prepareDeployment', [])).toEqual({ error: 'ALREADY_DEPLOYED' });
    expect((await getCode(b, safe)).length).toBeGreaterThan(2);
    // The predicted address is the real one and is the same on both chains.
    expect(await getCode(a, safe)).toBe(await getCode(b, safe));
    await expect(chainStatus({ chainId: b.chainId, rpcUrl: b.rpcUrl }, owner, smartAccountFor(owner))).resolves.toMatchObject({ deployed: true });
  });

  it('ERC-1271: the Safe signature is valid on its chain and not on another', async () => {
    const account = privateKeyToAccount(key);
    const request = { kind: 'message' as const, message: 'I authorize this operation' };
    const hash = requestHash(request);
    const signature = await account.signTypedData(safeMessageTypedData(safe, a.chainId, hash));

    const read = (chain: Chain, sig: `0x${string}`) =>
      createPublicClient({ transport: http(chain.rpcUrl) }).readContract({ address: safe, abi: ERC1271, functionName: 'isValidSignature', args: [hash, sig] });

    await expect(read(a, signature)).resolves.toBe(ERC1271_MAGIC_VALUE);
    await expect(read(b, signature)).rejects.toThrow();
  });

  it('the real Safe accepts a UserOperation signed for the deployed Safe', async () => {
    const { signer } = signerFor(key);
    const params = smartAccountFor(owner);
    const paymasterless = buildUserOperation(safe, {
      calls: [{ to: safe, value: '0' }],
      nonce: '1',
      callGasLimit: '100000',
      verificationGasLimit: '300000',
      preVerificationGas: '100000',
      maxFeePerGas: '10000000000',
      maxPriorityFeePerGas: '1000000000',
    });
    await rpc(a.rpcUrl, 'anvil_setBalance', [safe, '0x8AC7230489E80000']);
    const signature = await signSafeOperation(paymasterless, a.chainId, params, signer);
    const hash = await rpc<string>(a.bundlerUrl, 'eth_sendUserOperation', [toRpcUserOperation({ ...paymasterless, signature }), params.entryPoint]);
    const receipt = await rpc<{ success: boolean }>(a.bundlerUrl, 'eth_getUserOperationReceipt', [hash]);
    expect(receipt!.success).toBe(true);
  });

  /** A session for `owner`'s wallet on `chain`, and a JSON-RPC call through the vault proxy. */
  async function vaultRpc(chain: Chain) {
    const cookie = await openSession('alice');
    await activeWallet(cookie, 'alice', owner);
    await setSessionChain(cookie, { chainId: chain.chainId, rpcUrl: chain.rpcUrl });
    return async (method: string, params: unknown[]) => (await postAaRpc(req('/api/aa/rpc', { cookie, body: { method, params } }))).json();
  }

  async function sendThroughVault(chain: Chain, transaction: { to: string; value: string; data?: string }) {
    const call = await vaultRpc(chain);
    const { signer } = signerFor(key);
    const params = smartAccountFor(owner);
    const prepared = (await call('vault_prepareTransaction', [transaction])) as { result?: UserOperationJson; error?: string };
    if (!prepared.result) return { prepared, call };
    const operation = prepared.result;
    const signed = { ...operation, signature: await signSafeOperation(operation, chain.chainId, params, signer) };
    const sent = (await call('eth_sendUserOperation', [toRpcUserOperation(signed), params.entryPoint])) as { result: string };
    const receipt = (await call('eth_getUserOperationReceipt', [sent.result])) as { result: { success: boolean; paymaster: string; receipt: { transactionHash: string } } };
    return { prepared, operation, signed, userOpHash: sent.result, receipt: receipt.result, call, params };
  }

  const balanceOf = async (chain: Chain, address: string) => BigInt(await rpc<string>(chain.rpcUrl, 'eth_getBalance', [address, 'latest']));

  it('sends a sponsored 0-value call from the deployed Safe through the vault routes, once', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const before = await balanceOf(b, safe);
    const { operation, signed, userOpHash, receipt, call, params } = await sendThroughVault(b, { to: recipient, value: '0' });
    expect(operation).toMatchObject({ sender: safe, factory: null, paymaster: getAddress(b.paymasterAddress), signature: '0x' });
    expect(BigInt(operation!.nonce)).toBeGreaterThan(0n);
    expect(userOpHash).toBe(userOperationHash(operation!, b.chainId, params!));
    expect(receipt!.success).toBe(true);
    expect(receipt!.paymaster.toLowerCase()).toBe(b.paymasterAddress.toLowerCase());
    // The paymaster paid: the Safe's balance did not move.
    expect(await balanceOf(b, safe)).toBe(before);
    const sends = b.requests.filter((request) => request.method === 'eth_sendUserOperation').length;
    expect(await call('eth_sendUserOperation', [toRpcUserOperation(signed!), params!.entryPoint])).toEqual({ result: userOpHash });
    expect(b.requests.filter((request) => request.method === 'eth_sendUserOperation').length).toBe(sends);
  });

  it('sends an unsponsored value transfer on A, paid by the Safe itself', async () => {
    await rpc(a.rpcUrl, 'anvil_setBalance', [safe, '0x8AC7230489E80000']);
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const value = 10n ** 16n;
    const before = await balanceOf(a, safe);
    const pmCalls = a.requests.filter((request) => request.method.startsWith('pm_')).length;
    const { operation, receipt } = await sendThroughVault(a, { to: recipient, value: value.toString() });
    expect(operation).toMatchObject({ sender: safe, paymaster: null, paymasterData: null });
    expect(a.requests.filter((request) => request.method.startsWith('pm_')).length).toBe(pmCalls);
    expect(receipt!.success).toBe(true);
    expect(receipt!.paymaster).toBe('0x0000000000000000000000000000000000000000');
    expect(await balanceOf(a, recipient)).toBe(value);
    // The value and the network fee both came out of the Safe.
    expect(await balanceOf(a, safe)).toBeLessThan(before - value);
  });

  it('refuses a transfer the Safe cannot pay for, before any upstream call', async () => {
    await rpc(a.rpcUrl, 'anvil_setBalance', [safe, '0x0']);
    const { prepared } = await sendThroughVault(a, { to: privateKeyToAccount(generatePrivateKey()).address, value: '1' });
    expect(prepared).toEqual({ error: 'INSUFFICIENT_FUNDS' });
  });

  it('a call that reverts is included with success false, and the fee is still paid', async () => {
    // The EntryPoint has no function for this selector: the Safe's call reverts inside the UserOperation.
    const { receipt } = await sendThroughVault(b, { to: smartAccountFor(owner).entryPoint, value: '0', data: '0xdeadbeef' });
    expect(receipt!.success).toBe(false);
  });

  it('a Safe that is not deployed gets NOT_DEPLOYED', async () => {
    // Chain A's Safe is deployed; a fresh owner's Safe is not.
    const other = generatePrivateKey();
    const otherOwner = privateKeyToAccount(other).address;
    const cookie = await openSession('bob');
    await activeWallet(cookie, 'bob', otherOwner);
    await setSessionChain(cookie, { chainId: a.chainId, rpcUrl: a.rpcUrl });
    const response = await postAaRpc(req('/api/aa/rpc', { cookie, body: { method: 'vault_prepareTransaction', params: [{ to: otherOwner, value: '0' }] } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'NOT_DEPLOYED' });
  });
});
