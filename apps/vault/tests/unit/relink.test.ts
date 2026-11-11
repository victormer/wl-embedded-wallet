import { afterEach, describe, expect, it, vi } from 'vitest';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { smartAccountFor } from '@wl-embedded-wallet/core/safe';
import { POST as postNonce } from '../../app/api/relink/nonce/route';
import { POST as postRelink } from '../../app/api/relink/route';
import { GET as getAccount } from '../../app/api/s2s/accounts/[sub]/route';
import { GET as getShareA } from '../../app/api/shares/a/route';
import { GET as getShares, POST as postShares } from '../../app/api/shares/route';
import { POST as postExported } from '../../app/api/shares/exported/route';
import { relinkTypedData } from '@wl-embedded-wallet/core/relink';
import type { RelinkChallenge } from '@wl-embedded-wallet/core/types';
import { createRelinkNonce, getSession, getStore, listWalletRelinks } from '../../server/store';
import { activeWallet, APP_ORIGIN, expectRateLimited, ISSUER, openSession, ORIGIN, req, sharesBody, useRouteEnv } from './route-harness';

const OLD = 'old-account';
const NEW = 'new-account';
const THIRD = 'third-account';

useRouteEnv();

const wallet = () => {
  const account = mnemonicToAccount(generateMnemonic(english));
  return { account, safe: smartAccountFor(account.address).address, owner: account.address };
};

async function setup() {
  const owned = wallet();
  const oldCookie = await openSession(OLD);
  const setId = await activeWallet(oldCookie, OLD, owned.owner);
  const newCookie = await openSession(NEW);
  return { ...owned, oldCookie, newCookie, setId };
}

async function nonce(cookie: string, safe: string, owner: string): Promise<RelinkChallenge> {
  const response = await postNonce(req('/api/relink/nonce', { cookie, body: { safe, owner } }));
  expect(response.status).toBe(200);
  return (await response.json()) as RelinkChallenge;
}

const relink = (cookie: string, body: unknown) => postRelink(req('/api/relink', { cookie, body }));

const sign = (account: ReturnType<typeof wallet>['account'], challenge: RelinkChallenge) => account.signTypedData(relinkTypedData(challenge));

async function expectRejected(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'RELINK_REJECTED' });
}

/** Nothing has changed: the wallet stays in the previous account with no relink trail. */
async function expectUnchanged(owner: string, oldCookie: string, newCookie: string): Promise<void> {
  expect((await getShares(req('/api/shares', { method: 'GET', cookie: oldCookie }))).status).toBe(200);
  expect((await getShares(req('/api/shares', { method: 'GET', cookie: newCookie }))).status).toBe(404);
  expect(await listWalletRelinks(owner)).toEqual([]);
}

describe('relink a wallet to another account', () => {
  it('moves the wallet with the owner signature: the previous account loses access and a trail remains', async () => {
    const { account, safe, owner, oldCookie, newCookie, setId } = await setup();
    await postExported(req('/api/shares/exported', { cookie: oldCookie }));
    const challenge = await nonce(newCookie, safe, owner);
    expect(challenge).toMatchObject({ safe, owner, newSub: NEW, issuer: ISSUER, vaultOrigin: ORIGIN });
    expect(challenge.expiresAt).toBeGreaterThan(Date.now() / 1000);

    const signature = await sign(account, challenge);
    const response = await relink(newCookie, { nonce: challenge.nonce, signature });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ address: safe, owner });

    // The new account has it, and share A can still be opened even though it was encrypted with the previous `sub`.
    const shares = await getShares(req('/api/shares', { method: 'GET', cookie: newCookie }));
    expect(shares.status).toBe(200);
    const set = (await shares.json()) as { setId: string; manifest: { userId: string }; exportedAt: string | null };
    expect(set.setId).toBe(setId);
    expect(set.manifest.userId).toBe(OLD);
    expect(set.exportedAt).not.toBeNull();
    const shareA = await getShareA(req(`/api/shares/a?setId=${setId}`, { method: 'GET', cookie: newCookie }));
    expect(shareA.status).toBe(200);

    // The previous one does not: no session, and with a new session it sees nothing either.
    expect(await getSession(oldCookie)).toBeNull();
    expect((await getShares(req('/api/shares', { method: 'GET', cookie: oldCookie }))).status).toBe(401);
    const reopened = await openSession(OLD);
    expect((await getShares(req('/api/shares', { method: 'GET', cookie: reopened }))).status).toBe(404);
    expect((await getShareA(req(`/api/shares/a?setId=${setId}`, { method: 'GET', cookie: reopened }))).status).toBe(404);

    process.env.VAULT_SERVICE_TOKEN = 'service-token';
    const s2s = async (sub: string) => {
      const request = req(`/api/s2s/accounts/${sub}`, { method: 'GET' });
      request.headers.set('authorization', 'Bearer service-token');
      return (await getAccount(request, { params: Promise.resolve({ sub }) })).json();
    };
    expect(await s2s(NEW)).toMatchObject({ exists: true, address: safe, owner });
    expect(await s2s(OLD)).toMatchObject({ exists: false });

    // Persistent trail, without secrets.
    const trail = await listWalletRelinks(owner);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ safe, owner: owner.toLowerCase(), oldSub: OLD, newSub: NEW, issuer: ISSUER, vaultOrigin: ORIGIN, appOrigin: APP_ORIGIN, nonce: challenge.nonce, signature });
    expect(Date.parse(trail[0].linkedAt)).not.toBeNaN();
    expect(JSON.stringify(trail)).not.toMatch(/share|enc[ABC]|mnemonic/i);
  });

  it('a valid JWT without a correct signature does not relink', async () => {
    const { safe, owner, oldCookie, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: `0x${'11'.repeat(65)}` }));
    expect((await relink(newCookie, { nonce: challenge.nonce, signature: 'not hex' })).status).toBe(400);
    expect((await relink(newCookie, { nonce: challenge.nonce })).status).toBe(400);
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('a signature from another key does not relink', async () => {
    const { safe, owner, oldCookie, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: await sign(wallet().account, challenge) }));
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('does not relink without a session or from another origin', async () => {
    const { account, safe, owner, oldCookie, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    const signature = await sign(account, challenge);
    expect((await postRelink(req('/api/relink', { body: { nonce: challenge.nonce, signature } }))).status).toBe(401);
    expect((await postRelink(req('/api/relink', { cookie: newCookie, origin: 'https://other.test', body: { nonce: challenge.nonce, signature } }))).status).toBe(403);
    expect((await postNonce(req('/api/relink/nonce', { body: { safe, owner } }))).status).toBe(401);
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('a reused nonce is rejected', async () => {
    const { account, safe, owner, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    const signature = await sign(account, challenge);
    expect((await relink(newCookie, { nonce: challenge.nonce, signature })).status).toBe(200);
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature }));
    expect(await listWalletRelinks(owner)).toHaveLength(1);
  });

  it('an expired nonce is rejected', async () => {
    const { account, safe, owner, oldCookie, newCookie } = await setup();
    const expiresAt = Math.floor(Date.now() / 1000) - 10;
    const expired = 'expired-nonce';
    await createRelinkNonce({ nonce: expired, userId: NEW, safe, owner, fromUser: OLD, expiresAt: expiresAt * 1000 });
    const challenge: RelinkChallenge = { safe, owner, newSub: NEW, issuer: ISSUER, vaultOrigin: ORIGIN, nonce: expired, expiresAt };
    await expectRejected(await relink(newCookie, { nonce: expired, signature: await sign(account, challenge) }));
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('an unknown or other-account nonce is rejected', async () => {
    const { account, safe, owner, oldCookie, newCookie } = await setup();
    const third = await openSession(THIRD);
    const challenge = await nonce(third, safe, owner);
    // Even if the signature is for this account: the nonce belongs to another.
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: await sign(account, { ...challenge, newSub: NEW }) }));
    await expectRejected(await relink(newCookie, { nonce: 'made-up', signature: await sign(account, { ...challenge, nonce: 'made-up', newSub: NEW }) }));
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('an account that already has a wallet cannot relink another', async () => {
    const { account, safe, owner, oldCookie, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    await activeWallet(newCookie, NEW, wallet().owner);
    // When requesting the nonce, and also when spending it if it got one afterwards.
    const asked = await postNonce(req('/api/relink/nonce', { cookie: newCookie, body: { safe, owner } }));
    expect(asked.status).toBe(409);
    expect(await asked.json()).toEqual({ error: 'WALLET_ALREADY_EXISTS' });
    const response = await relink(newCookie, { nonce: challenge.nonce, signature: await sign(account, challenge) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'WALLET_ALREADY_EXISTS' });
    expect((await getShares(req('/api/shares', { method: 'GET', cookie: oldCookie }))).status).toBe(200);
    expect(await listWalletRelinks(owner)).toEqual([]);
  });

  const altered: [string, (challenge: RelinkChallenge) => RelinkChallenge][] = [
    ['another sub', (challenge) => ({ ...challenge, newSub: THIRD })],
    ['another vault', (challenge) => ({ ...challenge, vaultOrigin: 'https://other-vault.test' })],
    ['another issuer', (challenge) => ({ ...challenge, issuer: 'https://other-login.test' })],
    ['another expiry', (challenge) => ({ ...challenge, expiresAt: challenge.expiresAt + 3600 })],
    ['another nonce', (challenge) => ({ ...challenge, nonce: 'other-nonce' })],
    ['another Safe', (challenge) => ({ ...challenge, safe: smartAccountFor(wallet().owner).address })],
    ['another owner', (challenge) => ({ ...challenge, owner: wallet().owner })],
  ];
  for (const [name, change] of altered) {
    it(`a signature for ${name} is rejected, even if it is from the correct owner`, async () => {
      const { account, safe, owner, oldCookie, newCookie } = await setup();
      const challenge = await nonce(newCookie, safe, owner);
      await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: await sign(account, change(challenge)) }));
      await expectUnchanged(owner, oldCookie, newCookie);
    });
  }

  it('a nonexistent wallet gets a nonce all the same, and its use is rejected without saying why', async () => {
    const { oldCookie, newCookie, owner } = await setup();
    const unknown = wallet();
    const challenge = await nonce(newCookie, unknown.safe, unknown.owner);
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: await sign(unknown.account, challenge) }));
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('a Safe that is not the stored owner\'s does not relink', async () => {
    const { account, owner, oldCookie, newCookie } = await setup();
    const safe = smartAccountFor(wallet().owner).address;
    const challenge = await nonce(newCookie, safe, owner);
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: await sign(account, challenge) }));
    await expectUnchanged(owner, oldCookie, newCookie);
  });

  it('two accounts at once: only one gets the wallet, and the other\'s nonce is no longer valid', async () => {
    const { account, safe, owner, newCookie } = await setup();
    const third = await openSession(THIRD);
    const a = await nonce(newCookie, safe, owner);
    const b = await nonce(third, safe, owner);
    const [signedA, signedB] = await Promise.all([sign(account, a), sign(account, b)]);
    const results = await Promise.all([relink(newCookie, { nonce: a.nonce, signature: signedA }), relink(third, { nonce: b.nonce, signature: signedB })]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 403]);
    expect(await listWalletRelinks(owner)).toHaveLength(1);
    const statuses = await Promise.all([newCookie, third].map(async (cookie) => (await getShares(req('/api/shares', { method: 'GET', cookie }))).status));
    expect(statuses.sort()).toEqual([200, 404]);
  });

  it('the same nonce at once: a single relink', async () => {
    const { account, safe, owner, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    const signature = await sign(account, challenge);
    const results = await Promise.all(Array.from({ length: 8 }, () => relink(newCookie, { nonce: challenge.nonce, signature })));
    expect(results.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(await listWalletRelinks(owner)).toHaveLength(1);
  });

  it('can relink again with a new nonce, and the later rotation is encrypted with the new sub', async () => {
    const { account, safe, owner, newCookie } = await setup();
    const first = await nonce(newCookie, safe, owner);
    expect((await relink(newCookie, { nonce: first.nonce, signature: await sign(account, first) })).status).toBe(200);

    const rotated = await sharesBody(NEW, owner);
    expect((await postShares(req('/api/shares', { cookie: newCookie, body: rotated }))).status).toBe(201);

    const third = await openSession(THIRD);
    const second = await nonce(third, safe, owner);
    expect((await relink(third, { nonce: second.nonce, signature: await sign(account, second) })).status).toBe(200);
    expect((await listWalletRelinks(owner)).map(({ oldSub, newSub }) => [oldSub, newSub])).toEqual([[OLD, NEW], [NEW, THIRD]]);
    expect((await (await getStore()).getActiveSet(THIRD))?.manifest.expectedAddress).toBe(owner);
  });
});

describe('relink limits', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('nonces are limited per account, the same for a wallet that is not in the vault, and another account keeps its budget', async () => {
    const { safe, owner, newCookie } = await setup();
    const third = await openSession(THIRD);
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'relink-nonce': { ip: 1000, sub: 2 } }));
    const unknown = wallet();
    await nonce(newCookie, safe, owner);
    await nonce(newCookie, unknown.safe, unknown.owner);
    await expectRateLimited(await postNonce(req('/api/relink/nonce', { cookie: newCookie, body: { safe, owner } })));
    await expectRateLimited(await postNonce(req('/api/relink/nonce', { cookie: newCookie, body: { safe: unknown.safe, owner: unknown.owner } })));
    await nonce(third, safe, owner);
  });

  it('nonces are limited per IP across accounts', async () => {
    const { safe, owner, newCookie } = await setup();
    const third = await openSession(THIRD);
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'relink-nonce': { ip: 1, sub: 1000 } }));
    await nonce(newCookie, safe, owner);
    await expectRateLimited(await postNonce(req('/api/relink/nonce', { cookie: third, body: { safe, owner } })));
  });

  it('relink attempts are limited per account before the signature is checked, and a refused one spends no nonce', async () => {
    const { account, safe, owner, oldCookie, newCookie } = await setup();
    const challenge = await nonce(newCookie, safe, owner);
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ relink: { ip: 1000, sub: 1 } }));
    await expectRejected(await relink(newCookie, { nonce: challenge.nonce, signature: `0x${'11'.repeat(65)}` }));
    const signature = await sign(account, challenge);
    await expectRateLimited(await relink(newCookie, { nonce: challenge.nonce, signature }));
    await expectUnchanged(owner, oldCookie, newCookie);
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ relink: { ip: 1000, sub: 3 } }));
    expect((await relink(newCookie, { nonce: challenge.nonce, signature })).status).toBe(200);
  });
});
