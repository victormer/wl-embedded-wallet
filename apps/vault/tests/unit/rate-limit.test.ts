import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientIp, consumeLimit, normalizeIp, PEER_ADDRESS_HEADER, rateLimit, rateLimited, VERCEL_CLIENT_IP_HEADER } from '../../server/rate-limit';
import { closeDb } from '../../server/store';

const preload = globalThis as { __wdkVaultPeerAddress?: boolean };

function request(peer: string | null, forwardedFor?: string): Request {
  const headers = new Headers();
  if (peer !== null) headers.set(PEER_ADDRESS_HEADER, peer);
  if (forwardedFor !== undefined) headers.set('x-forwarded-for', forwardedFor);
  return new Request('http://vault.test/api/x', { method: 'POST', headers });
}

afterEach(() => {
  delete preload.__wdkVaultPeerAddress;
  vi.unstubAllEnvs();
});

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:cb00:7107', '203.0.113.7'],
    ['2001:DB8:0:0::1', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['203.0.113.7:8080', '203.0.113.7'],
    ['fe80::1%en0', 'fe80::1'],
  ])('%s is %s', (value, expected) => {
    expect(normalizeIp(value)).toBe(expected);
  });

  it.each(['', 'unknown', '203.0.113', '1.2.3.4.5', 'example.test'])('rejects %j', (value) => {
    expect(normalizeIp(value)).toBeNull();
  });
});

describe('clientIp', () => {
  it('without the preload, the header is the client\'s and is not trusted', () => {
    expect(clientIp(request('203.0.113.7'))).toBe('unknown');
  });

  it('with the preload: the peer, IPv4-mapped as IPv4, IPv6 by its /64', () => {
    preload.__wdkVaultPeerAddress = true;
    expect(clientIp(request('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(request('::ffff:127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(request('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64');
    expect(clientIp(request('2001:db8:1:2::ffff'))).toBe('2001:db8:1:2::/64');
    expect(clientIp(request('::1'))).toBe('0:0:0:0::/64');
    expect(clientIp(request(''))).toBe('unknown');
    expect(clientIp(request(null))).toBe('unknown');
  });

  it('never reads X-Forwarded-For without a trusted proxy, or from a peer that is not one', () => {
    preload.__wdkVaultPeerAddress = true;
    expect(clientIp(request('203.0.113.7', '198.51.100.1'))).toBe('203.0.113.7');
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    expect(clientIp(request('203.0.113.7', '198.51.100.1'))).toBe('203.0.113.7');
  });

  it('behind a trusted proxy, takes the right-most entry that is not a trusted proxy', () => {
    preload.__wdkVaultPeerAddress = true;
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8, fd00::/8');
    // The client wrote the first two; our proxies appended the rest.
    expect(clientIp(request('10.0.0.2', '1.1.1.1, 2.2.2.2, 198.51.100.1, 10.0.0.9'))).toBe('198.51.100.1');
    expect(clientIp(request('::ffff:10.0.0.2', '198.51.100.1'))).toBe('198.51.100.1');
    expect(clientIp(request('fd00::2', '2001:db8:5:6::1, fd00::3'))).toBe('2001:db8:5:6::/64');
    // Nothing usable: the peer.
    expect(clientIp(request('10.0.0.2'))).toBe('10.0.0.2');
    expect(clientIp(request('10.0.0.2', '10.0.0.3'))).toBe('10.0.0.2');
    expect(clientIp(request('10.0.0.2', '1.1.1.1, garbage'))).toBe('10.0.0.2');
  });

  it('an invalid TRUSTED_PROXIES trusts nobody', () => {
    preload.__wdkVaultPeerAddress = true;
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8, proxy.internal');
    expect(clientIp(request('10.0.0.2', '198.51.100.1'))).toBe('10.0.0.2');
  });
});

function vercelRequest(realIp: string | null, extra: Record<string, string> = {}): Request {
  const headers = new Headers(extra);
  if (realIp !== null) headers.set(VERCEL_CLIENT_IP_HEADER, realIp);
  return new Request('http://vault.test/api/x', { method: 'POST', headers });
}

function onVercel() {
  vi.stubEnv('CLIENT_IP_SOURCE', 'vercel');
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('VERCEL_REGION', 'fra1');
}

describe('clientIp on Vercel', () => {
  it('reads x-real-ip, IPv4-mapped as IPv4 and IPv6 by its /64', () => {
    onVercel();
    expect(clientIp(vercelRequest('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(vercelRequest('::ffff:203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(vercelRequest('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64');
  });

  it('never reads X-Forwarded-For or the peer header there, even with the preload', () => {
    onVercel();
    preload.__wdkVaultPeerAddress = true;
    vi.stubEnv('TRUSTED_PROXIES', '0.0.0.0/0');
    expect(clientIp(vercelRequest('203.0.113.7', { 'x-forwarded-for': '1.1.1.1', [PEER_ADDRESS_HEADER]: '2.2.2.2' }))).toBe('203.0.113.7');
    expect(clientIp(vercelRequest(null, { 'x-forwarded-for': '1.1.1.1', [PEER_ADDRESS_HEADER]: '2.2.2.2' }))).toBe('unknown');
  });

  it('a missing or list-valued x-real-ip is unknown', () => {
    onVercel();
    expect(clientIp(vercelRequest(null))).toBe('unknown');
    expect(clientIp(vercelRequest(''))).toBe('unknown');
    expect(clientIp(vercelRequest('1.2.3.4, 5.6.7.8'))).toBe('unknown');
  });

  it('outside a Vercel runtime, CLIENT_IP_SOURCE=vercel trusts no header: a client-chosen x-real-ip is ignored', () => {
    vi.stubEnv('CLIENT_IP_SOURCE', 'vercel');
    vi.stubEnv('VERCEL', '1');
    preload.__wdkVaultPeerAddress = true;
    expect(clientIp(vercelRequest('203.0.113.7', { [PEER_ADDRESS_HEADER]: '198.51.100.1' }))).toBe('unknown');
  });

  it('with the default source, x-real-ip is never read', () => {
    preload.__wdkVaultPeerAddress = true;
    expect(clientIp(vercelRequest('203.0.113.7', { [PEER_ADDRESS_HEADER]: '198.51.100.1' }))).toBe('198.51.100.1');
  });
});

describe('limiter', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-rate-limit-'));
  });

  beforeEach(async () => {
    await closeDb();
    vi.stubEnv('DATABASE_URL', `sqlite:${join(dir, `${crypto.randomUUID()}.db`)}`);
    preload.__wdkVaultPeerAddress = true;
  });

  afterAll(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  async function expectLimited(response: Response | null) {
    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const retryAfter = Number(response?.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60).toBe(true);
  }

  it('limits per IP and per sub, each in its own bucket', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ handoff: { ip: 3, sub: 1 } }));
    expect(await rateLimit(request('203.0.113.7'), 'handoff', { sub: 'alice' })).toBeNull();
    // The same sub from another address: the sub limit.
    await expectLimited(await rateLimit(request('198.51.100.1'), 'handoff', { sub: 'alice' }));
    expect(await rateLimit(request('203.0.113.7'), 'handoff', { sub: 'bob' })).toBeNull();
    // A third and fourth hit from the first address: the IP limit, whatever the sub.
    expect(await rateLimit(request('203.0.113.7'), 'handoff')).toBeNull();
    await expectLimited(await rateLimit(request('203.0.113.7'), 'handoff', { sub: 'carol' }));
    // Other scopes and other addresses are untouched.
    expect(await rateLimit(request('203.0.113.7'), 'relink')).toBeNull();
    expect(await rateLimit(request('192.0.2.1'), 'handoff', { sub: 'dave' })).toBeNull();
  });

  it('a scope without a sub limit ignores the sub', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ 'recovery-challenge': { ip: 2 } }));
    expect(await rateLimit(request('203.0.113.7'), 'recovery-challenge', { sub: 'a' })).toBeNull();
    expect(await rateLimit(request('203.0.113.7'), 'recovery-challenge', { sub: 'b' })).toBeNull();
    await expectLimited(await rateLimit(request('203.0.113.7'), 'recovery-challenge', { sub: 'c' }));
  });

  it('a forged X-Forwarded-For does not get a fresh budget', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ aa: { ip: 1 } }));
    expect(await rateLimit(request('203.0.113.7', '1.1.1.1'), 'aa')).toBeNull();
    await expectLimited(await rateLimit(request('203.0.113.7', '2.2.2.2'), 'aa'));
  });

  it('on Vercel, requests with the same x-real-ip share a budget whatever X-Forwarded-For says', async () => {
    onVercel();
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ aa: { ip: 1 } }));
    expect(await rateLimit(vercelRequest('203.0.113.7', { 'x-forwarded-for': '1.1.1.1' }), 'aa')).toBeNull();
    await expectLimited(await rateLimit(vercelRequest('203.0.113.7', { 'x-forwarded-for': '2.2.2.2' }), 'aa'));
    expect(await rateLimit(vercelRequest('198.51.100.1'), 'aa')).toBeNull();
  });

  it('the response does not depend on which limit was exceeded', async () => {
    vi.stubEnv('RATE_LIMITS', JSON.stringify({ relink: { ip: 1, sub: 1 } }));
    await rateLimit(request('203.0.113.7'), 'relink', { sub: 'exists' });
    const bySub = await rateLimit(request('198.51.100.1'), 'relink', { sub: 'exists' });
    const byIp = await rateLimit(request('203.0.113.7'), 'relink', { sub: 'nobody' });
    expect([bySub?.status, byIp?.status]).toEqual([429, 429]);
    expect(await bySub?.text()).toBe(await byIp?.text());
    expect([...(bySub?.headers.keys() ?? [])].sort()).toEqual([...(byIp?.headers.keys() ?? [])].sort());
  });

  it('consumeLimit counts a custom budget', async () => {
    expect(await consumeLimit('share-a:session:x', 2, 3_600_000)).toMatchObject({ allowed: true });
    expect(await consumeLimit('share-a:session:x', 2, 3_600_000)).toMatchObject({ allowed: true });
    const third = await consumeLimit('share-a:session:x', 2, 3_600_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(await consumeLimit('share-a:session:y', 2, 3_600_000)).toMatchObject({ allowed: true });
  });
});

describe('rateLimited', () => {
  it('rounds Retry-After up to whole seconds, at least 1', async () => {
    expect(rateLimited(0.2).headers.get('retry-after')).toBe('1');
    expect(rateLimited(12.1).headers.get('retry-after')).toBe('13');
    expect(await rateLimited(5).json()).toEqual({ error: 'RATE_LIMITED' });
  });
});
