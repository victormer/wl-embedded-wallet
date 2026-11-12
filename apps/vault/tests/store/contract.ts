import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smartAccountFor } from '@wl-embedded-wallet/core/safe';
import { buildManifest } from '@wl-embedded-wallet/core/manifest';
import type { Envelope } from '@wl-embedded-wallet/core/types';
import { openDriver, openStore, type VaultStore } from '../../server/store';
import { migrate } from '../../server/store/migrate';
import { MIGRATIONS } from '../../server/store/migrations';

const USER = 'alice';
const BOB = 'bob';
const SET_1 = '11111111-1111-4111-8111-111111111111';
const SET_2 = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const CONCURRENCY = 16;
const ROUNDS = 8;

const envelope = { ct: 'x' } as Envelope;

function setRecord(setId: string, userId = USER, expectedAddress = ADDRESS) {
  return {
    setId,
    userId,
    credentialId: 'cred',
    manifest: buildManifest({ userId, setId, shareDigests: { A: 'a', B: 'b', C: 'c' }, expectedAddress, wdkUtilsVersion: 'x' }),
    signature: 'sig',
    createdAt: new Date().toISOString(),
    encA: envelope,
    encB: envelope,
    encC: envelope,
  };
}

/** The same suite for both adapters. `freshUrl` returns an empty database. */
export function storeContract(name: string, freshUrl: () => Promise<string>): void {
  describe(`store ${name}`, () => {
    let url: string;
    let store: VaultStore;
    // Another connection to the same database, like another replica.
    let replica: VaultStore;

    beforeEach(async () => {
      url = await freshUrl();
      store = await openStore(url);
      replica = await openStore(url);
      await store.upsertUser(USER, 'alice@example.com');
      await store.upsertUser(BOB, 'bob@example.com');
    });

    afterEach(async () => {
      await store.close();
      await replica.close();
    });

    describe('users', () => {
      it('creates and updates the label', async () => {
        await store.upsertUser(USER, 'new@example.com');
        expect(await store.getUser(USER)).toEqual({ userId: USER, label: 'new@example.com', exportedAt: null });
        expect(await store.getUser('nobody')).toBeNull();
      });

      it('marks the export', async () => {
        const exportedAt = new Date().toISOString();
        expect(await store.markExported(USER, exportedAt)).toBe(true);
        expect((await store.getUser(USER))?.exportedAt).toBe(exportedAt);
        expect(await store.markExported('nobody', exportedAt)).toBe(false);
      });
    });

    describe('sessions', () => {
      it('creates a valid session, without a chain', async () => {
        const token = await store.createSession(USER);
        expect(await store.getSession(token)).toMatchObject({ userId: USER, chain: null, appOrigin: null });
        const withOrigin = await store.createSession(USER, { appOrigin: 'https://app.test' });
        expect((await store.getSession(withOrigin))?.appOrigin).toBe('https://app.test');
      });

      it('an expired, nonexistent or deleted session is not valid', async () => {
        const expired = await store.createSession(USER, { ttlMs: -1 });
        expect(await store.getSession(expired)).toBeNull();
        expect(await store.getSession('nothing')).toBeNull();
        expect(await store.getSession(undefined)).toBeNull();
        const token = await store.createSession(USER);
        await store.deleteSession(token);
        expect(await store.getSession(token)).toBeNull();
      });

      it('does not allow a session for a nonexistent user', async () => {
        await expect(store.createSession('nobody')).rejects.toThrow();
      });

      it('stores the chain, with a chainId and an expiry wider than 32 bits', async () => {
        const token = await store.createSession(USER);
        const chainId = 2 ** 40;
        await store.setSessionChain(token, { chainId, rpcUrl: 'https://rpc.test' });
        const session = await store.getSession(token);
        expect(session?.chain).toEqual({ chainId, rpcUrl: 'https://rpc.test' });
        expect(session?.expiresAt).toBeGreaterThan(Date.now());
        await store.setSessionChain(token, null);
        expect((await store.getSession(token))?.chain).toBeNull();
      });
    });

    describe('jti', () => {
      it('is consumed only once and purged on expiry', async () => {
        const future = Date.now() + 60_000;
        expect(await store.consumeJti('one', future)).toBe(true);
        expect(await store.consumeJti('one', future)).toBe(false);
        expect(await store.consumeJti('two', future)).toBe(true);
        expect(await store.consumeJti('three', Date.now() - 1)).toBe(true);
        expect(await store.consumeJti('four', future)).toBe(true);
        expect(await store.consumeJti('three', future)).toBe(true);
        expect(await store.consumeJti('one', future)).toBe(false);
      });
    });

    describe('sets', () => {
      it('a set starts pending and is only active after activation', async () => {
        await store.createSet(setRecord(SET_1));
        const pending = await store.getSet(USER, SET_1);
        expect(pending?.status).toBe('pending');
        expect(pending?.encB).toEqual(envelope);
        expect(pending?.manifest.expectedAddress).toBe(ADDRESS);
        expect(await store.getActiveSet(USER)).toBeNull();
        expect(await store.getAccount(USER)).toEqual({ exists: false, address: null, owner: null });
        expect((await store.activateSet(USER, SET_1))?.status).toBe('active');
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_1);
        expect(await store.getAccount(USER)).toMatchObject({ exists: true, owner: ADDRESS });
      });

      it('activating revokes the previous one and deletes its material; a pending set does not touch the active one', async () => {
        await store.createSet(setRecord(SET_1));
        await store.activateSet(USER, SET_1);
        await store.createSet(setRecord(SET_2));
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_1);

        await store.activateSet(USER, SET_2);
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_2);
        const old = await store.getSet(USER, SET_1);
        expect(old?.status).toBe('revoked');
        expect(old).not.toHaveProperty('encA');
        expect(old).not.toHaveProperty('encB');
        expect(old).not.toHaveProperty('encC');
        expect(old?.manifest.setId).toBe(SET_1);
        expect((await store.activateSet(USER, SET_1))?.status).toBe('revoked');
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_2);
      });

      it('activating twice is idempotent', async () => {
        await store.createSet(setRecord(SET_1));
        await store.activateSet(USER, SET_1);
        expect((await store.activateSet(USER, SET_1))?.status).toBe('active');
      });

      it('does not replace the active wallet with a set for another address', async () => {
        await store.createSet(setRecord(SET_1));
        await store.createSet(setRecord(SET_2, USER, OTHER_ADDRESS));
        await store.activateSet(USER, SET_1);
        expect((await store.activateSet(USER, SET_2))?.status).toBe('pending');
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_1);
      });

      it('a user neither sees nor activates another user\'s sets, and does not revoke theirs', async () => {
        await store.createSet(setRecord(SET_1));
        await store.activateSet(USER, SET_1);
        await store.createSet(setRecord(SET_2, BOB));
        expect(await store.getSet(BOB, SET_1)).toBeNull();
        expect(await store.activateSet(BOB, SET_1)).toBeNull();
        await store.activateSet(BOB, SET_2);
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_1);
        expect(await store.activateSet(USER, 'does-not-exist')).toBeNull();
      });

      it('does not repeat a setId, and does not allow a nonexistent user', async () => {
        expect(await store.createSet(setRecord(SET_1))).not.toBeNull();
        expect(await store.createSet(setRecord(SET_1))).toBeNull();
        await expect(store.createSet(setRecord(SET_2, 'nobody'))).rejects.toThrow();
      });

      it('the unique index prevents two active sets even with direct writes', async () => {
        await store.createSet(setRecord(SET_1));
        await store.createSet(setRecord(SET_2));
        await store.activateSet(USER, SET_1);
        const driver = await openDriver(url);
        try {
          await expect(driver.query(`UPDATE share_sets SET status = 'active' WHERE set_id = ?`, [SET_2])).rejects.toThrow();
        } finally {
          await driver.close();
        }
      });
    });

    it('a failed operation does not leave the connection unusable', async () => {
      await store.createSet(setRecord(SET_1));
      await expect(store.createSession('nobody')).rejects.toThrow();
      const token = await store.createSession(USER);
      expect((await store.getSession(token))?.userId).toBe(USER);
    });

    describe('concurrency across replicas', () => {
      const alternate = <T>(run: (target: VaultStore, index: number) => Promise<T>) =>
        Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => run(index % 2 ? replica : store, index)));

      it('the same jti in parallel has a single winner', async () => {
        for (let round = 0; round < ROUNDS; round += 1) {
          const results = await alternate((target) => target.consumeJti(`jti-${round}`, Date.now() + 60_000));
          expect(results.filter(Boolean)).toHaveLength(1);
        }
      });

      it('two simultaneous activations of different sets leave a single active one', async () => {
        for (let round = 0; round < ROUNDS; round += 1) {
          const ids = [crypto.randomUUID(), crypto.randomUUID()];
          for (const setId of ids) await store.createSet(setRecord(setId));
          const results = await Promise.all([store.activateSet(USER, ids[0]), replica.activateSet(USER, ids[1])]);
          expect(results.every((result) => result !== null)).toBe(true);

          const active = await store.getActiveSet(USER);
          expect(active && ids.includes(active.setId)).toBe(true);
          const loser = await store.getSet(USER, ids.find((setId) => setId !== active?.setId)!);
          expect(loser?.status).toBe('revoked');
          expect(loser).not.toHaveProperty('encA');
        }
      });

      it('with sets for different addresses one wins and the other stays pending', async () => {
        await store.createSet(setRecord(SET_1));
        await store.createSet(setRecord(SET_2, USER, OTHER_ADDRESS));
        await Promise.all([store.activateSet(USER, SET_1), replica.activateSet(USER, SET_2)]);
        const statuses = [(await store.getSet(USER, SET_1))?.status, (await store.getSet(USER, SET_2))?.status].sort();
        expect(statuses).toEqual(['active', 'pending']);
      });

      it('the same setId in parallel is created only once', async () => {
        const results = await alternate((target) => target.createSet(setRecord(SET_1)));
        expect(results.filter((result) => result !== null)).toHaveLength(1);
      });

      it('upserting the same new user does not fail', async () => {
        await alternate((target, index) => target.upsertUser('newcomer', `label-${index}`));
        expect((await store.getUser('newcomer'))?.label).toMatch(/^label-/);
      });

    });

    describe('WebAuthn challenges', () => {
      it('are single-use, bound to that purpose and that user, and expire', async () => {
        await store.createWebauthnChallenge('challenge-1', 'recover', null, 60_000);
        expect(await store.consumeWebauthnChallenge('challenge-1', 'register', null)).toBe(false);
        expect(await store.consumeWebauthnChallenge('challenge-1', 'recover', USER)).toBe(false);
        expect(await replica.consumeWebauthnChallenge('challenge-1', 'recover', null)).toBe(true);
        expect(await store.consumeWebauthnChallenge('challenge-1', 'recover', null)).toBe(false);

        await store.createWebauthnChallenge('challenge-2', 'register', USER, 60_000);
        expect(await store.consumeWebauthnChallenge('challenge-2', 'register', BOB)).toBe(false);
        expect(await store.consumeWebauthnChallenge('challenge-2', 'register', null)).toBe(false);
        expect(await store.consumeWebauthnChallenge('challenge-2', 'register', USER)).toBe(true);

        await store.createWebauthnChallenge('challenge-3', 'recover', null, -1);
        expect(await store.consumeWebauthnChallenge('challenge-3', 'recover', null)).toBe(false);
      });

      it('across replicas, a challenge is spent by only one request', async () => {
        await store.createWebauthnChallenge('challenge-race', 'recover', null, 60_000);
        const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => (index % 2 ? store : replica).consumeWebauthnChallenge('challenge-race', 'recover', null)));
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe('credentials', () => {
      const withKey = (setId: string, credentialId: string, userId = USER, expectedAddress = ADDRESS) => ({ ...setRecord(setId, userId, expectedAddress), credentialId, credential: { publicKey: 'key', counter: 0 } });

      it('only finds the active set of a credential with a public key', async () => {
        await store.createSet(setRecord(SET_1));
        await store.activateSet(USER, SET_1);
        expect(await store.getActiveSetByCredential('cred')).toBeNull();

        await store.createSet(withKey(SET_2, 'cred-2'));
        expect(await store.getActiveSetByCredential('cred-2')).toBeNull();
        await store.activateSet(USER, SET_2);
        const found = await store.getActiveSetByCredential('cred-2');
        expect(found?.setId).toBe(SET_2);
        expect(found?.credential).toEqual({ publicKey: 'key', counter: 0 });
        expect((await store.getSet(USER, SET_1))?.credential).toBeUndefined();
      });

      it('a credential with a key cannot be registered twice', async () => {
        expect(await store.createSet(withKey(SET_1, 'cred-1'))).not.toBeNull();
        expect(await store.createSet(withKey(SET_2, 'cred-1', BOB, OTHER_ADDRESS))).toBeNull();
      });

      it('the counter only advances from the expected value, across replicas', async () => {
        await store.createSet(withKey(SET_1, 'cred-1'));
        const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => (index % 2 ? store : replica).advanceCredentialCounter(SET_1, 0, 5)));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await store.getSet(USER, SET_1))?.credential?.counter).toBe(5);
        expect(await store.advanceCredentialCounter(SET_1, 0, 9)).toBe(false);
        expect(await store.advanceCredentialCounter(SET_1, 5, 9)).toBe(true);
      });

      it('finds active sets by owner, case-insensitively', async () => {
        await store.createSet(setRecord(SET_1));
        expect(await store.findActiveSetsByOwner(ADDRESS)).toEqual([]);
        await store.activateSet(USER, SET_1);
        expect((await store.findActiveSetsByOwner(ADDRESS.toLowerCase())).map(({ setId }) => setId)).toEqual([SET_1]);
        expect(await store.findActiveSetsByOwner(OTHER_ADDRESS)).toEqual([]);
      });
    });

    describe('relink to another account', () => {
      const NEW = 'carol';
      const SAFE = smartAccountFor(ADDRESS).address;
      const nonceFor = (nonce: string, userId = NEW, ttl = 60_000) => ({ nonce, userId, safe: SAFE, owner: ADDRESS, fromUser: USER, expiresAt: Date.now() + ttl });
      const relink = (nonce: string, userId = NEW, target: VaultStore = store) =>
        target.relinkWallet({ nonce, userId, signature: '0xsignature', issuer: 'https://login.test', vaultOrigin: 'https://vault.test', appOrigin: 'https://app.test' });

      beforeEach(async () => {
        await store.upsertUser(NEW, 'carol@example.com');
        await store.createSet(setRecord(SET_1));
        await store.activateSet(USER, SET_1);
      });

      it('moves all sets, closes the previous sessions, keeps the audit data and leaves a trail', async () => {
        await store.createSet(setRecord(SET_2));
        await store.markExported(USER, '2026-01-01T00:00:00.000Z');
        const session = await store.createSession(USER);
        await store.createRelinkNonce(nonceFor('n-1'));
        expect(await store.getRelinkNonce('n-1', NEW)).toMatchObject({ fromUser: USER, safe: SAFE });
        expect(await store.getRelinkNonce('n-1', BOB)).toBeNull();

        expect(await relink('n-1')).toBe('LINKED');
        expect((await store.getActiveSet(NEW))?.setId).toBe(SET_1);
        expect(await store.getActiveSet(USER)).toBeNull();
        expect(await store.getSet(USER, SET_1)).toBeNull();
        expect((await store.getSet(NEW, SET_2))?.status).toBe('pending');
        expect(await store.getSession(session)).toBeNull();
        expect((await store.getUser(NEW))?.exportedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(await store.getRelinkNonce('n-1', NEW)).toBeNull();
        expect(await store.listWalletRelinks(ADDRESS)).toMatchObject([{ oldSub: USER, newSub: NEW, safe: SAFE, owner: ADDRESS.toLowerCase(), appOrigin: 'https://app.test', nonce: 'n-1' }]);
      });

      it('rejects a spent, expired or other-account nonce, and a wallet that has already moved', async () => {
        await store.createRelinkNonce(nonceFor('n-1'));
        await store.createRelinkNonce(nonceFor('n-2', BOB));
        await store.createRelinkNonce(nonceFor('n-3', NEW, -1));
        await store.createRelinkNonce(nonceFor('n-4'));
        await store.createRelinkNonce({ ...nonceFor('n-5'), fromUser: null });
        expect(await relink('n-3')).toBe('NONCE_INVALID');
        expect(await relink('n-2')).toBe('NONCE_INVALID');
        expect(await relink('n-5')).toBe('STALE');
        expect(await relink('n-1')).toBe('LINKED');
        expect(await relink('n-1')).toBe('NONCE_INVALID');
        expect(await relink('n-4')).toBe('STALE');
        expect(await store.listWalletRelinks(ADDRESS)).toHaveLength(1);
      });

      it('an account with a wallet does not change it, and a failure spends the nonce without moving anything', async () => {
        await store.createSet(setRecord(SET_2, NEW, OTHER_ADDRESS));
        await store.activateSet(NEW, SET_2);
        await store.createRelinkNonce(nonceFor('n-1'));
        expect(await relink('n-1')).toBe('HAS_WALLET');
        expect(await relink('n-1')).toBe('NONCE_INVALID');
        expect((await store.getActiveSet(USER))?.setId).toBe(SET_1);
        expect((await store.getActiveSet(NEW))?.setId).toBe(SET_2);
      });

      it('across replicas, of several accounts at once only one gets the wallet', async () => {
        const accounts = Array.from({ length: CONCURRENCY }, (_, index) => `account-${index}`);
        for (const account of accounts) await store.upsertUser(account, `${account}@example.com`);
        await Promise.all(accounts.map((account) => store.createRelinkNonce(nonceFor(`n-${account}`, account))));
        const results = await Promise.all(accounts.map((account, index) => relink(`n-${account}`, account, index % 2 ? store : replica)));
        expect(results.filter((result) => result === 'LINKED')).toHaveLength(1);
        expect(results.filter((result) => result === 'STALE')).toHaveLength(CONCURRENCY - 1);
        const holders = (await Promise.all(accounts.map((account) => store.getActiveSet(account)))).filter(Boolean);
        expect(holders).toHaveLength(1);
        expect(await store.listWalletRelinks(ADDRESS)).toHaveLength(1);
      });

      it('across replicas, the same nonce works only once', async () => {
        await store.createRelinkNonce(nonceFor('n-race'));
        const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => relink('n-race', NEW, index % 2 ? store : replica)));
        expect(results.filter((result) => result === 'LINKED')).toHaveLength(1);
      });
    });

    describe('created session', () => {
      it('a set keeps the hash of the session that created it, and has none if not given', async () => {
        await store.createSet({ ...setRecord(SET_1), createdSessionHash: 'h'.repeat(64) });
        await store.createSet(setRecord(SET_2));
        expect((await store.getSet(USER, SET_1))?.createdSessionHash).toBe('h'.repeat(64));
        expect(await store.getSet(USER, SET_2)).not.toHaveProperty('createdSessionHash');
      });
    });

    describe('rate limits', () => {
      const WINDOW = 60_000;
      const START = 1_800_000_000_000;

      afterEach(() => {
        vi.useRealTimers();
      });

      it('counts hits per bucket in a fixed window, and the next window starts again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START + 10);
        expect(await store.hitRateLimit('scope:ip:1', WINDOW)).toEqual({ hits: 1, resetAt: START + WINDOW });
        expect(await replica.hitRateLimit('scope:ip:1', WINDOW)).toEqual({ hits: 2, resetAt: START + WINDOW });
        expect(await store.hitRateLimit('scope:ip:2', WINDOW)).toEqual({ hits: 1, resetAt: START + WINDOW });

        vi.setSystemTime(START + WINDOW);
        expect(await store.hitRateLimit('scope:ip:1', WINDOW)).toEqual({ hits: 1, resetAt: START + 2 * WINDOW });
        // A replica whose clock lags behind adds to the newer window instead of resetting it.
        vi.setSystemTime(START + WINDOW - 1);
        expect(await replica.hitRateLimit('scope:ip:1', WINDOW)).toEqual({ hits: 2, resetAt: START + 2 * WINDOW });
      });

      it('purges expired buckets', async () => {
        const driver = await openDriver(url);
        try {
          await driver.query('INSERT INTO rate_limits (bucket, window_start, hits, expires_at) VALUES (?, ?, ?, ?)', ['old', 0, 3, Date.now() - 1]);
          await store.hitRateLimit('fresh', WINDOW);
          const { rows } = await driver.query<{ bucket: string }>('SELECT bucket FROM rate_limits ORDER BY bucket');
          expect(rows.map((row) => row.bucket)).toEqual(['fresh']);
        } finally {
          await driver.close();
        }
      });

      it('across replicas, concurrent hits on a bucket each get a different count', async () => {
        const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => (index % 2 ? replica : store).hitRateLimit('race', 3_600_000)));
        expect(results.map(({ hits }) => hits).sort((a, b) => a - b)).toEqual(Array.from({ length: CONCURRENCY }, (_, index) => index + 1));
        expect(new Set(results.map(({ resetAt }) => resetAt)).size).toBe(1);
      });
    });

    describe('share A releases', () => {
      const release = (userId: string, setId: string, releasedAt: string) => ({
        userId,
        setId,
        setStatus: 'active' as const,
        sessionHash: 's'.repeat(64),
        appOrigin: 'https://app.test',
        releasedAt,
      });

      it('are recorded per user, oldest first', async () => {
        await store.recordShareARelease(release(USER, SET_2, '2026-01-02T00:00:00.000Z'));
        await replica.recordShareARelease({ ...release(USER, SET_1, '2026-01-01T00:00:00.000Z'), setStatus: 'pending', appOrigin: null });
        await store.recordShareARelease(release(BOB, SET_1, '2026-01-03T00:00:00.000Z'));
        expect(await store.listShareAReleases(USER)).toEqual([
          { ...release(USER, SET_1, '2026-01-01T00:00:00.000Z'), setStatus: 'pending', appOrigin: null },
          release(USER, SET_2, '2026-01-02T00:00:00.000Z'),
        ]);
        expect(await store.listShareAReleases('nobody')).toEqual([]);
      });

      it('are kept for a user that does not exist (no foreign key: a relink moves sets)', async () => {
        await store.recordShareARelease(release('gone', SET_1, '2026-01-01T00:00:00.000Z'));
        expect(await store.listShareAReleases('gone')).toHaveLength(1);
      });
    });

    describe('capped WebAuthn challenges', () => {
      const liveRows = async (purpose: string) => {
        const driver = await openDriver(url);
        try {
          const { rows } = await driver.query<{ live: number | string }>('SELECT COUNT(*) AS live FROM webauthn_challenges WHERE purpose = ? AND expires_at > ?', [purpose, Date.now()]);
          return Number(rows[0].live);
        } finally {
          await driver.close();
        }
      };

      it('without a cap they are always created', async () => {
        for (let index = 0; index < 3; index += 1) expect(await store.createWebauthnChallenge(`free-${index}`, 'recover', null, 60_000)).toBe(true);
      });

      it('are created only while fewer than the cap are live for that purpose', async () => {
        await store.createWebauthnChallenge('expired-1', 'recover', null, -1);
        await store.createWebauthnChallenge('expired-2', 'recover', null, -1);
        await store.createWebauthnChallenge('other-purpose', 'register', USER, 60_000);
        expect(await store.createWebauthnChallenge('capped-1', 'recover', null, 60_000, 2)).toBe(true);
        expect(await replica.createWebauthnChallenge('capped-2', 'recover', null, 60_000, 2)).toBe(true);
        expect(await store.createWebauthnChallenge('capped-3', 'recover', null, 60_000, 2)).toBe(false);
        expect(await store.consumeWebauthnChallenge('capped-3', 'recover', null)).toBe(false);
        // Spending one frees a place.
        expect(await store.consumeWebauthnChallenge('capped-1', 'recover', null)).toBe(true);
        expect(await store.createWebauthnChallenge('capped-4', 'recover', null, 60_000, 2)).toBe(true);
        expect(await store.consumeWebauthnChallenge('capped-4', 'recover', null)).toBe(true);
      });

      it('across replicas, concurrent creation never goes over the cap', async () => {
        const CAP = 5;
        for (let round = 0; round < ROUNDS; round += 1) {
          const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, index) => (index % 2 ? replica : store).createWebauthnChallenge(`race-${round}-${index}`, 'recover', null, 60_000, CAP)),
          );
          expect(results.filter(Boolean)).toHaveLength(round === 0 ? CAP : 0);
          expect(await liveRows('recover')).toBe(CAP);
        }
      });
    });

    describe('sponsored deployments', () => {
      const CHAIN = 2 ** 40;
      const SAFE = '0xAbCdEf0000000000000000000000000000000001';
      const NOW = 1_800_000_000_000;
      const STALE = 60_000;
      const RETRY = 900_000;
      const prepare = (operationHash: string, now = NOW, target: VaultStore = store) =>
        target.prepareSponsoredDeployment({ chainId: CHAIN, safe: SAFE, userId: USER, operation: `{"hash":"${operationHash}"}`, operationHash, now, staleSubmittingMs: STALE, retrySentAfterMs: RETRY });
      const claim = (operationHash: string, now = NOW, target: VaultStore = store) => target.claimSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash, now, staleSubmittingMs: STALE });

      it('goes from prepared to submitting to sent, with the Safe in lowercase', async () => {
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toBeNull();
        expect(await prepare('op-1')).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE.toLowerCase())).toEqual({
          chainId: CHAIN,
          safe: SAFE.toLowerCase(),
          userId: USER,
          status: 'prepared',
          operation: '{"hash":"op-1"}',
          operationHash: 'op-1',
          userOpHash: null,
          preparedAt: NOW,
          updatedAt: NOW,
        });
        // A new preparation replaces one that was not submitted.
        expect(await prepare('op-2', NOW + 1)).toBe(true);
        expect(await claim('op-1', NOW + 2)).toBe(false);
        expect(await claim('op-2', NOW + 2)).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'submitting', operationHash: 'op-2', preparedAt: NOW + 1, updatedAt: NOW + 2 });
        expect(await store.completeSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: 'op-1', userOpHash: '0xuserop', now: NOW + 3 })).toBe(false);
        expect(await store.completeSponsoredDeployment({ chainId: CHAIN, safe: SAFE.toUpperCase().replace('0X', '0x'), operationHash: 'op-2', userOpHash: '0xuserop', now: NOW + 3 })).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'sent', userOpHash: '0xuserop', updatedAt: NOW + 3 });
        expect(await store.completeSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: 'op-2', userOpHash: '0xother', now: NOW + 4 })).toBe(false);
        expect(await store.releaseSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: 'op-2', now: NOW + 4 })).toBe(false);
        expect(await claim('op-2', NOW + STALE + 10)).toBe(false);
      });

      it('a sent one is only replaced after the retry window', async () => {
        await prepare('op-1');
        await claim('op-1');
        await store.completeSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: 'op-1', userOpHash: '0xuserop', now: NOW });
        expect(await prepare('op-2', NOW + RETRY - 1)).toBe(false);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'sent', operationHash: 'op-1' });
        expect(await prepare('op-2', NOW + RETRY)).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'prepared', operationHash: 'op-2', userOpHash: null, preparedAt: NOW + RETRY });
      });

      it('one being submitted is neither replaced nor claimed again until it is stale, and can be released', async () => {
        await prepare('op-1');
        expect(await claim('op-1')).toBe(true);
        expect(await prepare('op-2', NOW + STALE - 1)).toBe(false);
        expect(await claim('op-1', NOW + STALE - 1)).toBe(false);
        expect(await claim('op-1', NOW + STALE)).toBe(true);
        expect(await store.releaseSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: 'op-2', now: NOW + STALE })).toBe(false);
        expect(await store.releaseSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: 'op-1', now: NOW + STALE + 1 })).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'prepared', updatedAt: NOW + STALE + 1 });
        expect(await claim('op-1', NOW + STALE + 2)).toBe(true);
        expect(await prepare('op-2', NOW + 2 * STALE + 2)).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'prepared', operationHash: 'op-2' });
      });

      it('is per chain and per Safe', async () => {
        await prepare('op-1');
        await claim('op-1');
        expect(await store.prepareSponsoredDeployment({ chainId: CHAIN + 1, safe: SAFE, userId: USER, operation: '{}', operationHash: 'op-x', now: NOW, staleSubmittingMs: STALE, retrySentAfterMs: RETRY })).toBe(true);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'submitting' });
        expect(await store.getSponsoredDeployment(CHAIN, OTHER_ADDRESS)).toBeNull();
      });

      it('across replicas, of several concurrent claims only one wins', async () => {
        for (let round = 0; round < ROUNDS; round += 1) {
          const now = NOW + round * RETRY * 2;
          expect(await prepare(`op-${round}`, now)).toBe(true);
          const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => claim(`op-${round}`, now + 1, index % 2 ? replica : store)));
          expect(results.filter(Boolean)).toHaveLength(1);
          await store.completeSponsoredDeployment({ chainId: CHAIN, safe: SAFE, operationHash: `op-${round}`, userOpHash: '0xuserop', now: now + 2 });
        }
      });

      it('across replicas, concurrent preparations over a submitting one all fail', async () => {
        await prepare('op-1');
        await claim('op-1');
        const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => prepare(`op-${index + 2}`, NOW + 1, index % 2 ? replica : store)));
        expect(results.filter(Boolean)).toHaveLength(0);
        expect(await store.getSponsoredDeployment(CHAIN, SAFE)).toMatchObject({ status: 'submitting', operationHash: 'op-1' });
      });
    });

    describe('prepared transactions', () => {
      const CHAIN = 2 ** 40;
      const SAFE = '0xAbCdEf0000000000000000000000000000000001';
      const NOW = 1_800_000_000_000;
      const STALE = 60_000;
      const TTL = 600_000;
      const HASH_1 = '0x' + 'Ab'.repeat(32);
      const HASH_2 = '0x' + 'cd'.repeat(32);
      const USER_OP = '0x' + 'Ef'.repeat(32);
      const create = (operationHash: string, options: { now?: number; safe?: string; chainId?: number; sponsored?: boolean; target?: VaultStore } = {}) =>
        (options.target ?? store).createPreparedTransaction({
          chainId: options.chainId ?? CHAIN,
          safe: options.safe ?? SAFE,
          userId: USER,
          operationHash,
          operation: `{"hash":"${operationHash}"}`,
          sponsored: options.sponsored ?? true,
          now: options.now ?? NOW,
          expireBefore: (options.now ?? NOW) - TTL,
        });
      const claim = (operationHash: string, now = NOW, target: VaultStore = store, safe = SAFE) =>
        target.claimPreparedTransaction({ chainId: CHAIN, safe, operationHash, now, staleSubmittingMs: STALE });
      const complete = (operationHash: string, now = NOW, userOpHash = USER_OP, safe = SAFE) =>
        store.completePreparedTransaction({ chainId: CHAIN, safe, operationHash, userOpHash, now });
      const release = (operationHash: string, now = NOW) => store.releasePreparedTransaction({ chainId: CHAIN, safe: SAFE, operationHash, now });
      const get = (operationHash: string, safe = SAFE, chainId = CHAIN) => store.getPreparedTransaction(chainId, safe, operationHash);

      it('is created once per chain, Safe and hash, in lowercase, with every field', async () => {
        expect(await get(HASH_1)).toBeNull();
        expect(await create(HASH_1)).toBe(true);
        expect(await create(HASH_1.toLowerCase(), { now: NOW + 1, sponsored: false })).toBe(false);
        expect(await store.getPreparedTransaction(CHAIN, SAFE.toLowerCase(), HASH_1.toUpperCase().replace('0X', '0x'))).toEqual({
          chainId: CHAIN,
          safe: SAFE.toLowerCase(),
          userId: USER,
          operationHash: HASH_1.toLowerCase(),
          status: 'prepared',
          operation: `{"hash":"${HASH_1}"}`,
          sponsored: true,
          userOpHash: null,
          preparedAt: NOW,
          updatedAt: NOW,
        });
        expect(await create(HASH_2, { sponsored: false })).toBe(true);
        expect(await get(HASH_2)).toMatchObject({ sponsored: false, status: 'prepared' });
      });

      it('is per chain and per Safe', async () => {
        expect(await create(HASH_1)).toBe(true);
        expect(await create(HASH_1, { chainId: CHAIN + 1 })).toBe(true);
        expect(await create(HASH_1, { safe: OTHER_ADDRESS })).toBe(true);
        expect(await claim(HASH_1)).toBe(true);
        expect(await get(HASH_1)).toMatchObject({ status: 'submitting' });
        expect(await get(HASH_1, SAFE, CHAIN + 1)).toMatchObject({ status: 'prepared' });
        expect(await get(HASH_1, OTHER_ADDRESS)).toMatchObject({ status: 'prepared', safe: OTHER_ADDRESS.toLowerCase() });
        expect(await get(HASH_2)).toBeNull();
        expect(await get(HASH_1, ADDRESS)).toBeNull();
      });

      it('goes from prepared to submitting to sent, and a sent one is never claimable again', async () => {
        await create(HASH_1);
        expect(await claim(HASH_2)).toBe(false);
        expect(await complete(HASH_1, NOW + 1)).toBe(false);
        expect(await release(HASH_1, NOW + 1)).toBe(false);
        expect(await claim(HASH_1.toLowerCase(), NOW + 1)).toBe(true);
        expect(await get(HASH_1)).toMatchObject({ status: 'submitting', preparedAt: NOW, updatedAt: NOW + 1 });
        expect(await complete(HASH_2, NOW + 2)).toBe(false);
        expect(await complete(HASH_1, NOW + 2, USER_OP, OTHER_ADDRESS)).toBe(false);
        expect(await complete(HASH_1, NOW + 2, USER_OP, SAFE.toLowerCase())).toBe(true);
        expect(await get(HASH_1)).toMatchObject({ status: 'sent', userOpHash: USER_OP.toLowerCase(), updatedAt: NOW + 2 });
        expect(await complete(HASH_1, NOW + 3, '0xother')).toBe(false);
        expect(await release(HASH_1, NOW + 3)).toBe(false);
        expect(await claim(HASH_1, NOW + 3)).toBe(false);
        expect(await claim(HASH_1, NOW + 10 * STALE)).toBe(false);
        expect(await get(HASH_1)).toMatchObject({ status: 'sent', userOpHash: USER_OP.toLowerCase() });
      });

      it('one being submitted is not claimed again until it is stale, and can be released', async () => {
        await create(HASH_1);
        expect(await claim(HASH_1)).toBe(true);
        expect(await claim(HASH_1, NOW + STALE - 1)).toBe(false);
        expect(await claim(HASH_1, NOW + STALE)).toBe(true);
        expect(await get(HASH_1)).toMatchObject({ status: 'submitting', updatedAt: NOW + STALE });
        expect(await release(HASH_2, NOW + STALE + 1)).toBe(false);
        expect(await release(HASH_1, NOW + STALE + 1)).toBe(true);
        expect(await get(HASH_1)).toMatchObject({ status: 'prepared', updatedAt: NOW + STALE + 1 });
        expect(await release(HASH_1, NOW + STALE + 2)).toBe(false);
        expect(await claim(HASH_1, NOW + STALE + 2)).toBe(true);
      });

      it('across replicas, of several concurrent claims only one wins', async () => {
        for (let round = 0; round < ROUNDS; round += 1) {
          const hash = '0x' + round.toString(16).padStart(64, '0');
          expect(await create(hash)).toBe(true);
          const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => claim(hash, NOW + 1, index % 2 ? replica : store)));
          expect(results.filter(Boolean)).toHaveLength(1);
        }
      });

      it('isSentTransaction only finds a sent one of that Safe and chain with that hash, case-insensitively', async () => {
        await create(HASH_1);
        expect(await store.isSentTransaction(CHAIN, SAFE, USER_OP)).toBe(false);
        await claim(HASH_1);
        expect(await store.isSentTransaction(CHAIN, SAFE, USER_OP)).toBe(false);
        await complete(HASH_1, NOW + 1, USER_OP);
        expect(await store.isSentTransaction(CHAIN, SAFE, USER_OP)).toBe(true);
        expect(await store.isSentTransaction(CHAIN, SAFE.toLowerCase(), USER_OP.toUpperCase().replace('0X', '0x'))).toBe(true);
        expect(await store.isSentTransaction(CHAIN, SAFE, USER_OP.toLowerCase())).toBe(true);
        expect(await store.isSentTransaction(CHAIN + 1, SAFE, USER_OP)).toBe(false);
        expect(await store.isSentTransaction(CHAIN, OTHER_ADDRESS, USER_OP)).toBe(false);
        expect(await store.isSentTransaction(CHAIN, SAFE, HASH_2)).toBe(false);
        // A released one is no longer submitting, and was never sent.
        await create(HASH_2);
        await claim(HASH_2);
        await release(HASH_2, NOW + 2);
        expect(await store.isSentTransaction(CHAIN, SAFE, HASH_2)).toBe(false);
      });

      it('creating one deletes the expired prepared ones of any Safe, but never submitting or sent ones', async () => {
        const OLD_PREPARED = '0x' + '01'.repeat(32);
        const OLD_SUBMITTING = '0x' + '02'.repeat(32);
        const OLD_SENT = '0x' + '03'.repeat(32);
        const FRESH = '0x' + '04'.repeat(32);
        await create(OLD_PREPARED, { safe: OTHER_ADDRESS });
        await create(OLD_SUBMITTING);
        await claim(OLD_SUBMITTING);
        await create(OLD_SENT);
        await claim(OLD_SENT);
        await complete(OLD_SENT);
        await create(FRESH, { now: NOW + 1 });

        // At `NOW + TTL` the rows last touched at `NOW` are exactly at the limit; the one at `NOW + 1` is not.
        expect(await create(HASH_1, { now: NOW + TTL })).toBe(true);
        expect(await get(OLD_PREPARED, OTHER_ADDRESS)).toBeNull();
        expect(await get(OLD_SUBMITTING)).toMatchObject({ status: 'submitting' });
        expect(await get(OLD_SENT)).toMatchObject({ status: 'sent' });
        expect(await get(FRESH)).toMatchObject({ status: 'prepared' });
        expect(await store.isSentTransaction(CHAIN, SAFE, USER_OP)).toBe(true);

        // An expired one is gone: its hash can be prepared again from scratch.
        expect(await create(OLD_PREPARED, { safe: OTHER_ADDRESS, now: NOW + TTL })).toBe(true);
        expect(await get(OLD_PREPARED, OTHER_ADDRESS)).toMatchObject({ status: 'prepared', preparedAt: NOW + TTL });
        expect(await create(FRESH, { now: NOW + TTL })).toBe(false);
        expect(await get(FRESH)).toMatchObject({ status: 'prepared', preparedAt: NOW + 1 });
      });
    });

    describe('migrations', () => {
      it('migration 2 removes the vault second factor without losing users, sets or wallets, and closes the sessions', async () => {
        const target = await freshUrl();
        const driver = await openDriver(target);
        try {
          await migrate(driver, MIGRATIONS.filter((migration) => migration.version === 1));
          await driver.query('INSERT INTO users (user_id, label, created_at) VALUES (?, ?, ?)', [USER, 'a@example.com', 1]);
          // A session that had not yet passed the second factor must not become valid.
          await driver.query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', ['old', USER, Date.now() + 60_000]);
          const set = setRecord(SET_1);
          await driver.query(
            `INSERT INTO share_sets (set_id, user_id, status, credential_id, manifest, signature, enc_a, enc_b, enc_c, created_at)
             VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
            [SET_1, USER, set.credentialId, JSON.stringify(set.manifest), set.signature, '{}', '{}', '{}', set.createdAt],
          );
          await migrate(driver);

          const { rows } = await driver.query<Record<string, unknown>>('SELECT * FROM users');
          expect(Object.keys(rows[0]).sort()).toEqual(['created_at', 'exported_at', 'label', 'user_id']);
          const sessions = await driver.query<Record<string, unknown>>('SELECT * FROM sessions');
          expect(sessions.rows).toEqual([]);
          await driver.query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', ['new', USER, Date.now() + 60_000]);
          const created = await driver.query<Record<string, unknown>>('SELECT * FROM sessions');
          expect(Object.keys(created.rows[0]).sort()).toEqual(['app_origin', 'chain_id', 'expires_at', 'rpc_url', 'token', 'user_id']);
        } finally {
          await driver.close();
        }
        const migrated = await openStore(target);
        try {
          expect(await migrated.getAccount(USER)).toMatchObject({ exists: true, owner: ADDRESS });
          expect(await migrated.getUser(USER)).toEqual({ userId: USER, label: 'a@example.com', exportedAt: null });
          // A previous set finds its owner, and has no public key: it cannot recover without the kit until it re-enrolls.
          const [existing] = await migrated.findActiveSetsByOwner(ADDRESS);
          expect(existing.setId).toBe(SET_1);
          expect(existing.credential).toBeUndefined();
          expect(await migrated.getActiveSetByCredential(existing.credentialId)).toBeNull();
        } finally {
          await migrated.close();
        }
      });

      it('migration 6 adds the limits and audit tables without touching existing sets', async () => {
        const target = await freshUrl();
        const driver = await openDriver(target);
        const set = setRecord(SET_1);
        try {
          await migrate(driver, MIGRATIONS.filter((migration) => migration.version <= 5));
          await driver.query('INSERT INTO users (user_id, label, created_at) VALUES (?, ?, ?)', [USER, 'a@example.com', 1]);
          await driver.query(
            `INSERT INTO share_sets (set_id, user_id, status, credential_id, manifest, signature, enc_a, enc_b, enc_c, created_at, owner)
             VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [SET_1, USER, set.credentialId, JSON.stringify(set.manifest), set.signature, '{}', '{}', '{}', set.createdAt, ADDRESS.toLowerCase()],
          );
          await migrate(driver);
        } finally {
          await driver.close();
        }
        const migrated = await openStore(target);
        try {
          const existing = await migrated.getSet(USER, SET_1);
          expect(existing).toMatchObject({ status: 'active', manifest: set.manifest });
          expect(existing).not.toHaveProperty('createdSessionHash');
          expect(await migrated.getAccount(USER)).toMatchObject({ exists: true, owner: ADDRESS });
          expect(await migrated.hitRateLimit('bucket', 60_000)).toMatchObject({ hits: 1 });
          expect(await migrated.listShareAReleases(USER)).toEqual([]);
          expect(await migrated.getSponsoredDeployment(1, ADDRESS)).toBeNull();
          expect(await migrated.getPreparedTransaction(1, ADDRESS, '0x' + '0'.repeat(64))).toBeNull();
        } finally {
          await migrated.close();
        }
      });

      const versions = async (target: string) => {
        const driver = await openDriver(target);
        try {
          const { rows } = await driver.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
          return rows.map((row) => Number(row.version));
        } finally {
          await driver.close();
        }
      };

      it('are recorded and not repeated on reopen', async () => {
        const expected = MIGRATIONS.map((migration) => migration.version);
        expect(await versions(url)).toEqual(expected);
        await (await openStore(url)).close();
        expect(await versions(url)).toEqual(expected);
        expect((await store.getUser(USER))?.label).toBe('alice@example.com');
      });

      it('several replicas starting at once on an empty database apply each one only once', async () => {
        const empty = await freshUrl();
        const stores = await Promise.all(Array.from({ length: 6 }, () => openStore(empty)));
        await Promise.all(stores.map((target) => target.close()));
        expect(await versions(empty)).toEqual(MIGRATIONS.map((migration) => migration.version));
      });

      it('a failed migration leaves nothing half-done', async () => {
        const driver = await openDriver(url);
        try {
          const broken = {
            version: 900,
            name: 'broken',
            sqlite: 'CREATE TABLE half_done (id TEXT); SELECT * FROM does_not_exist;',
            postgres: 'CREATE TABLE half_done (id TEXT); SELECT * FROM does_not_exist;',
          };
          await expect(migrate(driver, [...MIGRATIONS, broken])).rejects.toThrow();
          await expect(driver.query('SELECT * FROM half_done')).rejects.toThrow();
          expect(await versions(url)).toEqual(MIGRATIONS.map((migration) => migration.version));
        } finally {
          await driver.close();
        }
      });

      it('rejects a schema newer than the code', async () => {
        const driver = await openDriver(url);
        await driver.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [9999, 'future', 'x']);
        await driver.close();
        await expect(openStore(url)).rejects.toThrow('newer');
      });
    });
  });
}
