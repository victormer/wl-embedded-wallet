import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as postChallenge } from '../../app/api/webauthn/challenge/route';
import { POST as postRecoveryChallenge } from '../../app/api/recovery/passkey/challenge/route';
import { POST as postRecovery } from '../../app/api/recovery/passkey/route';
import { GET as getShares, POST as postShares } from '../../app/api/shares/route';
import { b64urlEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import { verifyManifest } from '@wl-embedded-wallet/core/manifest';
import { consumeWebauthnChallenge, createWebauthnChallenge, getStore } from '../../server/store';
import { FakeAuthenticator, NO_UV, NO_UV_ATTESTED } from './fake-authenticator';
import { activeWallet, expectRateLimited, MANIFEST_PUBKEY, openSession, ORIGIN, req, RP_ID, sharesBody, useRouteEnv } from './route-harness';

const ALICE = 'alice';
const BOB = 'bob';
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

useRouteEnv();

const newAuthenticator = () => new FakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });

async function registerChallenge(cookie: string): Promise<string> {
  const response = await postChallenge(req('/api/webauthn/challenge', { cookie }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { challenge: string }).challenge;
}

async function recoveryChallenge(): Promise<string> {
  const response = await postRecoveryChallenge(req('/api/recovery/passkey/challenge'));
  expect(response.status).toBe(200);
  return ((await response.json()) as { challenge: string }).challenge;
}

/** Wallet with a really registered passkey. */
async function enrolled(user = ALICE, address = ADDRESS) {
  const cookie = await openSession(user);
  const authenticator = newAuthenticator();
  const registration = authenticator.register(await registerChallenge(cookie));
  const setId = await activeWallet(cookie, user, address, { credentialId: authenticator.id, registration });
  return { cookie, authenticator, setId };
}

const recover = (assertion: unknown, origin?: string | null) => postRecovery(req('/api/recovery/passkey', { body: { assertion }, origin }));

/** Always the same response: neither the status nor the body reveals the reason. */
async function expectGeneric(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'RECOVERY_FAILED' });
  expect(response.headers.get('set-cookie')).toBeNull();
}

describe('POST /api/shares with the registered passkey', () => {
  it('stores the public key and the counter, without exposing them', async () => {
    const { cookie, setId } = await enrolled();
    const stored = await (await getStore()).getSet(ALICE, setId);
    expect(stored?.credential?.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stored?.credential?.counter).toBe(0);
    const body = await (await getShares(req('/api/shares', { method: 'GET', cookie }))).text();
    expect(body).not.toContain(stored?.credential?.publicKey);
  });

  it('without registration, the set is created without a public key, like the old ones', async () => {
    const cookie = await openSession(ALICE);
    const setId = await activeWallet(cookie, ALICE, ADDRESS);
    expect((await (await getStore()).getSet(ALICE, setId))?.credential).toBeUndefined();
  });

  const invalid: [string, (authenticator: FakeAuthenticator, challenge: string) => unknown][] = [
    ['from another origin', (a, c) => a.register(c, { origin: 'https://other.test' })],
    ['from another RP ID', (a, c) => a.register(c, { rpId: 'other.test' })],
    ['without user verification', (a, c) => a.register(c, { flags: NO_UV_ATTESTED })],
    ['that claims not to be resident', (a, c) => a.register(c, { rk: false })],
    ['of another type', (a, c) => a.register(c, { type: 'webauthn.get' })],
    ['with a made-up challenge', (a) => a.register(b64urlEncode(randomBytes(32)))],
    ['with an invalid shape', () => ({ id: 'x' })],
  ];
  for (const [name, build] of invalid) {
    it(`rejects a registration ${name}`, async () => {
      const cookie = await openSession(ALICE);
      const authenticator = newAuthenticator();
      const body = await sharesBody(ALICE, ADDRESS, { credentialId: authenticator.id });
      const response = await postShares(req('/api/shares', { cookie, body: { ...body, registration: build(authenticator, await registerChallenge(cookie)) } }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'CREDENTIAL_INVALID' });
      expect((await getShares(req('/api/shares', { method: 'GET', cookie }))).status).toBe(404);
    });
  }

  it('the challenge is single-use and bound to that session, and the credential must be the declared one', async () => {
    const alice = await openSession(ALICE);
    const bob = await openSession(BOB);
    const authenticator = newAuthenticator();

    const stolen = authenticator.register(await registerChallenge(alice));
    const asBob = await sharesBody(BOB, OTHER_ADDRESS, { credentialId: authenticator.id, registration: stolen });
    expect((await postShares(req('/api/shares', { cookie: bob, body: asBob }))).status).toBe(400);

    const challenge = await registerChallenge(alice);
    const first = await sharesBody(ALICE, ADDRESS, { credentialId: authenticator.id, registration: authenticator.register(challenge) });
    expect((await postShares(req('/api/shares', { cookie: alice, body: first }))).status).toBe(201);
    const reused = await sharesBody(ALICE, ADDRESS, { credentialId: authenticator.id, registration: authenticator.register(challenge) });
    expect((await postShares(req('/api/shares', { cookie: alice, body: reused }))).status).toBe(400);

    const otherId = await sharesBody(ALICE, ADDRESS, { credentialId: 'b3Ryby1pZA', registration: authenticator.register(await registerChallenge(alice)) });
    expect((await postShares(req('/api/shares', { cookie: alice, body: otherId }))).status).toBe(400);
  });

  it('an already registered credential cannot be registered again with another key', async () => {
    const { authenticator } = await enrolled();
    const bob = await openSession(BOB);
    // Someone who knows another user's credential id cannot take it over: the id repeats, the key is their own.
    const usurper = newAuthenticator();
    Object.assign(usurper, { credentialId: authenticator.credentialId, id: authenticator.id });
    const body = await sharesBody(BOB, OTHER_ADDRESS, { credentialId: authenticator.id, registration: usurper.register(await registerChallenge(bob)) });
    expect((await postShares(req('/api/shares', { cookie: bob, body }))).status).toBe(409);
  });

  it('the challenge requires a session', async () => {
    expect((await postChallenge(req('/api/webauthn/challenge'))).status).toBe(401);
  });

  it('does not accept the seed backup in the body', async () => {
    const cookie = await openSession(ALICE);
    const body = { ...(await sharesBody(ALICE, ADDRESS)), seedBackup: { v: 1 } };
    expect((await postShares(req('/api/shares', { cookie, body }))).status).toBe(400);
    expect((await getShares(req('/api/shares', { method: 'GET', cookie }))).status).toBe(404);
  });

  it('an address active in another account cannot be declared as a new wallet', async () => {
    await enrolled();
    const bob = await openSession(BOB);
    const response = await postShares(req('/api/shares', { cookie: bob, body: await sharesBody(BOB, ADDRESS) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'WALLET_ALREADY_EXISTS' });
  });
});

describe('POST /api/recovery/passkey', () => {
  it('returns encB, encC and the manifest, never share A, and does not open a session', async () => {
    const { authenticator, setId } = await enrolled();
    const response = await recover(authenticator.assert(await recoveryChallenge()));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown> & { manifest: never; signature: string };
    expect(Object.keys(body).sort()).toEqual(['credentialId', 'encB', 'encC', 'manifest', 'setId', 'signature']);
    expect(body.setId).toBe(setId);
    expect(JSON.stringify(body)).not.toContain('shareA');
    expect(JSON.stringify(body)).not.toContain('encA');
    verifyManifest({ manifest: body.manifest, signature: body.signature }, MANIFEST_PUBKEY);
  });

  it('raises the counter and rejects one that does not advance, like everything else', async () => {
    const { authenticator, setId } = await enrolled();
    expect((await recover(authenticator.assert(await recoveryChallenge(), { counter: 10 }))).status).toBe(200);
    expect((await (await getStore()).getSet(ALICE, setId))?.credential?.counter).toBe(10);
    await expectGeneric(await recover(authenticator.assert(await recoveryChallenge(), { counter: 10 })));
    await expectGeneric(await recover(authenticator.assert(await recoveryChallenge(), { counter: 3 })));
    expect((await recover(authenticator.assert(await recoveryChallenge(), { counter: 11 }))).status).toBe(200);
  });

  it('an authenticator that does not count (counter 0) keeps working', async () => {
    const { authenticator } = await enrolled();
    expect((await recover(authenticator.assert(await recoveryChallenge(), { counter: 0 }))).status).toBe(200);
    expect((await recover(authenticator.assert(await recoveryChallenge(), { counter: 0 }))).status).toBe(200);
  });

  it('the challenge is single-use, also with several at once', async () => {
    const { authenticator } = await enrolled();
    const challenge = await recoveryChallenge();
    expect((await recover(authenticator.assert(challenge))).status).toBe(200);
    await expectGeneric(await recover(authenticator.assert(challenge)));

    const shared = await recoveryChallenge();
    const results = await Promise.all(Array.from({ length: 8 }, () => recover(authenticator.assert(shared))));
    expect(results.filter(({ status }) => status === 200)).toHaveLength(1);
  });

  it('an expired challenge is not valid', async () => {
    const { authenticator } = await enrolled();
    const challenge = b64urlEncode(randomBytes(32));
    await createWebauthnChallenge(challenge, 'recover', null, -1000);
    await expectGeneric(await recover(authenticator.assert(challenge)));
  });

  it('a registration challenge cannot be used to recover', async () => {
    const { authenticator, cookie } = await enrolled();
    await expectGeneric(await recover(authenticator.assert(await registerChallenge(cookie))));
    // And the other way around.
    const challenge = await recoveryChallenge();
    expect(await consumeWebauthnChallenge(challenge, 'register', ALICE)).toBe(false);
    expect(await consumeWebauthnChallenge(challenge, 'recover', null)).toBe(true);
  });

  const forged: [string, (authenticator: FakeAuthenticator, other: FakeAuthenticator, challenge: string) => unknown][] = [
    ['signed by another credential', (a, other, c) => a.assert(c, { signer: other })],
    ['from an unknown credential', (_a, other, c) => other.assert(c)],
    ['from another origin', (a, _o, c) => a.assert(c, { origin: 'https://phishing.test' })],
    ['from another RP ID', (a, _o, c) => a.assert(c, { rpId: 'other.test' })],
    ['without user verification', (a, _o, c) => a.assert(c, { flags: NO_UV })],
    ['of another type', (a, _o, c) => a.assert(c, { type: 'webauthn.create' })],
    ['with an invalid shape', () => ({ id: 'x' })],
    ['with different id and rawId', (a, _o, c) => ({ ...a.assert(c), rawId: 'b3Rybw' })],
  ];
  for (const [name, build] of forged) {
    it(`rejects an assertion ${name}, with the generic response`, async () => {
      const { authenticator } = await enrolled();
      await expectGeneric(await recover(build(authenticator, newAuthenticator(), await recoveryChallenge())));
    });
  }

  it('another wallet\'s credential only returns its own', async () => {
    const alice = await enrolled(ALICE, ADDRESS);
    const bob = await enrolled(BOB, OTHER_ADDRESS);
    const body = (await (await recover(bob.authenticator.assert(await recoveryChallenge()))).json()) as { setId: string };
    expect(body.setId).toBe(bob.setId);
    expect(body.setId).not.toBe(alice.setId);
  });

  it('an old wallet, without a public key, cannot use this flow', async () => {
    const cookie = await openSession(ALICE);
    const authenticator = newAuthenticator();
    await activeWallet(cookie, ALICE, ADDRESS, { credentialId: authenticator.id });
    await expectGeneric(await recover(authenticator.assert(await recoveryChallenge())));
  });

  it('after rotation, the previous passkey no longer returns anything', async () => {
    const { authenticator, cookie } = await enrolled();
    const next = newAuthenticator();
    const setId = await activeWallet(cookie, ALICE, ADDRESS, { credentialId: next.id, registration: next.register(await registerChallenge(cookie)) });
    await expectGeneric(await recover(authenticator.assert(await recoveryChallenge())));
    const body = (await (await recover(next.assert(await recoveryChallenge()))).json()) as { setId: string };
    expect(body.setId).toBe(setId);
  });

  it('requires the vault origin, and so does the challenge', async () => {
    const { authenticator } = await enrolled();
    const challenge = await recoveryChallenge();
    expect((await recover(authenticator.assert(challenge), 'https://other.test')).status).toBe(403);
    expect((await postRecoveryChallenge(req('/api/recovery/passkey/challenge', { origin: 'https://other.test' }))).status).toBe(403);
    expect((await postRecoveryChallenge(req('/api/recovery/passkey/challenge', { origin: null }))).status).toBe(403);
  });
});

describe('kit-free recovery limits', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const askChallenge = () => postRecoveryChallenge(req('/api/recovery/passkey/challenge'));

  it('challenges are limited per IP', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'recovery-challenge': { ip: 2 } }));
    await recoveryChallenge();
    await recoveryChallenge();
    await expectRateLimited(await askChallenge());
  });

  it('live challenges are capped for everyone: at the cap 429 and nothing stored, and a spent one frees a slot', async () => {
    vi.stubEnv('RECOVERY_CHALLENGE_MAX_LIVE', '2');
    const first = await recoveryChallenge();
    await recoveryChallenge();
    await expectRateLimited(await askChallenge());
    // Registration challenges have their own bound (the session) and do not count.
    await registerChallenge(await openSession(ALICE));
    expect(await consumeWebauthnChallenge(first, 'recover', null)).toBe(true);
    const freed = await recoveryChallenge();
    await expectRateLimited(await askChallenge());
    expect(await consumeWebauthnChallenge(freed, 'recover', null)).toBe(true);
  });

  it('expired challenges are deleted and do not count towards the cap', async () => {
    vi.stubEnv('RECOVERY_CHALLENGE_MAX_LIVE', '1');
    const expired = b64urlEncode(randomBytes(32));
    await createWebauthnChallenge(expired, 'recover', null, -1000);
    await recoveryChallenge();
    expect(await consumeWebauthnChallenge(expired, 'recover', null)).toBe(false);
  });

  it('assertions are limited per IP: the same budget and answer whether or not the credential exists, and nothing is spent', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'recovery-assertion': { ip: 2 } }));
    const { authenticator } = await enrolled();
    const stranger = newAuthenticator();
    expect((await recover(authenticator.assert(await recoveryChallenge()))).status).toBe(200);
    await expectGeneric(await recover(stranger.assert(await recoveryChallenge())));
    const pending = authenticator.assert(await recoveryChallenge());
    const known = await recover(pending);
    const unknown = await recover(stranger.assert(await recoveryChallenge()));
    const answers = [];
    for (const response of [known, unknown]) {
      await expectRateLimited(response.clone());
      answers.push({ body: await response.text(), headers: [...response.headers.keys()].sort() });
    }
    expect(answers[0]).toEqual(answers[1]);
    // Refused before the challenge was read: with budget again, the same assertion recovers.
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'recovery-assertion': { ip: 5 } }));
    expect((await recover(pending)).status).toBe(200);
  });
});
