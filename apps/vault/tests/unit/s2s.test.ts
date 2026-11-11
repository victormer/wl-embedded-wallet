import { smartAccountFor } from '@wl-embedded-wallet/core/safe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getAccount } from '../../app/api/s2s/accounts/[sub]/route';
import { getStore } from '../../server/store';
import { startFakeRpc, type FakeRpc } from './fake-rpc';
import { activeWallet, expectRateLimited, openSession, req, useRouteEnv } from './route-harness';

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const AUTH = 'Bearer service-token';
const CHAIN = 31001;

useRouteEnv();

let node: FakeRpc;

beforeEach(async () => {
  node = await startFakeRpc(CHAIN);
  vi.stubEnv('RPC_ALLOWED_HOSTS', '127.0.0.1');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await node.close();
});

/** `sub` is passed as Next.js passes the decoded path segment. */
const call = (sub: string, { query = '', authorization = AUTH }: { query?: string; authorization?: string } = {}) =>
  getAccount(req(`/api/s2s/accounts/${encodeURIComponent(sub)}${query}`, { method: 'GET', authorization }), { params: Promise.resolve({ sub }) });

async function withWallet(sub = 'alice', address = ADDRESS): Promise<void> {
  await activeWallet(await openSession(sub), sub, address);
}

/** Spies on the store and the chain: invalid input must reach neither. */
async function lookups() {
  const store = await getStore();
  const spies = [vi.spyOn(store, 'getAccount'), vi.spyOn(store, 'getActiveSet')];
  return { count: () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0) + node.calls.length };
}

const rpc = (chainId: string) => `?chainId=${chainId}&rpcUrl=${encodeURIComponent(node.url)}`;

describe('GET /api/s2s/accounts/:sub input', () => {
  it.each(['a|b', 'a'.repeat(65), 'a b', 'ünicode', 'a/b', '.', '..'])('rejects the sub %j with INVALID_SUB, without looking it up', async (sub) => {
    await withWallet();
    const seen = await lookups();
    const response = await call(sub);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_SUB' });
    expect(seen.count()).toBe(0);
  });

  it('accepts every sub the handoff accepts', async () => {
    for (const sub of ['a', 'A-z_0-9', 'a'.repeat(64)]) {
      expect(await (await call(sub)).json()).toEqual({ exists: false, address: null, owner: null });
    }
  });

  it('the bearer token is checked first', async () => {
    expect((await call('a|b', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('alice', { query: '?chainId=abc', authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it.each(['abc', '0', '-1', '01', '1e3', '1.5', ' 1', '', '9007199254740992', '9007199254740993', '9999999999999999', '12345678901234567'])(
    'rejects the chainId %j with INVALID_CHAIN_ID, for an existing or an unknown account, without touching the store or the chain',
    async (chainId) => {
      await withWallet();
      const seen = await lookups();
      for (const sub of ['alice', 'ghost']) {
        const response = await call(sub, { query: `?chainId=${encodeURIComponent(chainId)}&rpcUrl=${encodeURIComponent(node.url)}` });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'INVALID_CHAIN_ID' });
      }
      expect(seen.count()).toBe(0);
    },
  );

  it('the largest safe integer is a valid chainId, and an unknown account never queries the chain', async () => {
    expect(await (await call('ghost', { query: rpc('9007199254740991') })).json()).toEqual({ exists: false, address: null, owner: null });
    expect(await (await call('ghost', { query: rpc(String(CHAIN)) })).json()).toEqual({ exists: false, address: null, owner: null });
    expect(node.calls).toHaveLength(0);
  });

  it('control: an existing account with a valid chainId does query the chain', async () => {
    await withWallet();
    const response = await call('alice', { query: rpc(String(CHAIN)) });
    expect(await response.json()).toMatchObject({ exists: true, address: smartAccountFor(ADDRESS).address, chainId: CHAIN });
    expect(node.calls.length).toBeGreaterThan(0);
  });
});

describe('GET /api/s2s/accounts/:sub rate limits', () => {
  it('per sub: the same budget and the same answers whether or not the account exists', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ s2s: { ip: 1000, sub: 2 } }));
    await withWallet();
    const statuses: Record<string, number[]> = {};
    const limited: Record<string, unknown> = {};
    for (const sub of ['alice', 'ghost']) {
      const responses = [await call(sub), await call(sub, { query: `?chainId=${CHAIN}` }), await call(sub)];
      statuses[sub] = responses.map(({ status }) => status);
      await expectRateLimited(responses[2].clone());
      limited[sub] = { body: await responses[2].text(), headers: [...responses[2].headers.keys()].sort() };
    }
    expect(statuses).toEqual({ alice: [200, 200, 429], ghost: [200, 200, 429] });
    expect(limited.alice).toEqual(limited.ghost);
    // Each sub has its own budget.
    await withWallet('bob', OTHER_ADDRESS);
    expect((await call('bob')).status).toBe(200);
  });

  it('per IP before the bearer check: guessing the token is throttled too', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ s2s: { ip: 2, sub: 1000 } }));
    expect((await call('alice', { authorization: 'Bearer guess-1' })).status).toBe(401);
    expect((await call('alice', { authorization: 'Bearer guess-2' })).status).toBe(401);
    await expectRateLimited(await call('alice', { authorization: 'Bearer guess-3' }));
    await expectRateLimited(await call('alice'));
  });

  it('an unauthenticated caller does not spend a user\'s budget', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ s2s: { ip: 1000, sub: 1 } }));
    await withWallet();
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await call('alice', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('alice')).status).toBe(200);
    await expectRateLimited(await call('alice'));
  });
});
