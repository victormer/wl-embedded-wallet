import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as totp } from '@/app/api/auth/totp/route';
import { POST as totpSetup } from '@/app/api/auth/totp/setup/route';
import { clientIp, DEFAULT_RATE_LIMITS, normalizeIp, rateLimitRule } from '@/server/rate-limit';
import { postgresUrl, useTestDatabase, type TestDatabase } from './test-database';

const ORIGIN = 'http://app.localhost:4300';
let database: TestDatabase;
let counter = 0;

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

const cookieFrom = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0];
const limits = (value: unknown) => {
  process.env.DEMO_RATE_LIMITS = JSON.stringify(value);
};
// Wrong credentials: no account to look up, so the only cost is the limiter and the dummy scrypt.
const badLogin = (headers: Record<string, string> = {}) => login(post('/api/auth/login', { email: 'nobody@example.com', password: 'long-password' }, headers));

async function expectLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const retryAfter = Number(response.headers.get('retry-after'));
  expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60).toBe(true);
  await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
}

/** A registered user whose pending session is ready to submit codes. */
async function pendingUser() {
  const response = await register(post('/api/auth/register', { email: `limit${++counter}@example.com`, password: 'long-password' }));
  expect(response.status).toBe(201);
  const cookie = cookieFrom(response);
  const setup = await totpSetup(post('/api/auth/totp/setup', undefined, { cookie }));
  expect(setup.status).toBe(200);
  return { cookie, secret: ((await setup.json()) as { secret: string }).secret };
}

beforeAll(() => {
  database = useTestDatabase();
  process.env.ORIGIN = ORIGIN;
  process.env.DEMO_TOTP_KEY = 'ef'.repeat(32);
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await database.reset();
  delete process.env.DEMO_RATE_LIMITS;
});

afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_REGION;
});

describe('rules', () => {
  it('defaults per 60 s window', () => {
    expect(DEFAULT_RATE_LIMITS).toEqual({
      register: { ip: 10, user: null },
      login: { ip: 20, user: null },
      totp: { ip: 20, user: 10 },
      'totp-setup': { ip: 20, user: 10 },
    });
    expect(rateLimitRule('totp', {})).toEqual({ windowMs: 60_000, ip: 20, user: 10 });
  });

  it('DEMO_RATE_LIMITS overrides each valid field; anything invalid falls back to the default', () => {
    const env = (value: unknown) => ({ DEMO_RATE_LIMITS: typeof value === 'string' ? value : JSON.stringify(value) });
    expect(rateLimitRule('login', env({ login: { ip: 3, windowSeconds: 10 } }))).toEqual({ windowMs: 10_000, ip: 3, user: null });
    expect(rateLimitRule('totp', env({ totp: { user: '4' } }))).toEqual({ windowMs: 60_000, ip: 20, user: 4 });
    expect(rateLimitRule('login', env({ login: { ip: 0, windowSeconds: -1 } }))).toEqual({ windowMs: 60_000, ip: 20, user: null });
    for (const raw of ['{no-json', '[]', '"x"', JSON.stringify({ login: 5 }), JSON.stringify({ login: { ip: 1.5 } })]) {
      expect(rateLimitRule('login', env(raw))).toEqual({ windowMs: 60_000, ip: 20, user: null });
    }
  });
});

describe('client address', () => {
  const request = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/auth/login`, { headers });
  const vercel = { VERCEL: '1', VERCEL_REGION: 'iad1' };

  it('off Vercel, every request shares one bucket whatever the headers say', () => {
    const headers = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' };
    expect(clientIp(request(headers), {})).toBe('unknown');
    // `vercel env pull` writes VERCEL=1 but no VERCEL_REGION: a local run with it does not trust the header.
    expect(clientIp(request(headers), { VERCEL: '1' })).toBe('unknown');
    expect(clientIp(request(headers), { VERCEL_REGION: 'iad1' })).toBe('unknown');
  });

  it('on Vercel, reads only x-real-ip, normalised; IPv6 by /64', () => {
    expect(clientIp(request({ 'x-real-ip': '203.0.113.7' }), vercel)).toBe('203.0.113.7');
    expect(clientIp(request({ 'x-real-ip': '::ffff:203.0.113.7' }), vercel)).toBe('203.0.113.7');
    expect(clientIp(request({ 'x-real-ip': '2001:DB8:1:2:3:4:5:6' }), vercel)).toBe('2001:db8:1:2::/64');
    expect(clientIp(request({ 'x-real-ip': '2001:db8::1' }), vercel)).toBe('2001:db8:0:0::/64');
    expect(clientIp(request({ 'x-real-ip': 'not-an-ip' }), vercel)).toBe('unknown');
    expect(clientIp(request({ 'x-forwarded-for': '198.51.100.1' }), vercel)).toBe('unknown');
    expect(clientIp(request({}), vercel)).toBe('unknown');
  });

  it('normalizes addresses', () => {
    expect(normalizeIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeIp('203.0.113.7:443')).toBe('203.0.113.7');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%en0')).toBe('fe80::1');
    expect(normalizeIp('example.com')).toBeNull();
  });
});

describe('auth routes', () => {
  it('register: 429 after the per-IP limit, before any work, and x-real-ip is ignored off Vercel', async () => {
    limits({ register: { ip: 2 } });
    // Invalid input still counts: the limit runs before parsing and scrypt.
    expect((await register(post('/api/auth/register', {}))).status).toBe(400);
    expect((await register(post('/api/auth/register', {}, { 'x-real-ip': '203.0.113.1' }))).status).toBe(400);
    await expectLimited(await register(post('/api/auth/register', { email: 'new@example.com', password: 'long-password' }, { 'x-real-ip': '203.0.113.2' })));
    expect(await database.rows("SELECT id FROM users WHERE email = 'new@example.com'")).toHaveLength(0);
  });

  it('login: 429 after the per-IP limit, with Retry-After; another scope is not affected', async () => {
    limits({ login: { ip: 2 } });
    expect((await badLogin()).status).toBe(401);
    expect((await badLogin()).status).toBe(401);
    await expectLimited(await badLogin());
    await expectLimited(await badLogin({ 'x-forwarded-for': '198.51.100.1' }));
    expect((await register(post('/api/auth/register', {}))).status).toBe(400);
  });

  it('a foreign origin is rejected before it counts', async () => {
    limits({ login: { ip: 1 } });
    for (let i = 0; i < 3; i += 1) expect((await badLogin({ origin: 'http://evil.localhost' })).status).toBe(403);
    expect((await badLogin()).status).toBe(401);
  });

  it('totp: per-user limit, whatever the address, and other accounts are not affected', async () => {
    limits({ totp: { ip: 1000, user: 2 } });
    const target = await pendingUser();
    const wrong = (await generate({ secret: target.secret })) === '000000' ? '000001' : '000000';
    for (let i = 0; i < 2; i += 1) {
      const response = await totp(post('/api/auth/totp', { totp: wrong }, { cookie: target.cookie }));
      expect(response.status).toBe(401);
    }
    // Even the right code is refused once the budget is spent.
    await expectLimited(await totp(post('/api/auth/totp', { totp: await generate({ secret: target.secret }) }, { cookie: target.cookie })));

    const other = await pendingUser();
    expect((await totp(post('/api/auth/totp', { totp: await generate({ secret: other.secret }) }, { cookie: other.cookie }))).status).toBe(200);
  });

  it('totp: per-IP limit also counts requests without a session', async () => {
    limits({ totp: { ip: 2 } });
    expect((await totp(post('/api/auth/totp', { totp: '123456' }))).status).toBe(401);
    expect((await totp(post('/api/auth/totp', { totp: '123456' }))).status).toBe(401);
    await expectLimited(await totp(post('/api/auth/totp', { totp: '123456' })));
  });

  it('totp/setup: per-user limit', async () => {
    limits({ 'totp-setup': { user: 2 } });
    const { cookie } = await pendingUser();
    expect((await totpSetup(post('/api/auth/totp/setup', undefined, { cookie }))).status).toBe(200);
    await expectLimited(await totpSetup(post('/api/auth/totp/setup', undefined, { cookie })));
  });

  // VERCEL=1 requires DATABASE_URL, so this runs under `pnpm test:pg`.
  it.skipIf(!postgresUrl)('on Vercel, keys by x-real-ip and never by x-forwarded-for', async () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_REGION = 'iad1';
    limits({ login: { ip: 1 } });
    expect((await badLogin({ 'x-real-ip': '203.0.113.1' })).status).toBe(401);
    await expectLimited(await badLogin({ 'x-real-ip': '203.0.113.1' }));
    await expectLimited(await badLogin({ 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.9' }));
    expect((await badLogin({ 'x-real-ip': '203.0.113.2', 'x-forwarded-for': '203.0.113.1' })).status).toBe(401);
    // Without x-real-ip, x-forwarded-for does not give a request its own bucket.
    expect((await badLogin({ 'x-forwarded-for': '198.51.100.1' })).status).toBe(401);
    await expectLimited(await badLogin({ 'x-forwarded-for': '198.51.100.2' }));
  });
});
