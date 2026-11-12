import { WalletAccountReadOnlyEvmErc4337 } from '@tetherto/wdk-wallet-evm-erc-4337';
import { predictSafeAddress, smartAccountFor } from '@wl-embedded-wallet/core/safe';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainStatus, isAllowedRpcUrl, jsonRpc, resolveRpcUrl } from '../../server/chains';
import { startFakeRpc, type FakeRpc } from './fake-rpc';

const OWNERS = ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906'];
const OWNER = OWNERS[0]!;
const CHAIN_ID = 31001;
const account = smartAccountFor(OWNER);
const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

describe('Safe address', () => {
  it.each(OWNERS)('matches the WDK address for %s', (owner) => {
    expect(predictSafeAddress(owner)).toBe(WalletAccountReadOnlyEvmErc4337.predictSafeAddress(owner, { safeModulesVersion: '0.3.0' }));
  });
});

describe('RPC provenance', () => {
  beforeEach(() => {
    process.env.RPC_ALLOWED_HOSTS = 'rpc.allowed.test,127.0.0.1';
    process.env.AA_CHAINS = JSON.stringify({ 1: { rpcUrl: 'https://with-key.test/secret' } });
  });

  it('requires HTTPS (HTTP only locally), no credentials and a listed host', () => {
    expect(isAllowedRpcUrl('https://rpc.allowed.test/v1')).toBe(true);
    expect(isAllowedRpcUrl('http://127.0.0.1:8545')).toBe(true);
    expect(isAllowedRpcUrl('http://rpc.allowed.test')).toBe(false);
    expect(isAllowedRpcUrl('https://other.test')).toBe(false);
    expect(isAllowedRpcUrl('https://user:pass@rpc.allowed.test')).toBe(false);
    expect(isAllowedRpcUrl('https://localhost')).toBe(false);
    expect(isAllowedRpcUrl('ftp://rpc.allowed.test')).toBe(false);
    expect(isAllowedRpcUrl('not a url')).toBe(false);
  });

  describe('plain HTTP on a local host', () => {
    beforeEach(() => {
      process.env.RPC_ALLOWED_HOSTS = '127.0.0.1,localhost,[::1],rpc.localhost,rpc.allowed.test';
    });
    afterEach(() => vi.unstubAllEnvs());

    const locals = ['http://127.0.0.1:8545', 'http://localhost:8545', 'http://[::1]:8545', 'http://rpc.localhost:8545'];

    it.each(locals)('is refused in production: %s', (url) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ALLOW_INSECURE_LOCAL', '');
      expect(isAllowedRpcUrl(url)).toBe(false);
      // HTTPS on the same host is still fine.
      expect(isAllowedRpcUrl(url.replace('http:', 'https:'))).toBe(true);
    });

    it.each(locals)('is allowed in insecure local mode: %s', (url) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ALLOW_INSECURE_LOCAL', '1');
      expect(isAllowedRpcUrl(url)).toBe(true);
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('ALLOW_INSECURE_LOCAL', '');
      expect(isAllowedRpcUrl(url)).toBe(true);
    });

    it('still needs the host on the list, and never allows HTTP elsewhere', () => {
      vi.stubEnv('NODE_ENV', 'development');
      expect(isAllowedRpcUrl('http://other.localhost:8545')).toBe(false);
      expect(isAllowedRpcUrl('http://rpc.allowed.test')).toBe(false);
      // `localhost` as a label of another domain is not a local host.
      process.env.RPC_ALLOWED_HOSTS = 'localhost.evil.test';
      expect(isAllowedRpcUrl('http://localhost.evil.test')).toBe(false);
    });

    it('a token RPC over plain HTTP is not used in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ALLOW_INSECURE_LOCAL', '');
      expect(() => resolveRpcUrl({ chainId: 2, rpcUrl: 'http://127.0.0.1:8545' })).toThrow('CHAIN_NOT_SUPPORTED');
    });
  });

  it('the configuration takes precedence over the token', () => {
    expect(resolveRpcUrl({ chainId: 1, rpcUrl: 'https://rpc.allowed.test' })).toBe('https://with-key.test/secret');
    expect(resolveRpcUrl({ chainId: 2, rpcUrl: 'https://rpc.allowed.test' })).toBe('https://rpc.allowed.test');
  });

  it('without a valid RPC, CHAIN_NOT_SUPPORTED and no connection to anyone', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(chainStatus({ chainId: 2, rpcUrl: 'https://outside.test' }, OWNER, account)).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
    await expect(chainStatus({ chainId: 2 }, OWNER, account)).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('jsonRpc', () => {
  async function server(handler: Parameters<typeof createServer>[1]) {
    const instance = createServer(handler);
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, close: () => new Promise((resolve) => instance.close(resolve)) };
  }

  it('does not follow redirects', async () => {
    const target = await server((_request, response) => {
      response.statusCode = 302;
      response.setHeader('Location', 'http://127.0.0.1:1/internal');
      response.end();
    });
    await expect(jsonRpc(target.url, 'eth_chainId', [])).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
    await target.close();
  });

  it('cuts off an oversized response', async () => {
    const target = await server((_request, response) => {
      response.end(`{"result":"${'a'.repeat(2 * 1024 * 1024)}"}`);
    });
    await expect(jsonRpc(target.url, 'eth_chainId', [])).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
    await target.close();
  });

  it('an error never includes the URL, which may carry the API key', async () => {
    const outcome = jsonRpc('http://127.0.0.1:1/secret-api-key', 'eth_chainId', []);
    const error = await outcome.catch((caught: Error) => caught);
    expect(String((error as Error).message)).not.toContain('secret-api-key');
  });
});

describe('chainStatus', () => {
  let rpc: FakeRpc;

  beforeEach(async () => {
    rpc = await startFakeRpc(CHAIN_ID);
    process.env.RPC_ALLOWED_HOSTS = '127.0.0.1';
    process.env.AA_CHAINS = JSON.stringify({ [CHAIN_ID]: { name: 'Local', bundlerUrl: 'http://127.0.0.1:1', paymasterUrl: 'http://127.0.0.1:1' } });
    rpc.state.code[account.address.toLowerCase()] = '0x';
    rpc.state.callResult = addressWord(account.address);
  });

  afterEach(() => rpc.close());

  const status = () => chainStatus({ chainId: CHAIN_ID, rpcUrl: rpc.url }, OWNER, account);

  it('not deployed and deployable if the factory returns exactly the predicted address', async () => {
    await expect(status()).resolves.toMatchObject({ chainId: CHAIN_ID, deployed: false, deployable: true, sponsored: true, chainName: 'Local', nativeCurrency: 'ETH', rpcHost: new URL(rpc.url).host });
    const simulated = rpc.calls.find((call) => call.method === 'eth_call')!;
    expect((simulated.params[0] as { to: string }).to).toBe(account.factory);
  });

  it('transactionsSponsored only with a paymaster and sponsorTransactions: true', async () => {
    await expect(status()).resolves.toMatchObject({ sponsored: true, transactionsSponsored: false });
    const configure = (config: Record<string, unknown>) => (process.env.AA_CHAINS = JSON.stringify({ [CHAIN_ID]: { bundlerUrl: 'http://127.0.0.1:1', ...config } }));
    configure({ paymasterUrl: 'http://127.0.0.1:1', sponsorTransactions: true });
    await expect(status()).resolves.toMatchObject({ sponsored: true, transactionsSponsored: true });
    configure({ paymasterUrl: 'http://127.0.0.1:1', sponsorTransactions: false });
    await expect(status()).resolves.toMatchObject({ transactionsSponsored: false });
    // Not a boolean: off (validateConfig reports it).
    configure({ paymasterUrl: 'http://127.0.0.1:1', sponsorTransactions: 'true' });
    await expect(status()).resolves.toMatchObject({ transactionsSponsored: false });
    configure({ sponsorTransactions: true });
    await expect(status()).resolves.toMatchObject({ sponsored: false, transactionsSponsored: false });
    // Also once deployed.
    rpc.state.code[account.address.toLowerCase()] = '0x60';
    configure({ paymasterUrl: 'http://127.0.0.1:1', sponsorTransactions: true });
    await expect(status()).resolves.toMatchObject({ deployed: true, transactionsSponsored: true });
  });

  it('deployed if the Safe has code, without simulating the factory', async () => {
    rpc.state.code[account.address.toLowerCase()] = '0x60';
    await expect(status()).resolves.toMatchObject({ deployed: true });
    expect(rpc.calls.some((call) => call.method === 'eth_call')).toBe(false);
  });

  it('an RPC for another network gets CHAIN_MISMATCH, without querying anything else', async () => {
    rpc.state.chainId = CHAIN_ID + 1;
    await expect(status()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    expect(rpc.calls.map((call) => call.method)).toEqual(['eth_chainId']);
  });

  it('a factory returning another address is not accepted, and that other address is never shown', async () => {
    rpc.state.callResult = addressWord('0x0000000000000000000000000000000000000abc');
    await expect(status()).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
  });

  it.each(['factory', 'singleton', 'safe4337Module', 'safeModuleSetup', 'entryPoint'] as const)('missing code at %s is not accepted', async (contract) => {
    rpc.state.code[account[contract].toLowerCase()] = '0x';
    await expect(status()).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
  });

  it('without a bundler on that network it is not deployable, but it can sign if already deployed', async () => {
    process.env.AA_CHAINS = '{}';
    await expect(status()).resolves.toMatchObject({ deployed: false, deployable: false, bundler: false });
    rpc.state.code[account.address.toLowerCase()] = '0x60';
    await expect(status()).resolves.toMatchObject({ deployed: true, bundler: false });
  });
});

describe('chain names and native currency', () => {
  const opened: FakeRpc[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((rpc) => rpc.close()));
    delete process.env.AA_CHAINS;
    delete process.env.RPC_ALLOWED_HOSTS;
  });

  async function statusOn(chainId: number, config: Record<string, unknown> = {}) {
    const rpc = await startFakeRpc(chainId);
    opened.push(rpc);
    rpc.state.code[account.address.toLowerCase()] = '0x60';
    process.env.RPC_ALLOWED_HOSTS = '127.0.0.1';
    process.env.AA_CHAINS = JSON.stringify({ [chainId]: config });
    return chainStatus({ chainId, rpcUrl: rpc.url }, OWNER, account);
  }

  it('known testnets have a name and a symbol; AA_CHAINS overrides both', async () => {
    await expect(statusOn(84532)).resolves.toMatchObject({ chainName: 'Base Sepolia', nativeCurrency: 'ETH' });
    await expect(statusOn(80002)).resolves.toMatchObject({ chainName: 'Polygon Amoy', nativeCurrency: 'POL' });
    await expect(statusOn(11155111, { name: 'Ethereum Sepolia' })).resolves.toMatchObject({ chainName: 'Ethereum Sepolia', nativeCurrency: 'ETH' });
    await expect(statusOn(31337, { nativeCurrency: 'TST' })).resolves.toMatchObject({ chainName: 'Unnamed network', nativeCurrency: 'TST' });
    await expect(statusOn(31338)).resolves.toMatchObject({ nativeCurrency: 'ETH' });
  });
});
