import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as postHandoff } from '../../app/api/auth/handoff/route';
import { PATCH as patchShares, POST as postShares } from '../../app/api/shares/route';
import { POST as postChallenge } from '../../app/api/webauthn/challenge/route';
import { getUser } from '../../server/store';
import { APP_ORIGIN, expectRateLimited, handoffToken, openSession, req, sharesBody, useRouteEnv } from './route-harness';

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

useRouteEnv();

afterEach(() => {
  vi.unstubAllEnvs();
});

const limits = (rules: Record<string, Record<string, number>>) => vi.stubEnv('RATE_LIMITS', JSON.stringify(rules));

const redeem = (token: string) => postHandoff(req('/api/auth/handoff', { body: { token, origin: APP_ORIGIN } }));

/** Same claims, signature no longer valid. */
function badSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  return `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
}

describe('POST /api/auth/handoff limits', () => {
  it('per IP, before verifying: invalid tokens spend it, and a token refused by the limit is not spent', async () => {
    limits({ handoff: { ip: 2, sub: 1000 } });
    expect((await redeem('not-a-token')).status).toBe(401);
    expect((await redeem(badSignature(handoffToken('alice')))).status).toBe(401);
    const token = handoffToken('alice');
    await expectRateLimited(await redeem(token));
    expect(await getUser('alice')).toBeNull();
    limits({ handoff: { ip: 4, sub: 1000 } });
    expect((await redeem(token)).status).toBe(200);
  });

  it('per sub, only for a verified token, and before its jti is spent', async () => {
    limits({ handoff: { ip: 1000, sub: 1 } });
    // Forged tokens naming alice do not spend her budget.
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await redeem(badSignature(handoffToken('alice')))).status).toBe(401);
    expect((await redeem(handoffToken('alice'))).status).toBe(200);
    const second = handoffToken('alice');
    await expectRateLimited(await redeem(second));
    // Each sub has its own budget.
    expect((await redeem(handoffToken('bob'))).status).toBe(200);
    // The refused token was not spent: with budget again, it redeems.
    limits({ handoff: { ip: 1000, sub: 3 } });
    expect((await redeem(second)).status).toBe(200);
  });
});

describe('enrollment limits', () => {
  const challenge = (cookie: string) => postChallenge(req('/api/webauthn/challenge', { cookie }));

  it('POST /api/webauthn/challenge, POST and PATCH /api/shares share a per-user budget', async () => {
    const alice = await openSession('alice');
    const bob = await openSession('bob');
    limits({ enroll: { ip: 1000, sub: 3 } });
    const body = await sharesBody('alice', ADDRESS);
    expect((await challenge(alice)).status).toBe(200);
    expect((await postShares(req('/api/shares', { cookie: alice, body }))).status).toBe(201);
    expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie: alice, body: { setId: body.setId } }))).status).toBe(200);
    await expectRateLimited(await challenge(alice));
    await expectRateLimited(await postShares(req('/api/shares', { cookie: alice, body: await sharesBody('alice', ADDRESS) })));
    await expectRateLimited(await patchShares(req('/api/shares', { method: 'PATCH', cookie: alice, body: { setId: body.setId } })));
    expect((await challenge(bob)).status).toBe(200);
  });

  it('and a per-IP budget across users', async () => {
    const alice = await openSession('alice');
    const bob = await openSession('bob');
    limits({ enroll: { ip: 2, sub: 1000 } });
    expect((await challenge(alice)).status).toBe(200);
    expect((await postShares(req('/api/shares', { cookie: bob, body: await sharesBody('bob', OTHER_ADDRESS) }))).status).toBe(201);
    await expectRateLimited(await challenge(bob));
  });
});
