import { buildManifest } from '@wl-embedded-wallet/core/manifest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as getShareA } from '../../app/api/shares/a/route';
import { PATCH as patchShares, POST as postShares } from '../../app/api/shares/route';
import { sessionHash } from '../../server/http';
import { sealShareA } from '../../server/kms';
import { createSession, createSet, getSet, getStore, listShareAReleases, SESSION_TTL_MS, upsertUser } from '../../server/store';
import { activeWallet, APP_ORIGIN, expectRateLimited, openSession, req, SHARE_A, sharesBody, useRouteEnv } from './route-harness';

const ALICE = 'alice';
const BOB = 'bob';
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

useRouteEnv();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const shareA = (cookie: string, setId: string) => getShareA(req(`/api/shares/a?setId=${setId}`, { method: 'GET', cookie }));

/** What enrollment does: `POST /api/shares` in this session, which leaves the set `pending` until the drill. */
async function pendingSet(cookie: string, userId = ALICE, address = ADDRESS): Promise<string> {
  const body = await sharesBody(userId, address);
  expect((await postShares(req('/api/shares', { cookie, body }))).status).toBe(201);
  return body.setId;
}

async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
}

describe('GET /api/shares/a of a pending set', () => {
  it('the session that created it gets A: the enrollment drill', async () => {
    const cookie = await openSession(ALICE);
    const setId = await pendingSet(cookie);
    expect((await getSet(ALICE, setId))?.createdSessionHash).toBe(sessionHash(cookie));
    const response = await shareA(cookie, setId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shareA: SHARE_A });
    // The drill then activates it.
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId } }))).status).toBe(200);
  });

  it('another session of the same user gets NOT_FOUND, as if it did not exist, until it is active', async () => {
    const creator = await openSession(ALICE);
    const setId = await pendingSet(creator);
    const other = await openSession(ALICE);
    await expectNotFound(await shareA(other, setId));
    // The same answer as a set that does not exist.
    await expectNotFound(await shareA(other, crypto.randomUUID()));
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie: other, body: { setId } }))).status).toBe(200);
    expect(await (await shareA(other, setId)).json()).toEqual({ shareA: SHARE_A });
  });

  it('a rotation in progress: the active set is still released to any session, the new pending one only to its creator', async () => {
    const first = await openSession(ALICE);
    const active = await activeWallet(first, ALICE, ADDRESS);
    const rotating = await openSession(ALICE);
    const pending = await pendingSet(rotating);
    const third = await openSession(ALICE);
    expect((await shareA(third, active)).status).toBe(200);
    await expectNotFound(await shareA(third, pending));
    expect((await shareA(rotating, pending)).status).toBe(200);
  });

  it('is refused once the set is older than a session lifetime, even to its creator', async () => {
    // A session longer than any real one, to reach the limit of the set alone.
    await upsertUser(ALICE, 'alice@example.com');
    const cookie = await createSession(ALICE, { appOrigin: APP_ORIGIN, ttlMs: 3 * SESSION_TTL_MS });
    const setId = await pendingSet(cookie);
    const createdAt = Date.parse((await getSet(ALICE, setId))!.createdAt);
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + SESSION_TTL_MS - 1000);
    expect((await shareA(cookie, setId)).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + SESSION_TTL_MS);
    await expectNotFound(await shareA(cookie, setId));
  });

  it('a pending set without a recorded session (created before migration 6) is never released while pending', async () => {
    const cookie = await openSession(ALICE);
    const body = await sharesBody(ALICE, ADDRESS);
    const manifest = buildManifest({ userId: ALICE, setId: body.setId, shareDigests: body.shareDigests, expectedAddress: ADDRESS, wdkUtilsVersion: body.wdkUtilsVersion });
    await createSet({
      setId: body.setId,
      userId: ALICE,
      credentialId: body.credentialId,
      manifest,
      signature: 'legacy',
      createdAt: manifest.createdAt,
      encA: await sealShareA(SHARE_A, { userId: ALICE, setId: body.setId }),
      encB: body.encB,
      encC: body.encC,
    });
    expect((await getSet(ALICE, body.setId))?.createdSessionHash).toBeUndefined();
    await expectNotFound(await shareA(cookie, body.setId));
    // The set itself is fine: once active, A is released.
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: body.setId } }))).status).toBe(200);
    expect(await (await shareA(cookie, body.setId)).json()).toEqual({ shareA: SHARE_A });
  });

  it('another user never gets it, pending or active', async () => {
    const alice = await openSession(ALICE);
    const setId = await pendingSet(alice);
    const bob = await openSession(BOB);
    await expectNotFound(await shareA(bob, setId));
    await patchShares(req('/api/shares', { method: 'PATCH', cookie: alice, body: { setId } }));
    await expectNotFound(await shareA(bob, setId));
  });
});

describe('share A release audit', () => {
  it('records each release, with no share and no session token', async () => {
    const cookie = await openSession(ALICE);
    const setId = await pendingSet(cookie);
    const before = Date.now();
    expect((await shareA(cookie, setId)).status).toBe(200);
    await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId } }));
    const later = await openSession(ALICE);
    expect((await shareA(later, setId)).status).toBe(200);

    const rows = await listShareAReleases(ALICE);
    expect(rows).toEqual([
      { userId: ALICE, setId, setStatus: 'pending', sessionHash: sessionHash(cookie), appOrigin: APP_ORIGIN, releasedAt: expect.any(String) },
      { userId: ALICE, setId, setStatus: 'active', sessionHash: sessionHash(later), appOrigin: APP_ORIGIN, releasedAt: expect.any(String) },
    ]);
    for (const row of rows) {
      expect(new Date(row.releasedAt).toISOString()).toBe(row.releasedAt);
      expect(Date.parse(row.releasedAt)).toBeGreaterThanOrEqual(before - 1000);
    }
    const stored = JSON.stringify(rows);
    for (const secret of [SHARE_A, cookie, later]) expect(stored).not.toContain(secret);
  });

  it('a refused request records nothing', async () => {
    const creator = await openSession(ALICE);
    const setId = await pendingSet(creator);
    const other = await openSession(ALICE);
    await expectNotFound(await shareA(other, setId));
    await expectNotFound(await shareA(other, crypto.randomUUID()));
    expect((await shareA(other, 'nope')).status).toBe(400);
    expect(await listShareAReleases(ALICE)).toEqual([]);
  });

  it('a release that cannot be recorded does not happen', async () => {
    const cookie = await openSession(ALICE);
    const setId = await activeWallet(cookie, ALICE, ADDRESS);
    vi.spyOn(await getStore(), 'recordShareARelease').mockRejectedValue(new Error('database down'));
    await expect(shareA(cookie, setId)).rejects.toThrow('database down');
  });
});

describe('share A release budget', () => {
  it('per session: over the limit, 429 for that session only', async () => {
    vi.stubEnv('SHARE_A_MAX_PER_SESSION', '2');
    const cookie = await openSession(ALICE);
    const setId = await activeWallet(cookie, ALICE, ADDRESS);
    expect((await shareA(cookie, setId)).status).toBe(200);
    expect((await shareA(cookie, setId)).status).toBe(200);
    await expectRateLimited(await shareA(cookie, setId));
    expect((await shareA(await openSession(ALICE), setId)).status).toBe(200);
    expect(await listShareAReleases(ALICE)).toHaveLength(3);
  });

  it('per user: across sessions, and another user keeps their own budget', async () => {
    vi.stubEnv('SHARE_A_MAX_PER_USER', '3');
    const first = await openSession(ALICE);
    const setId = await activeWallet(first, ALICE, ADDRESS);
    const second = await openSession(ALICE);
    expect((await shareA(first, setId)).status).toBe(200);
    expect((await shareA(first, setId)).status).toBe(200);
    expect((await shareA(second, setId)).status).toBe(200);
    await expectRateLimited(await shareA(second, setId));
    await expectRateLimited(await shareA(await openSession(ALICE), setId));

    const bob = await openSession(BOB);
    const bobSet = await activeWallet(bob, BOB, OTHER_ADDRESS);
    expect((await shareA(bob, bobSet)).status).toBe(200);
  });

  it('is counted before the lookup: a missing or refused set spends it too, and over it every set gets the same answer', async () => {
    vi.stubEnv('SHARE_A_MAX_PER_SESSION', '2');
    const creator = await openSession(ALICE);
    const pending = await pendingSet(creator);
    const cookie = await openSession(ALICE);
    await expectNotFound(await shareA(cookie, crypto.randomUUID()));
    await expectNotFound(await shareA(cookie, pending));
    await expectRateLimited(await shareA(cookie, crypto.randomUUID()));
    await expectRateLimited(await shareA(cookie, pending));
    expect(await listShareAReleases(ALICE)).toEqual([]);
  });

  it('the general share-a limit applies too, per user', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'share-a': { sub: 1 } }));
    const cookie = await openSession(ALICE);
    const setId = await activeWallet(cookie, ALICE, ADDRESS);
    expect((await shareA(cookie, setId)).status).toBe(200);
    await expectRateLimited(await shareA(await openSession(ALICE), setId));
  });
});
