import { createHandoffToken } from '@wl-embedded-wallet/sdk/server';
import { buildDeploymentOperation, smartAccountFor, toRpcUserOperation } from '@wl-embedded-wallet/core/safe';
import { ed25519 } from '@noble/curves/ed25519.js';
import { combineMnemonic } from '@tetherto/wdk-utils';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as postHandoff } from '../../app/api/auth/handoff/route';
import { POST as postAaRpc } from '../../app/api/aa/rpc/route';
import { GET as getAaStatus } from '../../app/api/aa/status/route';
import { GET as getHealth } from '../../app/api/health/route';
import { GET as getAccount } from '../../app/api/s2s/accounts/[sub]/route';
import { GET as getShareA } from '../../app/api/shares/a/route';
import { POST as postExported } from '../../app/api/shares/exported/route';
import { GET as getShares, PATCH as patchShares, POST as postShares } from '../../app/api/shares/route';
import { hexEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import { verifyManifest } from '@wl-embedded-wallet/core/manifest';
import type { Envelope } from '@wl-embedded-wallet/core/types';
import { sha256Hex, hexDecode } from '@wl-embedded-wallet/core/encoding';
import { SESSION_COOKIE } from '../../server/http';
import { closeDb, createSession, getSession, getUser, setSessionChain, upsertUser } from '../../server/store';
import { resetPostgres } from '../store/postgres-test';
import { startFakeRpc } from './fake-rpc';

const BASE = 'http://vault.test';
const ORIGIN = 'http://vault.test';
const ALICE = 'alice';
const BOB = 'bob';
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const SERVICE_TOKEN = 'service-token';
const ISSUER = 'https://login.test';
const APP_ORIGIN = 'https://app.test';
const SHARE_A = '0102030405060708090a0b0c0d0e0f101112131415';

const handoffKeys = ed25519.keygen();
const manifestKeys = ed25519.keygen();
const HANDOFF_KEY = hexEncode(handoffKeys.secretKey);
const MANIFEST_PUB = hexEncode(manifestKeys.publicKey);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-api-'));
  process.env.MASTER_KEY = hexEncode(randomBytes(32));
  process.env.MANIFEST_SIGNING_KEY = hexEncode(manifestKeys.secretKey);
  process.env.HANDOFF_PUBLIC_KEY = hexEncode(handoffKeys.publicKey);
  process.env.HANDOFF_ISSUER = ISSUER;
  process.env.VAULT_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.ORIGIN = ORIGIN;
});

// `pnpm test:pg` runs this same suite against Postgres.
beforeEach(async () => {
  await closeDb();
  const postgresUrl = process.env.TEST_DATABASE_URL;
  if (postgresUrl) await resetPostgres(postgresUrl);
  process.env.DATABASE_URL = postgresUrl ?? `sqlite:${join(dir, `${crypto.randomUUID()}.db`)}`;
});

afterAll(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

type Options = { method?: string; cookie?: string; origin?: string | null; body?: unknown; authorization?: string; appOrigin?: string | null };

function req(path: string, { method = 'GET', cookie, origin, body, authorization, appOrigin = APP_ORIGIN }: Options = {}) {
  const headers = new Headers();
  const effectiveOrigin = origin === undefined ? (method === 'GET' ? null : ORIGIN) : origin;
  if (effectiveOrigin) headers.set('origin', effectiveOrigin);
  if (cookie) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`);
  if (cookie && appOrigin) headers.set('x-vault-app-origin', appOrigin);
  if (authorization) headers.set('authorization', authorization);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function openSession(userId = ALICE) {
  await upsertUser(userId, `${userId}@example.com`);
  return createSession(userId, { appOrigin: APP_ORIGIN });
}

function envelope(share: 'B' | 'C', kdf: Envelope['kdf'], userId: string, setId: string): Envelope {
  return { v: 1, share, userId, setId, kdf, kdfParams: {}, salt: 'AAAA', iv: 'AAAA', ct: 'AAAA' };
}

async function sharesBody(userId = ALICE, setId: string = crypto.randomUUID(), address = ADDRESS) {
  return {
    setId,
    credentialId: 'Y3JlZA',
    shareA: SHARE_A,
    encB: envelope('B', 'prf-hkdf-sha256', userId, setId),
    encC: envelope('C', 'argon2id', userId, setId),
    shareDigests: { A: await sha256Hex(hexDecode(SHARE_A)), B: 'b'.repeat(64), C: 'c'.repeat(64) },
    expectedAddress: address,
    smartAccount: smartAccountFor(address),
    wdkUtilsVersion: '1.0.0-beta.16',
  };
}

async function createActiveSet(cookie: string, address = ADDRESS, userId = ALICE) {
  const body = await sharesBody(userId, crypto.randomUUID(), address);
  expect((await postShares(req('/api/shares', { method: 'POST', cookie, body }))).status).toBe(201);
  expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: body.setId } }))).status).toBe(200);
  return body.setId;
}

const CLAIMS = { iss: ISSUER, aud: ORIGIN, origin: APP_ORIGIN };
const token = (sub = ALICE, jti?: string) => createHandoffToken({ sub, label: `${sub}@example.com`, jti, ...CLAIMS }, HANDOFF_KEY);

describe('POST /api/auth/handoff', () => {
  it('creates a 15-minute session and a host-only, httpOnly, strict cookie', async () => {
    const response = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: token(), origin: APP_ORIGIN } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: ALICE, label: 'alice@example.com', origin: APP_ORIGIN });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Max-Age=900/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects an already used token', async () => {
    const reused = token();
    expect((await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: reused, origin: APP_ORIGIN } }))).status).toBe(200);
    const replay = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: reused, origin: APP_ORIGIN } }));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'INVALID_TOKEN' });
  });

  it('rejects a token signed with another key, or a malformed one', async () => {
    const other = createHandoffToken({ sub: ALICE, label: 'x', ...CLAIMS }, hexEncode(ed25519.keygen().secretKey));
    expect((await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: other, origin: APP_ORIGIN } }))).status).toBe(401);
    expect((await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: 'nope', origin: APP_ORIGIN } }))).status).toBe(401);
    expect((await postHandoff(req('/api/auth/handoff', { method: 'POST', body: {} }))).status).toBe(401);
  });

  it('a label over 256 characters, or with a control character, is a malformed token: 401 and no user', async () => {
    for (const label of ['a'.repeat(257), 'alice\n@example.com', 'alice\u0000']) {
      const response = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: createHandoffToken({ sub: ALICE, label, ...CLAIMS }, HANDOFF_KEY), origin: APP_ORIGIN } }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'INVALID_TOKEN' });
    }
    expect(await getUser(ALICE)).toBeNull();
    const longest = 'é'.repeat(256);
    const accepted = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: createHandoffToken({ sub: ALICE, label: longest, ...CLAIMS }, HANDOFF_KEY), origin: APP_ORIGIN } }));
    expect(await accepted.json()).toMatchObject({ label: longest });
    expect((await getUser(ALICE))?.label).toBe(longest);
  });

  it('rejects another origin or a missing origin', async () => {
    for (const origin of ['http://app.test', null]) {
      const response = await postHandoff(req('/api/auth/handoff', { method: 'POST', origin, body: { token: token(), origin: APP_ORIGIN } }));
      expect(response.status).toBe(403);
    }
  });

  it('each token opens a new session, closes the previous one and never hands it to another user', async () => {
    const previous = await openSession();
    const same = await postHandoff(req('/api/auth/handoff', { method: 'POST', cookie: previous, body: { token: token(), origin: APP_ORIGIN } }));
    const renewed = same.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    expect(renewed).not.toBe(previous);
    expect(await getSession(previous)).toBeNull();
    expect((await getSession(renewed))?.userId).toBe(ALICE);

    const other = await postHandoff(req('/api/auth/handoff', { method: 'POST', cookie: renewed, body: { token: token(BOB), origin: APP_ORIGIN } }));
    const bob = other.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    expect(await getSession(renewed)).toBeNull();
    expect((await getSession(bob))?.userId).toBe(BOB);
  });
});

describe('GET /api/s2s/accounts/:sub', () => {
  const call = (sub: string, authorization?: string) =>
    getAccount(req(`/api/s2s/accounts/${sub}`, { authorization }), { params: Promise.resolve({ sub }) });

  it('rejects a wrong service token', async () => {
    for (const authorization of [undefined, 'Bearer other', SERVICE_TOKEN, `Basic ${SERVICE_TOKEN}`]) {
      const response = await call(ALICE, authorization);
      expect(response.status).toBe(401);
    }
  });

  it('says whether the account exists, and it only exists once the set is activated', async () => {
    const auth = `Bearer ${SERVICE_TOKEN}`;
    expect(await (await call(ALICE, auth)).json()).toEqual({ exists: false, address: null, owner: null });

    const cookie = await openSession();
    const body = await sharesBody();
    await postShares(req('/api/shares', { method: 'POST', cookie, body }));
    expect(await (await call(ALICE, auth)).json()).toEqual({ exists: false, address: null, owner: null });

    await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: body.setId } }));
    expect(await (await call(ALICE, auth)).json()).toEqual({ exists: true, address: smartAccountFor(ADDRESS).address, owner: ADDRESS });
  });
});

describe('/api/shares', () => {
  it('without a session, 401 on every method', async () => {
    const setId = crypto.randomUUID();
    const body = await sharesBody();
    expect((await postShares(req('/api/shares', { method: 'POST', body }))).status).toBe(401);
    expect((await getShares(req('/api/shares'))).status).toBe(401);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', body: { setId } }))).status).toBe(401);
    expect((await getShareA(req(`/api/shares/a?setId=${setId}`))).status).toBe(401);
    expect((await postExported(req('/api/shares/exported', { method: 'POST' }))).status).toBe(401);
  });

  it('an expired session grants no access', async () => {
    const valid = await openSession();
    const setId = await createActiveSet(valid);
    const cookie = await createSession(ALICE, { ttlMs: -1 });
    const body = await sharesBody();
    expect((await postShares(req('/api/shares', { method: 'POST', cookie, body }))).status).toBe(401);
    expect((await getShares(req('/api/shares', { cookie }))).status).toBe(401);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId } }))).status).toBe(401);
    expect((await getShareA(req(`/api/shares/a?setId=${setId}`, { cookie }))).status).toBe(401);
    expect((await postExported(req('/api/shares/exported', { method: 'POST', cookie }))).status).toBe(401);
  });

  it('the session only works for the origin it was redeemed from', async () => {
    const owner = await openSession();
    const setId = await createActiveSet(owner);
    const url = `/api/shares/a?setId=${setId}`;
    expect((await getShareA(req(url, { cookie: owner }))).status).toBe(200);
    for (const appOrigin of ['https://other.test', null]) {
      const response = await getShareA(req(url, { cookie: owner, appOrigin }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ORIGIN_MISMATCH' });
    }
    // With no registered origin, no request is valid.
    const withoutOrigin = await createSession(ALICE);
    expect((await getShareA(req(url, { cookie: withoutOrigin }))).status).toBe(403);
  });

  it('a token redeemed from another origin gets ORIGIN_MISMATCH and opens no session', async () => {
    const response = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: token(), origin: 'https://other.test' } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ORIGIN_MISMATCH' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('redeeming a token is enough to receive share A: that is the accepted risk, and on its own it is useless', async () => {
    const owner = await openSession();
    const setId = await createActiveSet(owner);
    const exchanged = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: token(), origin: APP_ORIGIN } }));
    const cookie = exchanged.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    const response = await getShareA(req(`/api/shares/a?setId=${setId}`, { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shareA: SHARE_A });
    await expect(combineMnemonic([SHARE_A])).rejects.toThrow();
  });

  it('another origin gets 403, on reads too', async () => {
    const cookie = await openSession();
    const setId = await createActiveSet(cookie);
    const origin = 'http://app.test';
    const body = await sharesBody();
    expect((await postShares(req('/api/shares', { method: 'POST', cookie, origin, body }))).status).toBe(403);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, origin, body: { setId } }))).status).toBe(403);
    expect((await getShares(req('/api/shares', { cookie, origin }))).status).toBe(403);
    expect((await getShareA(req(`/api/shares/a?setId=${setId}`, { cookie, origin }))).status).toBe(403);
    expect((await postExported(req('/api/shares/exported', { method: 'POST', cookie, origin }))).status).toBe(403);
  });

  it('creates a pending set with the signed manifest and A encrypted', async () => {
    const cookie = await openSession();
    const body = await sharesBody();
    const response = await postShares(req('/api/shares', { method: 'POST', cookie, body }));
    expect(response.status).toBe(201);
    const signed = await response.json();
    expect(() => verifyManifest(signed, MANIFEST_PUB)).not.toThrow();
    expect(signed.manifest).toMatchObject({ userId: ALICE, setId: body.setId, expectedAddress: ADDRESS, n: 3, k: 2 });

    const read = await getShares(req(`/api/shares?setId=${body.setId}`, { cookie }));
    const set = await read.json();
    expect(set.status).toBe('pending');
    expect(set).not.toHaveProperty('encA');
    expect(JSON.stringify(set)).not.toContain(SHARE_A);

    expect(await (await getShareA(req(`/api/shares/a?setId=${body.setId}`, { cookie }))).json()).toEqual({ shareA: SHARE_A });
  });

  it('with a different MASTER_KEY it does not hand out share A, and the error says so without revealing anything', async () => {
    const cookie = await openSession();
    const body = await sharesBody();
    await postShares(req('/api/shares', { method: 'POST', cookie, body }));

    const original = process.env.MASTER_KEY;
    const other = hexEncode(randomBytes(32));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.MASTER_KEY = other;
    try {
      const response = await getShareA(req(`/api/shares/a?setId=${body.setId}`, { cookie }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'SERVER_KEY_MISMATCH' });
      const output = JSON.stringify(logged.mock.calls);
      expect(output).toContain('MASTER_KEY');
      expect(output).not.toContain(other);
      expect(output).not.toContain(original);
    } finally {
      process.env.MASTER_KEY = original;
      logged.mockRestore();
    }
  });

  it('validates the body, the envelopes and the digest of A', async () => {
    const cookie = await openSession();
    const post = async (body: unknown) => (await postShares(req('/api/shares', { method: 'POST', cookie, body }))).status;
    const body = await sharesBody();
    expect(await post({ ...body, setId: 'nope' })).toBe(400);
    expect(await post({ ...body, expectedAddress: '0x12' })).toBe(400);
    expect(await post({ ...body, shareA: 'zz' })).toBe(400);
    expect(await post({ ...body, encB: { ...body.encB, kdf: 'argon2id' } })).toBe(400);
    expect(await post({ ...body, encB: { ...body.encB, userId: BOB } })).toBe(400);
    expect(await post({ ...body, encC: { ...body.encC, setId: crypto.randomUUID() } })).toBe(400);
    expect(await post({ ...body, shareDigests: { ...body.shareDigests, A: 'a'.repeat(64) } })).toBe(400);
    expect(await post(body)).toBe(201);
    expect(await post(body)).toBe(409);
  });

  it('does not allow replacing an active wallet with another address', async () => {
    const cookie = await openSession();
    await createActiveSet(cookie);
    const response = await postShares(req('/api/shares', { method: 'POST', cookie, body: await sharesBody(ALICE, crypto.randomUUID(), OTHER_ADDRESS) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'WALLET_ALREADY_EXISTS' });
  });

  it('another user\'s set does not exist for this user', async () => {
    const alice = await openSession(ALICE);
    const setId = await createActiveSet(alice);
    const bob = await openSession(BOB);
    expect((await getShares(req(`/api/shares?setId=${setId}`, { cookie: bob }))).status).toBe(404);
    expect((await getShareA(req(`/api/shares/a?setId=${setId}`, { cookie: bob }))).status).toBe(404);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie: bob, body: { setId } }))).status).toBe(404);
    expect((await getShares(req('/api/shares', { cookie: alice }))).status).toBe(200);
  });

  it('activating revokes the previous set and deletes its material, and a revoked set gets 410', async () => {
    const cookie = await openSession();
    const first = await createActiveSet(cookie);
    expect((await (await getShares(req('/api/shares', { cookie }))).json()).setId).toBe(first);

    const next = await sharesBody();
    expect((await postShares(req('/api/shares', { method: 'POST', cookie, body: next }))).status).toBe(201);
    // Until the drill, the active set is still the previous one.
    expect((await (await getShares(req('/api/shares', { cookie }))).json()).setId).toBe(first);
    expect((await getShareA(req(`/api/shares/a?setId=${first}`, { cookie }))).status).toBe(200);

    const activated = await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: next.setId } }));
    expect(await activated.json()).toEqual({ status: 'active' });
    expect((await (await getShares(req('/api/shares', { cookie }))).json()).setId).toBe(next.setId);

    expect((await getShares(req(`/api/shares?setId=${first}`, { cookie }))).status).toBe(410);
    expect((await getShareA(req(`/api/shares/a?setId=${first}`, { cookie }))).status).toBe(410);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: first } }))).status).toBe(410);
  });

  it('validates the setId and responds 404 if it does not exist', async () => {
    const cookie = await openSession();
    expect((await getShareA(req('/api/shares/a', { cookie }))).status).toBe(400);
    expect((await getShares(req('/api/shares?setId=nope', { cookie }))).status).toBe(400);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: 'nope' } }))).status).toBe(400);
    expect((await getShareA(req(`/api/shares/a?setId=${crypto.randomUUID()}`, { cookie }))).status).toBe(404);
  });

  it('every response is no-store and without CORS', async () => {
    const cookie = await openSession();
    const setId = await createActiveSet(cookie);
    const response = await getShareA(req(`/api/shares/a?setId=${setId}`, { cookie }));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /api/shares/exported', () => {
  it('stores the date without any seed data, and GET returns it', async () => {
    const cookie = await openSession();
    await createActiveSet(cookie);
    expect((await (await getShares(req('/api/shares', { cookie }))).json()).exportedAt).toBeNull();

    const response = await postExported(req('/api/shares/exported', { method: 'POST', cookie }));
    expect(response.status).toBe(200);
    const { exportedAt } = await response.json();
    expect(new Date(exportedAt).toISOString()).toBe(exportedAt);
    expect((await getUser(ALICE))?.exportedAt).toBe(exportedAt);
    expect((await (await getShares(req('/api/shares', { cookie }))).json()).exportedAt).toBe(exportedAt);
  });
});

describe('session network', () => {
  const CHAIN = 31001;
  const chainToken = (chainId: number, rpcUrl?: string, sub = ALICE) =>
    createHandoffToken({ sub, label: `${sub}@example.com`, ...CLAIMS, chain: { chainId, ...(rpcUrl ? { rpcUrl } : {}) } }, HANDOFF_KEY);

  it('the chainId of the popup request must match the token\'s', async () => {
    const mismatch = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: chainToken(CHAIN), chainId: CHAIN + 1, origin: APP_ORIGIN } }));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: 'CHAIN_REQUEST_MISMATCH' });
    const missing = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: chainToken(CHAIN), origin: APP_ORIGIN } }));
    expect(missing.status).toBe(400);
    const ok = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: chainToken(CHAIN), chainId: CHAIN, origin: APP_ORIGIN } }));
    expect(ok.status).toBe(200);
  });

  it('a token refused for CHAIN_REQUEST_MISMATCH is not spent: it then redeems with the right chainId, once', async () => {
    const pending = chainToken(CHAIN);
    for (const chainId of [CHAIN + 1, undefined, null, String(CHAIN)]) {
      const refused = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: pending, chainId, origin: APP_ORIGIN } }));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'CHAIN_REQUEST_MISMATCH' });
      expect(refused.headers.get('set-cookie')).toBeNull();
    }
    expect(await getUser(ALICE)).toBeNull();
    const redeemed = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: pending, chainId: CHAIN, origin: APP_ORIGIN } }));
    expect(redeemed.status).toBe(200);
    const cookie = redeemed.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    expect((await getSession(cookie))?.chain).toEqual({ chainId: CHAIN, rpcUrl: null });
    const replay = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: pending, chainId: CHAIN, origin: APP_ORIGIN } }));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'INVALID_TOKEN' });
  });

  it('concurrent redemptions of one token open a single session, even after a refused one', async () => {
    const shared = chainToken(CHAIN);
    expect((await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: shared, chainId: CHAIN + 1, origin: APP_ORIGIN } }))).status).toBe(400);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: shared, chainId: CHAIN, origin: APP_ORIGIN } }))),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([200, 401, 401, 401, 401, 401, 401, 401]);
  });

  it('a popup with a network is not accepted with a token without one', async () => {
    const response = await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: token(), chainId: CHAIN, origin: APP_ORIGIN } }));
    expect(await response.json()).toEqual({ error: 'CHAIN_REQUEST_MISMATCH' });
  });
});

describe('network API and bundler/paymaster proxy', () => {
  const CHAIN = 31001;
  const safe = smartAccountFor(ADDRESS);
  const addressWord = `0x${safe.address.slice(2).toLowerCase().padStart(64, '0')}`;
  const operation = toRpcUserOperation(buildDeploymentOperation(ADDRESS, { maxFeePerGas: '10', maxPriorityFeePerGas: '1' }));
  let node: Awaited<ReturnType<typeof startFakeRpc>>;
  let bundler: Awaited<ReturnType<typeof startFakeRpc>>;
  let paymaster: Awaited<ReturnType<typeof startFakeRpc>>;
  let cookie: string;
  const rpcCall = (method: string, params: unknown[], options: Options = {}) =>
    postAaRpc(req('/api/aa/rpc', { method: 'POST', cookie, body: { method, params }, ...options }));

  beforeEach(async () => {
    node = await startFakeRpc(CHAIN, { eth_maxPriorityFeePerGas: () => '0x1' });
    node.state.code[safe.address.toLowerCase()] = '0x';
    node.state.callResult = addressWord;
    bundler = await startFakeRpc(CHAIN, { eth_sendUserOperation: () => '0xhash', eth_estimateUserOperationGas: () => ({ callGasLimit: '0x1' }) });
    paymaster = await startFakeRpc(CHAIN, { pm_getPaymasterData: () => ({ paymaster: '0xpm' }) });
    process.env.RPC_ALLOWED_HOSTS = '127.0.0.1';
    process.env.AA_CHAINS = JSON.stringify({
      [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url, paymasterHeaders: { 'x-key': 'k' }, paymasterContext: { sponsorshipPolicyId: 'server' } },
    });
    cookie = await openSession();
    await createActiveSet(cookie);
    await setSessionChain(cookie, { chainId: CHAIN, rpcUrl: node.url });
  });

  afterEach(async () => {
    await Promise.all([node.close(), bundler.close(), paymaster.close()]);
    delete process.env.AA_CHAINS;
    delete process.env.RPC_ALLOWED_HOSTS;
  });

  it('the status is that of the session network', async () => {
    const response = await getAaStatus(req('/api/aa/status', { cookie }));
    expect(await response.json()).toMatchObject({ chainId: CHAIN, deployed: false, deployable: true, sponsored: true });
  });

  it('without a network in the session, CHAIN_NOT_SUPPORTED', async () => {
    await setSessionChain(cookie, null);
    const response = await getAaStatus(req('/api/aa/status', { cookie }));
    expect(await response.json()).toEqual({ error: 'CHAIN_NOT_SUPPORTED' });
    expect(await (await rpcCall('vault_prepareDeployment', [])).json()).toEqual({ error: 'CHAIN_NOT_SUPPORTED' });
  });

  it('an RPC for another network gets CHAIN_MISMATCH', async () => {
    node.state.chainId = CHAIN + 1;
    expect(await (await getAaStatus(req('/api/aa/status', { cookie }))).json()).toEqual({ error: 'CHAIN_MISMATCH' });
    expect(await (await rpcCall('vault_prepareDeployment', [])).json()).toEqual({ error: 'CHAIN_MISMATCH' });
  });

  it('a host outside the list is rejected without connecting', async () => {
    process.env.RPC_ALLOWED_HOSTS = 'other.test';
    const before = node.calls.length;
    expect(await (await getAaStatus(req('/api/aa/status', { cookie }))).json()).toEqual({ error: 'CHAIN_NOT_SUPPORTED' });
    expect(node.calls.length).toBe(before);
  });

  it('without a valid session nothing goes through', async () => {
    expect((await rpcCall('vault_prepareDeployment', [], { cookie: undefined })).status).toBe(401);
    expect((await rpcCall('vault_prepareDeployment', [], { cookie: await createSession(ALICE, { ttlMs: -1 }) })).status).toBe(401);
    expect((await rpcCall('vault_prepareDeployment', [], { origin: 'http://other.test' })).status).toBe(403);
    expect((await rpcCall('eth_sendUserOperation', [operation, safe.entryPoint], { origin: 'http://other.test' })).status).toBe(403);
    expect(bundler.calls).toHaveLength(0);
    expect(paymaster.calls).toHaveLength(0);
  });

  it.each(['eth_sendRawTransaction', 'eth_call', 'debug_traceCall', 'anvil_setBalance', 'pm_sponsorUserOperation', 'eth_getLogs'])('allowlist: %s does not go through', async (method) => {
    expect((await rpcCall(method, [])).status).toBe(403);
    expect(node.calls.concat(bundler.calls, paymaster.calls).some((call) => call.method === method)).toBe(false);
  });

  it('only the deployment of this session\'s Safe goes through', async () => {
    const other = toRpcUserOperation(buildDeploymentOperation(OTHER_ADDRESS, { maxFeePerGas: '10', maxPriorityFeePerGas: '1' }));
    const response = await rpcCall('eth_sendUserOperation', [other, safe.entryPoint]);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'OPERATION_NOT_ALLOWED' });
    const drain = { ...operation, callData: '0xdeadbeef' };
    expect((await rpcCall('eth_sendUserOperation', [drain, safe.entryPoint])).status).toBe(403);
    expect(bundler.calls).toHaveLength(0);
    expect(paymaster.calls).toHaveLength(0);
  });

  it('validates the EntryPoint', async () => {
    expect((await rpcCall('eth_sendUserOperation', [operation, ADDRESS])).status).toBe(400);
    expect(bundler.calls).toHaveLength(0);
  });

  it('the browser cannot reach the paymaster, so it cannot choose the sponsorship context', async () => {
    const response = await rpcCall('pm_getPaymasterData', [operation, safe.entryPoint, `0x${CHAIN.toString(16)}`, { sponsorshipPolicyId: 'chosen-by-xss' }]);
    expect(await response.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    expect(paymaster.calls).toHaveLength(0);
  });

  it('an already deployed Safe spends no more sponsorship', async () => {
    node.state.code[safe.address.toLowerCase()] = '0x60';
    const response = await rpcCall('vault_prepareDeployment', []);
    expect(await response.json()).toEqual({ error: 'ALREADY_DEPLOYED' });
    expect(paymaster.calls).toHaveLength(0);
  });

  it('a network without a bundler says so clearly', async () => {
    process.env.AA_CHAINS = '{}';
    expect(await (await rpcCall('vault_prepareDeployment', [])).json()).toEqual({ error: 'CHAIN_NOT_SUPPORTED' });
    expect(await (await rpcCall('eth_sendUserOperation', [operation, safe.entryPoint])).json()).toEqual({ error: 'CHAIN_NOT_SUPPORTED' });
  });

  it('a provider error does not leak its URL', async () => {
    process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: 'http://127.0.0.1:1/secret-key' } });
    const response = await rpcCall('vault_prepareDeployment', []);
    const text = await response.text();
    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('127.0.0.1:1');
    expect(JSON.parse(text)).toEqual({ error: 'CHAIN_UNAVAILABLE' });
  });

  it('s2s: without chainId it does not query the network, and with chainId deployment is per network', async () => {
    const auth = `Bearer ${SERVICE_TOKEN}`;
    const account = (query: string) => getAccount(req(`/api/s2s/accounts/${ALICE}${query}`, { authorization: auth }), { params: Promise.resolve({ sub: ALICE }) });
    expect(await (await account('')).json()).toEqual({ exists: true, address: safe.address, owner: ADDRESS });
    expect(await (await account(`?chainId=${CHAIN}&rpcUrl=${encodeURIComponent(node.url)}`)).json()).toMatchObject({ exists: true, chainId: CHAIN, deployed: false, deployable: true, sponsored: true, transactionsSponsored: false });
    node.state.code[safe.address.toLowerCase()] = '0x60';
    expect(await (await account(`?chainId=${CHAIN}&rpcUrl=${encodeURIComponent(node.url)}`)).json()).toMatchObject({ deployed: true, transactionsSponsored: false });
    // Transactions are sponsored only where the chain opts in.
    process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url, paymasterUrl: paymaster.url, sponsorTransactions: true } });
    expect(await (await account(`?chainId=${CHAIN}&rpcUrl=${encodeURIComponent(node.url)}`)).json()).toMatchObject({ deployed: true, sponsored: true, transactionsSponsored: true });
    process.env.AA_CHAINS = JSON.stringify({ [CHAIN]: { bundlerUrl: bundler.url } });
    expect(await (await account(`?chainId=${CHAIN}&rpcUrl=${encodeURIComponent(node.url)}`)).json()).toMatchObject({ sponsored: false, transactionsSponsored: false });
    expect(await (await account(`?chainId=${CHAIN}&rpcUrl=${encodeURIComponent('https://outside.test')}`)).json()).toMatchObject({ deployed: null, chainError: 'CHAIN_NOT_SUPPORTED' });
    expect((await account('?chainId=abc')).status).toBe(400);
  });
});

describe('Safe in POST /api/shares', () => {
  it('rejects a Safe that is not the owner\'s', async () => {
    const cookie = await openSession();
    const body = await sharesBody();
    const wrong = { ...body, smartAccount: { ...body.smartAccount, address: OTHER_ADDRESS } };
    const response = await postShares(req('/api/shares', { method: 'POST', cookie, body: wrong }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'SMART_ACCOUNT_MISMATCH' });
  });

  it('a rotation keeps the signed parameters of the existing wallet', async () => {
    const cookie = await openSession();
    await createActiveSet(cookie);
    const body = await sharesBody();
    const altered = { ...body, smartAccount: { ...body.smartAccount, saltNonce: '0x01' } };
    expect((await postShares(req('/api/shares', { method: 'POST', cookie, body: altered }))).status).toBe(400);
    expect((await postShares(req('/api/shares', { method: 'POST', cookie, body }))).status).toBe(201);
  });
});

describe('no sensitive material in logs', () => {
  const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

  beforeEach(() => {
    for (const method of METHODS) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes write nothing to the console', async () => {
    const cookie = await openSession();
    const setId = await createActiveSet(cookie);
    await getShareA(req(`/api/shares/a?setId=${setId}`, { cookie }));
    await postHandoff(req('/api/auth/handoff', { method: 'POST', body: { token: 'nope', origin: APP_ORIGIN } }));
    for (const method of METHODS) expect(console[method]).not.toHaveBeenCalled();
  });
});

describe('/api/health', () => {
  it('responds ok with the database available and 503 without it, without revealing the reason', async () => {
    const healthy = await getHealth();
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: 'ok' });

    await closeDb();
    process.env.DATABASE_URL = 'mysql://user:secret@db.test/vault';
    const down = await getHealth();
    expect(down.status).toBe(503);
    expect(await down.text()).toBe(JSON.stringify({ status: 'unavailable' }));
    await closeDb();
  });
});
