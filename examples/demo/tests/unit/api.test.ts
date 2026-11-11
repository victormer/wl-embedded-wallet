import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ed25519 } from '@noble/curves/ed25519.js';
import { handoffPublicJwk } from '@wl-embedded-wallet/sdk/server';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { generate } from 'otplib';
import type { UserOperationRequest } from '@wl-embedded-wallet/sdk/server';
import { buildUserOperation, ERC1271_MAGIC_VALUE, predictSafeAddress, requestHash, safeMessageTypedData, signSafeOperation, smartAccountFor } from '@wl-embedded-wallet/sdk/server';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as totp } from '@/app/api/auth/totp/route';
import { POST as totpSetup } from '@/app/api/auth/totp/setup/route';
import { GET as jwksDocument } from '@/app/.well-known/jwks.json/route';
import { GET as me } from '@/app/api/me/route';
import { POST as verify } from '@/app/api/signatures/verify/route';
import { POST as token } from '@/app/api/vault/token/route';
import { GET as wallet } from '@/app/api/wallet/route';
import { consumeTotpStep, createUser, getUserByEmail } from '@/server/db';
import { hashPassword } from '@/server/password';
import { useTestDatabase, type TestDatabase } from './test-database';

const ORIGIN = 'http://app.localhost:4300';
const SERVICE_TOKEN = 'test-service-token';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const keys = ed25519.keygen();
const KID = 'test-key';

const signer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

// Fake vault: only the s2s endpoint. Accounts are controlled by `sub`.
const accounts = new Map<string, string>();
const s2sCalls: { sub: string; authorization?: string; query: URLSearchParams }[] = [];
const safe = predictSafeAddress(signer.address);
const CHAIN_ID = 31001;
const OTHER_CHAIN_ID = 31002;
let rpcServer: Server;
let erc1271Result: string = ERC1271_MAGIC_VALUE;
let rpcChainId = CHAIN_ID;
let s2sMode: 'ok' | 'down' = 'ok';
let server: Server;
let database: TestDatabase;

const url = (path: string) => `${ORIGIN}${path}`;

function post(path: string, body?: unknown, options: { cookie?: string; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.cookie) headers.cookie = options.cookie;
  return new Request(url(path), { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function get(path: string, cookie?: string): Request {
  return new Request(url(path), { headers: cookie ? { cookie } : {} });
}

function cookieFrom(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

let counter = 0;

/** Correct password, no second factor: the cookie can only be used to complete it. */
async function pendingUser() {
  const email = `user${++counter}@example.com`;
  const response = await register(post('/api/auth/register', { email, password: 'long-password' }));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { userId: string; next: string };
  expect(body.next).toBe('totp-setup');
  return { email, userId: body.userId, cookie: cookieFrom(response) };
}

async function startSetup(cookie: string): Promise<string> {
  const response = await totpSetup(post('/api/auth/totp/setup', undefined, { cookie }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { secret: string }).secret;
}

const PERIOD_SECONDS = 30;
const currentStep = () => Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
const codeAt = (secret: string, step: number) => generate({ secret, epoch: step * PERIOD_SECONDS });
// Last accepted step per secret: the demo accepts each code once, so a second login in the same step uses the next
// step's code, which is within the tolerance (as a user waiting for the next code would).
const acceptedSteps = new Map<string, number>();

async function submitCode(cookie: string, secret: string): Promise<Response> {
  const step = Math.max(currentStep(), (acceptedSteps.get(secret) ?? -1) + 1);
  const response = await totp(post('/api/auth/totp', { totp: await codeAt(secret, step) }, { cookie }));
  if (response.status === 200) acceptedSteps.set(secret, step);
  return response;
}

async function newUser() {
  const user = await pendingUser();
  const secret = await startSetup(user.cookie);
  const response = await submitCode(user.cookie, secret);
  expect(response.status).toBe(200);
  return { ...user, secret, cookie: cookieFrom(response) };
}

const decodeClaims = async (value: string, publicJwk = handoffPublicJwk(hex(keys.secretKey), KID)) =>
  (await jwtVerify(value, createLocalJWKSet({ keys: [publicJwk] }), { algorithms: ['EdDSA'], issuer: ORIGIN, audience: process.env.VAULT_ORIGIN })).payload;

async function userWithWallet() {
  const user = await newUser();
  accounts.set(user.userId, signer.address);
  return user;
}

const TYPED_DATA = {
  domain: { name: 'Example USD', version: '1', chainId: 11155111, verifyingContract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  types: {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: 'Permit',
  message: {
    owner: signer.address,
    spender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    value: '1000000',
    nonce: '0',
    deadline: '1893456000',
  },
};

const USER_OPERATION: UserOperationRequest = {
  calls: [{ to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: '1000000000000000' }],
  nonce: '0',
  callGasLimit: '100000',
  verificationGasLimit: '200000',
  preVerificationGas: '60000',
  maxFeePerGas: '30000000000',
  maxPriorityFeePerGas: '1500000000',
};

const signAsSafe = (account: typeof signer, request: { kind: 'message'; message: string } | { kind: 'typedData'; typedData: typeof TYPED_DATA }, chainId = CHAIN_ID) =>
  account.signTypedData(safeMessageTypedData(safe, chainId, requestHash(request)));

async function signUserOp(account: typeof signer, request = USER_OPERATION, chainId = CHAIN_ID) {
  const operation = buildUserOperation(safe, request);
  const signature = await signSafeOperation(operation, chainId, smartAccountFor(signer.address), {
    address: account.address,
    signHash: (hash) => account.sign({ hash }),
  });
  return { ...operation, signature };
}

async function checkSignature(cookie: string, request: unknown, signature: string, extra: Record<string, unknown> = {}) {
  const response = await verify(post('/api/signatures/verify', { chainId: CHAIN_ID, request, signature, ...extra }, { cookie }));
  expect(response.status).toBe(200);
  return (await response.json()) as { valid: boolean; recovered: string | null; erc1271: boolean | null };
}

beforeAll(async () => {
  database = useTestDatabase();
  server = createServer((request, response) => {
    if (s2sMode === 'down') {
      response.writeHead(500).end();
      return;
    }
    const authorization = request.headers.authorization;
    const requestUrl = new URL(request.url ?? '', 'http://x');
    const sub = decodeURIComponent(requestUrl.pathname.replace('/api/s2s/accounts/', ''));
    s2sCalls.push({ sub, authorization, query: requestUrl.searchParams });
    if (authorization !== `Bearer ${SERVICE_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const owner = accounts.get(sub);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(owner ? { exists: true, address: predictSafeAddress(owner), owner } : { exists: false, address: null, owner: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  // Chain node: answers `eth_chainId` and the `isValidSignature` read.
  rpcServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      const result = method === 'eth_chainId' ? `0x${rpcChainId.toString(16)}` : erc1271Result.padEnd(66, '0');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((resolve) => rpcServer.listen(0, '127.0.0.1', resolve));
  const rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`;
  process.env.DEMO_CHAINS = JSON.stringify([
    { chainId: CHAIN_ID, name: 'Local A', rpcUrl },
    { chainId: OTHER_CHAIN_ID, name: 'Local B', rpcUrl },
  ]);

  process.env.ORIGIN = ORIGIN;
  // Every request here comes from the same (unknown) address; `rate-limit.test.ts` covers the limits.
  process.env.DEMO_RATE_LIMITS = JSON.stringify(Object.fromEntries(['register', 'login', 'totp', 'totp-setup'].map((scope) => [scope, { ip: 100_000, user: 100_000 }])));
  process.env.VAULT_ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.VAULT_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.DEMO_HANDOFF_PRIVATE_KEY = hex(keys.secretKey);
  process.env.DEMO_HANDOFF_KID = KID;
  process.env.DEMO_TOTP_KEY = 'ef'.repeat(32);
});

afterAll(async () => {
  await database.dispose();
  delete process.env.DEMO_RATE_LIMITS;
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => rpcServer.close(resolve));
});

beforeEach(async () => {
  await database.reset();
  s2sMode = 'ok';
  erc1271Result = ERC1271_MAGIC_VALUE;
  rpcChainId = CHAIN_ID;
});

describe('registration and login', () => {
  it('registers, opens a session with a host-only httpOnly cookie, and does not store the password', async () => {
    const response = await register(post('/api/auth/register', { email: 'New@Example.com', password: 'long-password' }));
    expect(response.status).toBe(201);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const user = await getUserByEmail('new@example.com');
    expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user?.passwordHash).not.toContain('long-password');
    expect(user?.params.N).toBeGreaterThanOrEqual(2 ** 15);

    // Until 2FA is completed, the password grants access to nothing.
    expect((await me(get('/api/me', cookieFrom(response)))).status).toBe(401);
  });

  it('rejects a duplicate email, also with different casing', async () => {
    const { email } = await newUser();
    const response = await register(post('/api/auth/register', { email: email.toUpperCase(), password: 'other-password' }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'EMAIL_TAKEN' });
  });

  it('rejects invalid registration input', async () => {
    for (const body of [{ email: 'not-an-email', password: 'long-password' }, { email: 'a@b.co', password: 'short' }, {}, []]) {
      expect((await register(post('/api/auth/register', body))).status).toBe(400);
    }
  });

  it('login requires the password and the code, and only then opens a session', async () => {
    const { email, userId, secret } = await newUser();
    const response = await login(post('/api/auth/login', { email, password: 'long-password' }));
    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toEqual({ next: 'totp' });
    const pending = cookieFrom(response);
    expect((await me(get('/api/me', pending))).status).toBe(401);

    const verified = await submitCode(pending, secret);
    expect(verified.status).toBe(200);
    const full = cookieFrom(verified);
    await expect((await me(get('/api/me', full))).json()).resolves.toMatchObject({ userId });
    // The token changes when 2FA is completed: the intermediate session's token stops being valid.
    expect(full).not.toBe(pending);
    expect((await submitCode(pending, secret)).status).toBe(401);
  });

  it('a wrong login and an unknown user return the same error and open no session', async () => {
    const { email } = await newUser();
    const wrong = await login(post('/api/auth/login', { email, password: 'wrong-password' }));
    const missing = await login(post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password' }));
    for (const response of [wrong, missing]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    await expect(wrong.json()).resolves.toEqual({ error: 'INVALID_CREDENTIALS' });
    await expect(missing.json()).resolves.toEqual({ error: 'INVALID_CREDENTIALS' });
  });

  it('logout invalidates the session on the server', async () => {
    const { cookie } = await newUser();
    expect((await me(get('/api/me', cookie))).status).toBe(200);
    const response = await logout(post('/api/auth/logout', undefined, { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await me(get('/api/me', cookie))).status).toBe(401);
  });

  it('rejects writes from another origin or with no origin', async () => {
    const { cookie, email } = await newUser();
    for (const origin of ['http://evil.localhost', null]) {
      expect((await login(post('/api/auth/login', { email, password: 'long-password' }, { origin }))).status).toBe(403);
      expect((await token(post('/api/vault/token', undefined, { cookie, origin }))).status).toBe(403);
      expect((await logout(post('/api/auth/logout', undefined, { cookie, origin }))).status).toBe(403);
      expect((await verify(post('/api/signatures/verify', {}, { cookie, origin }))).status).toBe(403);
    }
  });
});

describe('sessions', () => {
  it('every session route answers 401 to an anonymous request, a bogus cookie and a pending session', async () => {
    const { cookie: pending } = await pendingUser();
    const callsBefore = s2sCalls.length;
    for (const cookie of [undefined, 'demo_session=bogus', pending]) {
      const responses = [
        await me(get('/api/me', cookie)),
        await wallet(get('/api/wallet', cookie)),
        await token(post('/api/vault/token', undefined, { cookie })),
        await verify(post('/api/signatures/verify', { chainId: CHAIN_ID, request: { kind: 'message', message: 'hi' }, signature: '0x00' }, { cookie })),
      ];
      for (const response of responses) {
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: 'UNAUTHORIZED' });
      }
    }
    // The second-factor routes take only a pending session.
    for (const cookie of [undefined, 'demo_session=bogus']) {
      expect((await totpSetup(post('/api/auth/totp/setup', undefined, { cookie }))).status).toBe(401);
      await expect((await totp(post('/api/auth/totp', { totp: '123456' }, { cookie }))).json()).resolves.toEqual({ error: 'UNAUTHORIZED' });
    }
    expect(s2sCalls.length).toBe(callsBefore);
  });
});

describe('second factor', () => {
  it('until it is completed, no token is issued and the wallet is not queried, even with the correct password', async () => {
    const { cookie, email } = await pendingUser();
    const callsBefore = s2sCalls.length;
    expect((await token(post('/api/vault/token', undefined, { cookie }))).status).toBe(401);
    expect((await wallet(get('/api/wallet', cookie))).status).toBe(401);
    expect((await verify(post('/api/signatures/verify', {}, { cookie }))).status).toBe(401);

    const secret = await startSetup(cookie);
    const relogged = cookieFrom(await login(post('/api/auth/login', { email, password: 'long-password' })));
    expect((await token(post('/api/vault/token', undefined, { cookie: relogged }))).status).toBe(401);
    expect((await totp(post('/api/auth/totp', { totp: '000000' }, { cookie }))).status).toBe(401);
    expect((await token(post('/api/vault/token', undefined, { cookie }))).status).toBe(401);
    expect(s2sCalls.length).toBe(callsBefore);

    const verified = cookieFrom(await submitCode(cookie, secret));
    expect((await token(post('/api/vault/token', undefined, { cookie: verified }))).status).toBe(200);
  });

  it('a wrong or malformed code does not complete 2FA', async () => {
    const { cookie, email } = await pendingUser();
    const secret = await startSetup(cookie);
    const code = await generate({ secret });
    const wrong = code === '000000' ? '000001' : '000000';
    for (const value of [wrong, 'abcdef', '123', 123456, undefined]) {
      const response = await totp(post('/api/auth/totp', { totp: value }, { cookie }));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'INVALID_TOTP' });
    }
    expect((await me(get('/api/me', cookie))).status).toBe(401);
    expect((await getUserByEmail(email))?.totpConfirmed).toBe(false);
  });

  it('the secret is stored encrypted and the QR code carries the correct key', async () => {
    const { cookie, email } = await pendingUser();
    const response = await totpSetup(post('/api/auth/totp/setup', undefined, { cookie }));
    const { secret, otpauthUri } = (await response.json()) as { secret: string; otpauthUri: string };
    const uri = new URL(otpauthUri);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(secret);
    const stored = (await getUserByEmail(email))?.totpSecretEnc;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(secret);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('another key cannot decrypt the secret, and without a key setup fails', async () => {
    const { cookie } = await pendingUser();
    const secret = await startSetup(cookie);
    const original = process.env.DEMO_TOTP_KEY;
    try {
      process.env.DEMO_TOTP_KEY = 'ab'.repeat(32);
      const response = await submitCode(cookie, secret);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'INTERNAL' });
      process.env.DEMO_TOTP_KEY = '';
      expect((await totpSetup(post('/api/auth/totp/setup', undefined, { cookie }))).status).toBe(500);
    } finally {
      process.env.DEMO_TOTP_KEY = original;
    }
  });

  it('a confirmed 2FA cannot be replaced with only the password', async () => {
    const { email, secret } = await newUser();
    const pending = cookieFrom(await login(post('/api/auth/login', { email, password: 'long-password' })));
    const response = await totpSetup(post('/api/auth/totp/setup', undefined, { cookie: pending }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'TOTP_ALREADY_ENROLLED' });
    expect((await submitCode(pending, secret)).status).toBe(200);
  });

  it('an account created before 2FA sets it up on its next login, without losing the account', async () => {
    const email = `legacy${++counter}@example.com`;
    const user = await createUser({ email, ...(await hashPassword('long-password')) });
    const response = await login(post('/api/auth/login', { email, password: 'long-password' }));
    await expect(response.clone().json()).resolves.toEqual({ next: 'totp-setup' });
    const pending = cookieFrom(response);
    const verified = await submitCode(pending, await startSetup(pending));
    await expect((await me(get('/api/me', cookieFrom(verified)))).json()).resolves.toMatchObject({ userId: user?.id });
  });

  it('requires an origin and a session, and a complete session cannot set anything up again', async () => {
    expect((await totpSetup(post('/api/auth/totp/setup'))).status).toBe(401);
    expect((await totp(post('/api/auth/totp', { totp: '123456' }))).status).toBe(401);
    const { cookie } = await pendingUser();
    expect((await totpSetup(post('/api/auth/totp/setup', undefined, { cookie, origin: 'http://evil.localhost' }))).status).toBe(403);
    expect((await totp(post('/api/auth/totp', { totp: '123456' }, { cookie, origin: null }))).status).toBe(403);
    const full = await newUser();
    expect((await totpSetup(post('/api/auth/totp/setup', undefined, { cookie: full.cookie }))).status).toBe(401);
  });
});

describe('second factor replay', () => {
  const relogin = async (email: string) => cookieFrom(await login(post('/api/auth/login', { email, password: 'long-password' })));
  const send = (cookie: string, code: string) => totp(post('/api/auth/totp', { totp: code }, { cookie }));

  it('a code that was already accepted is rejected, also from another session, and a later one is accepted', async () => {
    const { cookie, email } = await pendingUser();
    const secret = await startSetup(cookie);
    const step = currentStep();
    const code = await codeAt(secret, step);
    expect((await send(cookie, code)).status).toBe(200);

    const reused = await send(await relogin(email), code);
    expect(reused.status).toBe(401);
    await expect(reused.json()).resolves.toEqual({ error: 'INVALID_TOTP' });
    // The previous step is still within the tolerance, but it is not after the accepted one.
    expect((await send(await relogin(email), await codeAt(secret, step - 1))).status).toBe(401);

    const later = await send(await relogin(email), await codeAt(secret, step + 1));
    expect(later.status).toBe(200);
    expect((await getUserByEmail(email))?.totpLastStep).toBe(step + 1);
  });

  it('records the step the code matched, not the current one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const { cookie, email } = await pendingUser();
      const secret = await startSetup(cookie);
      const step = currentStep();
      // The next step's code is accepted within the tolerance.
      const next = await codeAt(secret, step + 1);
      expect((await send(cookie, next)).status).toBe(200);
      expect((await getUserByEmail(email))?.totpLastStep).toBe(step + 1);

      // Once that step is the current one, the same code is still a reuse.
      vi.setSystemTime((step + 1) * PERIOD_SECONDS * 1000 + 1000);
      expect((await send(await relogin(email), next)).status).toBe(401);
      expect((await send(await relogin(email), await codeAt(secret, step + 2))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two concurrent requests with the same code: only one completes 2FA', async () => {
    const { email, secret } = await newUser();
    const code = await codeAt(secret, (acceptedSteps.get(secret) as number) + 1);
    const [first, second] = [await relogin(email), await relogin(email)];
    const responses = await Promise.all([send(first, code), send(second, code)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 401]);
    expect(responses.filter(({ headers }) => headers.get('set-cookie'))).toHaveLength(1);
  });

  it('the step only moves forward', async () => {
    const user = (await createUser({ email: `steps${++counter}@example.com`, passwordHash: 'x', passwordSalt: 'x', params: { N: 2, r: 1, p: 1 } }))!;
    expect(await consumeTotpStep(user.id, 100)).toBe(true);
    expect(await consumeTotpStep(user.id, 100)).toBe(false);
    expect(await consumeTotpStep(user.id, 99)).toBe(false);
    expect(await consumeTotpStep(user.id, 101)).toBe(true);
    expect((await getUserByEmail(user.email))?.totpLastStep).toBe(101);
  });
});

describe('public JWKS', () => {
  it('publishes only the public key, with kid and Cache-Control, and requires no session', async () => {
    const response = jwksDocument();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/);
    const { keys: published } = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(published).toEqual([handoffPublicJwk(hex(keys.secretKey), KID)]);
    expect(published[0]).not.toHaveProperty('d');
    expect(JSON.stringify(published)).not.toContain(Buffer.from(keys.secretKey).toString('base64url'));
  });

  it('during a rotation it signs with the new key and keeps publishing the previous one', async () => {
    const previous = ed25519.keygen();
    process.env.DEMO_HANDOFF_PUBLISHED_KEYS = JSON.stringify([{ kid: 'previous', publicKey: hex(previous.publicKey) }]);
    try {
      const { keys: published } = (await jwksDocument().json()) as { keys: { kid: string }[] };
      expect(published.map(({ kid }) => kid)).toEqual([KID, 'previous']);
      const { cookie } = await newUser();
      const { token: value } = (await (await token(post('/api/vault/token', undefined, { cookie }))).json()) as { token: string };
      expect(JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString())).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: KID });
    } finally {
      delete process.env.DEMO_HANDOFF_PUBLISHED_KEYS;
    }
  });

  it('with incomplete or invalid configuration it responds with an error, without details', async () => {
    process.env.DEMO_HANDOFF_PUBLISHED_KEYS = '{no-json';
    try {
      const response = jwksDocument();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'INTERNAL' });
    } finally {
      delete process.env.DEMO_HANDOFF_PUBLISHED_KEYS;
    }
  });
});

describe('handoff token', () => {
  it('requires a session', async () => {
    const noCookie = await token(post('/api/vault/token'));
    expect(noCookie.status).toBe(401);
    expect((await token(post('/api/vault/token', undefined, { cookie: 'demo_session=bogus' }))).status).toBe(401);
  });

  it('is a dedicated JWT for the vault, with the UUID and the email, distinct from the session cookie', async () => {
    const { cookie, email, userId } = await newUser();
    const response = await token(post('/api/vault/token', undefined, { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { token: value } = (await response.json()) as { token: string };
    const claims = await decodeClaims(value);
    expect(claims).toMatchObject({ iss: ORIGIN, aud: process.env.VAULT_ORIGIN, origin: ORIGIN, sub: userId, label: email });
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(value).not.toContain(cookie.split('=')[1]);
  });

  it('the origin comes from configuration, never from the client', async () => {
    const { cookie } = await newUser();
    const response = await token(post('/api/vault/token', { origin: 'https://evil.test', chainId: CHAIN_ID }, { cookie }));
    expect((await decodeClaims(((await response.json()) as { token: string }).token)).origin).toBe(ORIGIN);
  });

  it('another app sharing the login signs with the same iss and its own origin', async () => {
    const { cookie } = await newUser();
    const origin = process.env.ORIGIN;
    process.env.DEMO_HANDOFF_ISSUER = ORIGIN;
    process.env.ORIGIN = 'http://app2.localhost:4302';
    try {
      const response = await token(new Request(url('/api/vault/token'), { method: 'POST', headers: { origin: process.env.ORIGIN, cookie } }));
      expect((await decodeClaims(((await response.json()) as { token: string }).token)).origin).toBe('http://app2.localhost:4302');
    } finally {
      process.env.ORIGIN = origin;
      delete process.env.DEMO_HANDOFF_ISSUER;
    }
  });

  it('does not verify with another public key', async () => {
    const { cookie } = await newUser();
    const { token: value } = (await (await token(post('/api/vault/token', undefined, { cookie }))).json()) as { token: string };
    await expect(decodeClaims(value, handoffPublicJwk(hex(ed25519.keygen().secretKey), KID))).rejects.toThrow();
  });

  it('signs the chain and resolves the RPC on the server, ignoring the browser one', async () => {
    const { cookie } = await newUser();
    const response = await token(post('/api/vault/token', { chainId: CHAIN_ID, rpcUrl: 'http://malicious.test' }, { cookie }));
    const { token: value } = (await response.json()) as { token: string };
    const { chain } = (await decodeClaims(value)) as { chain?: { chainId: number; rpcUrl: string } };
    expect(chain?.chainId).toBe(CHAIN_ID);
    expect(chain?.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1/);
  });

  it('rejects a chain not in DEMO_CHAINS, and signs no chain when none is given', async () => {
    const { cookie } = await newUser();
    expect((await token(post('/api/vault/token', { chainId: 999 }, { cookie }))).status).toBe(400);
    const { token: value } = (await (await token(post('/api/vault/token', {}, { cookie }))).json()) as { token: string };
    expect((await decodeClaims(value)).chain).toBeUndefined();
  });

  it('each token has a distinct jti', async () => {
    const { cookie } = await newUser();
    const read = async () => {
      const { token: value } = (await (await token(post('/api/vault/token', undefined, { cookie }))).json()) as { token: string };
      return (await decodeClaims(value)).jti;
    };
    expect(await read()).not.toBe(await read());
  });
});

describe('chain configuration', () => {
  it('an invalid DEMO_CHAINS fails every route that reads it with INTERNAL, without echoing the value', async () => {
    const { cookie } = await userWithWallet();
    const original = process.env.DEMO_CHAINS;
    const secretRpc = 'https://rpc.example.test/v2/secret-api-key';
    try {
      for (const value of ['{no-json', JSON.stringify([{ chainId: CHAIN_ID, name: 'A', rpcUrl: `ftp://x/${secretRpc}` }])]) {
        process.env.DEMO_CHAINS = value;
        const responses = [
          await token(post('/api/vault/token', { chainId: CHAIN_ID }, { cookie })),
          await wallet(get(`/api/wallet?chainId=${CHAIN_ID}`, cookie)),
          await verify(post('/api/signatures/verify', { chainId: CHAIN_ID, request: { kind: 'message', message: 'hi' }, signature: '0x00' }, { cookie })),
        ];
        for (const response of responses) {
          expect(response.status).toBe(500);
          await expect(response.json()).resolves.toEqual({ error: 'INTERNAL' });
        }
      }
    } finally {
      process.env.DEMO_CHAINS = original;
    }
  });
});

describe('wallet', () => {
  it('requires a session and does not call the vault without one', async () => {
    const before = s2sCalls.length;
    expect((await wallet(get('/api/wallet'))).status).toBe(401);
    expect(s2sCalls.length).toBe(before);
  });

  it('without a vault account it returns exists false, using the service token', async () => {
    const { cookie, userId } = await newUser();
    const response = await wallet(get('/api/wallet', cookie));
    await expect(response.json()).resolves.toEqual({ exists: false, address: null, owner: null });
    expect(s2sCalls.at(-1)).toMatchObject({ sub: userId, authorization: `Bearer ${SERVICE_TOKEN}` });
  });

  it('with an account it returns the existing Safe and its owner', async () => {
    const { cookie } = await userWithWallet();
    await expect((await wallet(get('/api/wallet', cookie))).json()).resolves.toEqual({ exists: true, address: safe, owner: signer.address });
  });

  it('passes the chain and RPC from DEMO_CHAINS to the vault', async () => {
    const { cookie } = await userWithWallet();
    await wallet(get(`/api/wallet?chainId=${CHAIN_ID}`, cookie));
    const { query } = s2sCalls.at(-1)!;
    expect(query.get('chainId')).toBe(String(CHAIN_ID));
    expect(query.get('rpcUrl')).toMatch(/^http:\/\/127\.0\.0\.1/);
    expect((await wallet(get('/api/wallet?chainId=999', cookie))).status).toBe(400);
  });

  it('if the vault fails it responds 502 without leaking details', async () => {
    const { cookie } = await newUser();
    s2sMode = 'down';
    const response = await wallet(get('/api/wallet', cookie));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'VAULT_UNAVAILABLE' });
  });
});

describe('signature verification', () => {
  const MESSAGE = { kind: 'message', message: 'hello' } as const;

  it('requires a session, a known chain and a vault account', async () => {
    const signature = await signAsSafe(signer, MESSAGE);
    expect((await verify(post('/api/signatures/verify', { chainId: CHAIN_ID, request: MESSAGE, signature }))).status).toBe(401);

    const { cookie } = await newUser();
    const response = await verify(post('/api/signatures/verify', { chainId: CHAIN_ID, request: MESSAGE, signature }, { cookie }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'NO_WALLET' });
    expect((await verify(post('/api/signatures/verify', { chainId: 999, request: MESSAGE, signature }, { cookie }))).status).toBe(400);
  });

  it('rejects malformed input', async () => {
    const { cookie } = await userWithWallet();
    const signature = await signAsSafe(signer, MESSAGE);
    for (const body of [{ chainId: CHAIN_ID, signature }, { chainId: CHAIN_ID, request: { kind: 'other' }, signature }, { chainId: CHAIN_ID, request: MESSAGE, signature: 'not-hex' }, { request: MESSAGE, signature }]) {
      expect((await verify(post('/api/signatures/verify', body, { cookie }))).status).toBe(400);
    }
  });

  it('ignores an address sent by the client', async () => {
    const { cookie } = await userWithWallet();
    const signature = await signAsSafe(stranger, MESSAGE);
    const body = { chainId: CHAIN_ID, request: MESSAGE, signature, address: stranger.address, expected: stranger.address, owner: stranger.address };
    const response = await verify(post('/api/signatures/verify', body, { cookie }));
    await expect(response.json()).resolves.toMatchObject({ valid: false, recovered: stranger.address, expected: signer.address });
  });

  describe('message and EIP-712, against the Safe with ERC-1271', () => {
    const TYPED = { kind: 'typedData', typedData: TYPED_DATA } as const;

    it.each([['a message', MESSAGE], ['EIP-712', TYPED]] as const)('accepts %s if the contract validates it', async (_label, request) => {
      const { cookie } = await userWithWallet();
      await expect(checkSignature(cookie, request, await signAsSafe(signer, request))).resolves.toEqual(
        expect.objectContaining({ valid: true, recovered: signer.address, erc1271: true }),
      );
    });

    it('the contract decides: even with the correct signer, it is not valid without ERC-1271', async () => {
      const { cookie } = await userWithWallet();
      erc1271Result = '0xffffffff';
      await expect(checkSignature(cookie, MESSAGE, await signAsSafe(signer, MESSAGE))).resolves.toMatchObject({ valid: false, erc1271: false });
    });

    it('an RPC for another chain does not make the signature valid', async () => {
      const { cookie } = await userWithWallet();
      rpcChainId = OTHER_CHAIN_ID;
      await expect(checkSignature(cookie, MESSAGE, await signAsSafe(signer, MESSAGE))).resolves.toMatchObject({ valid: false, erc1271: null });
    });

    it('a signature for another chain or from another account does not recover the owner', async () => {
      const { cookie } = await userWithWallet();
      expect((await checkSignature(cookie, MESSAGE, await signAsSafe(signer, MESSAGE, OTHER_CHAIN_ID))).valid).toBe(false);
      expect((await checkSignature(cookie, MESSAGE, await signAsSafe(stranger, MESSAGE))).valid).toBe(false);
      expect((await checkSignature(cookie, { kind: 'message', message: 'other' }, await signAsSafe(signer, MESSAGE))).valid).toBe(false);
    });

    it('rejects a malformed signature and unhashable data without a server error', async () => {
      const { cookie } = await userWithWallet();
      expect((await checkSignature(cookie, MESSAGE, '0x1234')).valid).toBe(false);
      const signature = await signAsSafe(signer, MESSAGE);
      expect((await checkSignature(cookie, { kind: 'typedData', typedData: { ...TYPED_DATA, primaryType: 'Nope' } }, signature)).valid).toBe(false);
    });
  });

  describe('UserOperation', () => {
    const request = { kind: 'userOperation', userOperation: USER_OPERATION };

    it('accepts the signed operation that matches the request', async () => {
      const { cookie } = await userWithWallet();
      const userOperation = await signUserOp(signer);
      await expect(checkSignature(cookie, request, userOperation.signature, { userOperation })).resolves.toMatchObject({ valid: true, recovered: signer.address, erc1271: null });
    });

    it('rejects another signer or another chain', async () => {
      const { cookie } = await userWithWallet();
      const fromStranger = await signUserOp(stranger);
      expect((await checkSignature(cookie, request, fromStranger.signature, { userOperation: fromStranger })).valid).toBe(false);
      const otherChain = await signUserOp(signer, USER_OPERATION, OTHER_CHAIN_ID);
      expect((await checkSignature(cookie, request, otherChain.signature, { userOperation: otherChain })).valid).toBe(false);
    });

    it('rejects a tampered sender or calls, even when correctly signed', async () => {
      const { cookie } = await userWithWallet();
      const userOperation = await signUserOp(signer);
      const other = { ...request, userOperation: { ...USER_OPERATION, calls: [{ to: USER_OPERATION.calls[0]!.to, value: '5' }] } };
      expect((await checkSignature(cookie, other, userOperation.signature, { userOperation })).valid).toBe(false);
      const wrongSender = { ...userOperation, sender: stranger.address };
      expect((await checkSignature(cookie, request, userOperation.signature, { userOperation: wrongSender })).valid).toBe(false);
      const withFactory = { ...userOperation, factory: stranger.address, factoryData: '0x' };
      expect((await checkSignature(cookie, request, userOperation.signature, { userOperation: withFactory })).valid).toBe(false);
    });

    it('rejects when the operation is missing or its signature does not match', async () => {
      const { cookie } = await userWithWallet();
      const userOperation = await signUserOp(signer);
      expect((await checkSignature(cookie, request, userOperation.signature)).valid).toBe(false);
      expect((await checkSignature(cookie, request, '0x1234', { userOperation })).valid).toBe(false);
    });
  });
});
