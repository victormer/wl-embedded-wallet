import { afterEach, describe, expect, it } from 'vitest';
import { demoChains, DemoChainsConfigError, findDemoChain, publicDemoChains } from '@/server/chains';

const SECRET_RPC = 'https://rpc.example.test/v2/secret-api-key';
const valid = { chainId: 31001, name: 'Local A', rpcUrl: 'http://127.0.0.1:21545' };
const original = process.env.DEMO_CHAINS;

function withChains(value: unknown): void {
  process.env.DEMO_CHAINS = typeof value === 'string' ? value : JSON.stringify(value);
}

afterEach(() => {
  if (original === undefined) delete process.env.DEMO_CHAINS;
  else process.env.DEMO_CHAINS = original;
});

describe('DEMO_CHAINS', () => {
  it('unset or empty means no chains', () => {
    delete process.env.DEMO_CHAINS;
    expect(demoChains()).toEqual([]);
    withChains('');
    expect(demoChains()).toEqual([]);
  });

  it('accepts valid chains and keeps only the known fields', () => {
    withChains([valid, { chainId: 137, name: 'Polygon', rpcUrl: SECRET_RPC, extra: true }]);
    expect(demoChains()).toEqual([valid, { chainId: 137, name: 'Polygon', rpcUrl: SECRET_RPC }]);
    expect(findDemoChain(137)?.rpcUrl).toBe(SECRET_RPC);
    expect(findDemoChain('137')).toBeNull();
    expect(findDemoChain(1)).toBeNull();
  });

  it('rejects an invalid value with a configuration error that never includes it', () => {
    const invalid: unknown[] = [
      `{"rpcUrl":"${SECRET_RPC}"`,
      { chainId: 1, name: 'A', rpcUrl: SECRET_RPC },
      [null],
      [[valid]],
      [{ ...valid, chainId: 0 }],
      [{ ...valid, chainId: -1 }],
      [{ ...valid, chainId: 1.5 }],
      [{ ...valid, chainId: '31001' }],
      [{ ...valid, chainId: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...valid, name: '' }],
      [{ ...valid, name: '   ' }],
      [{ ...valid, name: 'x'.repeat(65) }],
      [{ ...valid, name: 42 }],
      [{ ...valid, rpcUrl: 'not a url' }],
      [{ ...valid, rpcUrl: `ws://${SECRET_RPC.slice('https://'.length)}` }],
      [{ ...valid, rpcUrl: `javascript:alert("${SECRET_RPC}")` }],
      [{ chainId: 31001, name: 'Local A' }],
      [valid, { ...valid, name: 'Same chain', rpcUrl: SECRET_RPC }],
      [{ ...valid, explorerUrl: 'not a url' }],
      [{ ...valid, explorerUrl: `javascript:alert("${SECRET_RPC}")` }],
      [{ ...valid, explorerUrl: `ftp://${SECRET_RPC.slice('https://'.length)}` }],
      [{ ...valid, explorerUrl: 'https://user:secret-api-key@explorer.example.test' }],
      [{ ...valid, explorerUrl: 'https://explorer.example.test/?key=secret-api-key' }],
      [{ ...valid, explorerUrl: 'https://explorer.example.test/#secret-api-key' }],
      [{ ...valid, explorerUrl: 42 }],
      [{ ...valid, explorerUrl: null }],
      [{ ...valid, nativeCurrency: '' }],
      [{ ...valid, nativeCurrency: 'secret-api-key' }],
      [{ ...valid, nativeCurrency: 'E T H' }],
      [{ ...valid, nativeCurrency: '<b>' }],
      [{ ...valid, nativeCurrency: 1 }],
    ];
    for (const value of invalid) {
      withChains(value);
      let error: unknown;
      try {
        demoChains();
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(value)).toBeInstanceOf(DemoChainsConfigError);
      expect((error as Error).message).toMatch(/^DEMO_CHAINS /);
      expect((error as Error).message).not.toContain('secret-api-key');
      expect((error as Error).cause).toBeUndefined();
      expect(() => findDemoChain(31001)).toThrow(DemoChainsConfigError);
    }
  });

  it('accepts a name of exactly 64 characters and an https URL', () => {
    withChains([{ ...valid, name: 'x'.repeat(64), rpcUrl: SECRET_RPC }]);
    expect(demoChains()).toHaveLength(1);
  });

  it('accepts an optional explorer URL, without a trailing slash, and a native currency symbol', () => {
    withChains([
      { ...valid, explorerUrl: 'https://sepolia.etherscan.io/', nativeCurrency: 'ETH' },
      { chainId: 137, name: 'Polygon', rpcUrl: SECRET_RPC, explorerUrl: 'https://explorer.example.test/polygon//', nativeCurrency: 'POL' },
      { chainId: 10, name: 'Other', rpcUrl: SECRET_RPC, explorerUrl: 'http://127.0.0.1:4000', nativeCurrency: 'w.ETH-x_1' },
    ]);
    expect(demoChains()).toEqual([
      { ...valid, explorerUrl: 'https://sepolia.etherscan.io', nativeCurrency: 'ETH' },
      { chainId: 137, name: 'Polygon', rpcUrl: SECRET_RPC, explorerUrl: 'https://explorer.example.test/polygon', nativeCurrency: 'POL' },
      { chainId: 10, name: 'Other', rpcUrl: SECRET_RPC, explorerUrl: 'http://127.0.0.1:4000', nativeCurrency: 'w.ETH-x_1' },
    ]);
    withChains([{ ...valid, nativeCurrency: 'A'.repeat(11) }]);
    expect(demoChains()[0]?.nativeCurrency).toBe('A'.repeat(11));
    withChains([{ ...valid, nativeCurrency: 'A'.repeat(12) }]);
    expect(() => demoChains()).toThrow(DemoChainsConfigError);
  });

  it('publicDemoChains never includes the RPC', () => {
    withChains([{ ...valid, rpcUrl: SECRET_RPC, explorerUrl: 'https://sepolia.etherscan.io', nativeCurrency: 'ETH' }, { chainId: 137, name: 'Polygon', rpcUrl: SECRET_RPC }]);
    const chains = publicDemoChains();
    expect(chains).toEqual([
      { chainId: 31001, name: 'Local A', explorerUrl: 'https://sepolia.etherscan.io', nativeCurrency: 'ETH' },
      { chainId: 137, name: 'Polygon' },
    ]);
    expect(JSON.stringify(chains)).not.toContain('secret-api-key');
    expect(chains[1]).not.toHaveProperty('explorerUrl');
    withChains('{no-json');
    expect(() => publicDemoChains()).toThrow(DemoChainsConfigError);
  });
});
