import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHandoffToken, handoffPublicJwk } from '@wl-embedded-wallet/sdk/server';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSigner, mintVaultToken } from '../../../../packages/sdk/examples/mint-token-jose';
import { POST as postHandoff } from '../../app/api/auth/handoff/route';
import { GET as getHealth } from '../../app/api/health/route';
import { hexEncode } from '@wl-embedded-wallet/core/encoding';
import { consumeHandoffToken, verifyHandoffToken } from '../../server/handoff';
import { closeDb } from '../../server/store';

const ISSUER = 'https://login.test';
const AUDIENCE = 'https://vault.test';
const APP = 'https://app.test';
const CLAIMS = { iss: ISSUER, aud: AUDIENCE, origin: APP };
const CONSUME = { origin: APP };
const USER = 'user-1';

// Short durations: caching and cooldown belong to `jose`, and are tested in real time.
const CACHE = 0.4;
const COOLDOWN = 0.1;
const MAX_STALE = 1;
const WAIT_MARGIN_MS = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newKey(kid: string) {
  const privateKey = hexEncode(ed25519.keygen().secretKey);
  return { kid, privateKey, jwk: handoffPublicJwk(privateKey, kid) };
}

/** A real JWKS endpoint, so the download goes through `fetch` and `jose`. */
function jwksServer() {
  const state = {
    keys: [] as unknown[],
    mode: 'ok' as 'ok' | 'down' | 'redirect' | 'huge' | 'not-json',
    hits: 0,
    redirectHits: 0,
  };
  const server: Server = createServer((request, response) => {
    if (request.url === '/target') {
      state.redirectHits += 1;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ keys: state.keys }));
      return;
    }
    state.hits += 1;
    if (state.mode === 'down') {
      response.statusCode = 503;
      response.end();
    } else if (state.mode === 'redirect') {
      response.statusCode = 302;
      response.setHeader('Location', '/target');
      response.end();
    } else if (state.mode === 'huge') {
      response.end(JSON.stringify({ keys: state.keys, padding: 'x'.repeat(70_000) }));
    } else if (state.mode === 'not-json') {
      response.end('<html>');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ keys: state.keys }));
    }
  });
  return { state, server };
}

describe('token verification with JWKS', () => {
  let dir: string;
  let jwks: ReturnType<typeof jwksServer>;
  let logged: string[];

  const mint = (key: ReturnType<typeof newKey>, overrides: Record<string, unknown> = {}) =>
    createHandoffToken({ sub: USER, label: 'a@b.c', kid: key.kid, ...CLAIMS, ...overrides } as never, key.privateKey);

  function configure(overrides: { cache?: number; cooldown?: number; maxStale?: number } = {}) {
    process.env.HANDOFF_JWKS_CACHE_SECONDS = String(overrides.cache ?? CACHE);
    process.env.HANDOFF_JWKS_COOLDOWN_SECONDS = String(overrides.cooldown ?? COOLDOWN);
    process.env.HANDOFF_JWKS_MAX_STALE_SECONDS = String(overrides.maxStale ?? MAX_STALE);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vault-handoff-'));
    jwks = jwksServer();
    await new Promise<void>((resolve) => jwks.server.listen(0, '127.0.0.1', resolve));
    const { port } = jwks.server.address() as AddressInfo;
    process.env.DATABASE_URL = `sqlite:${join(dir, 'vault.db')}`;
    process.env.HANDOFF_JWKS_URL = `http://127.0.0.1:${port}/.well-known/jwks.json`;
    process.env.HANDOFF_ISSUER = ISSUER;
    process.env.HANDOFF_AUDIENCE = AUDIENCE;
    process.env.ORIGIN = AUDIENCE;
    delete process.env.HANDOFF_PUBLIC_KEY;
    configure();
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void logged.push(args.join(' ')));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await new Promise((resolve) => jwks.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    for (const name of ['HANDOFF_JWKS_URL', 'HANDOFF_ISSUER', 'HANDOFF_AUDIENCE', 'HANDOFF_JWKS_CACHE_SECONDS', 'HANDOFF_JWKS_COOLDOWN_SECONDS', 'HANDOFF_JWKS_MAX_STALE_SECONDS']) {
      delete process.env[name];
    }
  });

  it.each(['EdDSA', 'ES256', 'RS256'] as const)('accepts %s with the published keys, including the documentation example', async (alg) => {
    const signer = await createSigner(alg, `key-${alg}`);
    jwks.state.keys = [signer.jwk];
    const token = await mintVaultToken(signer, { id: USER, email: 'a@b.c' }, CLAIMS);
    await expect(consumeHandoffToken(token, CONSUME)).resolves.toMatchObject({ sub: USER, label: 'a@b.c', iss: ISSUER, aud: AUDIENCE });
    await expect(consumeHandoffToken(token, CONSUME)).rejects.toThrowError('REPLAYED');
  });

  it('a new key is valid after the refresh, without a restart, and the old one stops being valid when the cache expires', async () => {
    const before = newKey('old');
    const after = newKey('new');
    jwks.state.keys = [before.jwk];
    await expect(verifyHandoffToken(mint(before))).resolves.toMatchObject({ sub: USER });

    // Rotation: the new key signs and the previous one is still published.
    jwks.state.keys = [after.jwk, before.jwk];
    await sleep(COOLDOWN * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(after))).resolves.toMatchObject({ sub: USER });
    await expect(verifyHandoffToken(mint(before))).resolves.toMatchObject({ sub: USER });

    // Removal: while the cache is still live it is accepted, and once it expires it is rejected.
    jwks.state.keys = [after.jwk];
    await expect(verifyHandoffToken(mint(before))).resolves.toMatchObject({ sub: USER });
    await sleep(CACHE * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(before))).rejects.toThrowError('UNKNOWN_KEY');
    await expect(verifyHandoffToken(mint(after))).resolves.toMatchObject({ sub: USER });
  });

  it('rejects an unknown kid, a missing kid and a key that is not published', async () => {
    const published = newKey('published');
    jwks.state.keys = [published.jwk];
    await expect(verifyHandoffToken(mint(newKey('other')))).rejects.toThrowError('UNKNOWN_KEY');
    await expect(verifyHandoffToken(mint({ ...published, kid: '' }))).rejects.toThrowError('UNKNOWN_KEY');
    // Same `kid`, different key: knowing the identifier is not enough.
    await expect(verifyHandoffToken(mint({ ...newKey('published') }))).rejects.toThrowError('BAD_SIGNATURE');
    jwks.state.keys = [];
    await sleep(COOLDOWN * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(newKey('nobody')))).rejects.toThrowError('UNKNOWN_KEY');
  });

  it('a burst of made-up kids does not multiply the downloads', async () => {
    const published = newKey('published');
    jwks.state.keys = [published.jwk];
    configure({ cache: 60, cooldown: 30, maxStale: 3600 });
    await verifyHandoffToken(mint(published));
    expect(jwks.state.hits).toBe(1);

    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => verifyHandoffToken(mint(newKey(`made-up-${index}`)))));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (let index = 0; index < 50; index += 1) await expect(verifyHandoffToken(mint(newKey(`other-${index}`)))).rejects.toThrowError('UNKNOWN_KEY');
    expect(jwks.state.hits).toBe(1);
  });

  it('with the JWKS down it uses the recent cache, and once that expires it fails closed and logs it without data', async () => {
    const key = newKey('key');
    jwks.state.keys = [key.jwk];
    await verifyHandoffToken(mint(key));

    jwks.state.mode = 'down';
    await sleep(CACHE * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(key))).resolves.toMatchObject({ sub: USER });
    expect(logged.join('\n')).toContain('HTTP 503');
    expect(logged.join('\n')).toContain('cache');

    await sleep(MAX_STALE * 1000 + WAIT_MARGIN_MS);
    const token = mint(key);
    await expect(verifyHandoffToken(token)).rejects.toThrowError('KEYS_UNAVAILABLE');
    const output = logged.join('\n');
    expect(output).toContain('tokens are rejected');
    expect(output).not.toContain(token);
    expect(output).not.toContain('127.0.0.1');

    // When the JWKS comes back it recovers on its own.
    jwks.state.mode = 'ok';
    await sleep(COOLDOWN * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(key))).resolves.toMatchObject({ sub: USER });
  });

  it('an outage does not cause one download per token', async () => {
    const key = newKey('key');
    jwks.state.keys = [key.jwk];
    configure({ cache: 0.05, cooldown: 30, maxStale: 0.05 });
    await verifyHandoffToken(mint(key));
    jwks.state.mode = 'down';
    await sleep(120);
    const hits = jwks.state.hits;
    for (let index = 0; index < 20; index += 1) await expect(verifyHandoffToken(mint(key))).rejects.toThrowError('KEYS_UNAVAILABLE');
    expect(jwks.state.hits - hits).toBe(1);
  });

  it('a down JWKS with no cache responds INVALID_TOKEN and does not affect /api/health', async () => {
    const key = newKey('key');
    jwks.state.mode = 'down';
    const headers = new Headers({ origin: AUDIENCE, 'content-type': 'application/json' });
    const response = await postHandoff(new NextRequest(`${AUDIENCE}/api/auth/handoff`, { method: 'POST', headers, body: JSON.stringify({ token: mint(key), origin: APP }) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'INVALID_TOKEN' });

    const hits = jwks.state.hits;
    expect((await getHealth()).status).toBe(200);
    expect(jwks.state.hits).toBe(hits);
  });

  it('does not follow redirects', async () => {
    const key = newKey('key');
    jwks.state.keys = [key.jwk];
    jwks.state.mode = 'redirect';
    await expect(verifyHandoffToken(mint(key))).rejects.toThrowError('KEYS_UNAVAILABLE');
    expect(jwks.state.redirectHits).toBe(0);
    expect(logged.join('\n')).toContain('HTTP 302');
  });

  it.each(['huge', 'not-json'] as const)('rejects a %s document', async (mode) => {
    const key = newKey('key');
    jwks.state.keys = [key.jwk];
    jwks.state.mode = mode;
    await expect(verifyHandoffToken(mint(key))).rejects.toThrowError('KEYS_UNAVAILABLE');
  });

  it('a JWKS with private material is rejected, and the cache stops being valid too', async () => {
    const key = newKey('key');
    jwks.state.keys = [key.jwk];
    await verifyHandoffToken(mint(key));

    // Private key published by mistake: anyone could sign, so nothing from that source is valid.
    jwks.state.keys = [{ ...key.jwk, d: Buffer.from(key.privateKey, 'hex').toString('base64url') }];
    await sleep(CACHE * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(key))).rejects.toThrowError('KEYS_UNAVAILABLE');
    await expect(verifyHandoffToken(mint(key))).rejects.toThrowError('KEYS_UNAVAILABLE');
    const output = logged.join('\n');
    expect(output).toContain('private or symmetric keys');
    expect(output).not.toContain(key.privateKey);

    jwks.state.keys = [key.jwk];
    await sleep(COOLDOWN * 1000 + WAIT_MARGIN_MS);
    await expect(verifyHandoffToken(mint(key))).resolves.toMatchObject({ sub: USER });
  });

  it('rejects a published symmetric key', async () => {
    const key = newKey('key');
    jwks.state.keys = [{ kty: 'oct', kid: 'key', k: 'AAAA' }];
    await expect(verifyHandoffToken(mint(key))).rejects.toThrowError('KEYS_UNAVAILABLE');
  });

  describe('algorithms', () => {
    it('rejects alg none without downloading anything', async () => {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const token = `${part({ alg: 'none', typ: 'JWT', kid: 'key' })}.${part({ ...CLAIMS, sub: USER, label: 'l', jti: 'j', iat: now, exp: now + 60 })}.`;
      await expect(verifyHandoffToken(token)).rejects.toThrow();
      expect(jwks.state.hits).toBe(0);
    });

    it('rejects HS256 signed with the published public key', async () => {
      const key = newKey('key');
      jwks.state.keys = [key.jwk];
      const secret = new TextEncoder().encode(JSON.stringify(key.jwk));
      const token = await new SignJWT({ label: 'l' })
        .setProtectedHeader({ alg: 'HS256', kid: 'key' })
        .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(USER).setJti('j').setIssuedAt().setExpirationTime('60s')
        .sign(secret);
      await expect(verifyHandoffToken(token)).rejects.toThrowError('BAD_ALGORITHM');
      expect(jwks.state.hits).toBe(0);
    });

    it('rejects an asymmetric algorithm outside the list, even if its key is published', async () => {
      const { publicKey, privateKey } = await generateKeyPair('ES384');
      jwks.state.keys = [{ ...(await exportJWK(publicKey)), kid: 'es384', alg: 'ES384' }];
      const token = await new SignJWT({ label: 'l' })
        .setProtectedHeader({ alg: 'ES384', kid: 'es384' })
        .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(USER).setJti('j').setIssuedAt().setExpirationTime('60s')
        .sign(privateKey);
      await expect(verifyHandoffToken(token)).rejects.toThrowError('BAD_ALGORITHM');
    });

    it('ignores a key embedded in the header: the key never comes from the token', async () => {
      const attacker = newKey('key');
      const { secretKey } = ed25519.keygen();
      jwks.state.keys = [handoffPublicJwk(hexEncode(secretKey), 'key')];
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const input = `${part({ alg: 'EdDSA', kid: 'key', jwk: attacker.jwk })}.${part({ ...CLAIMS, sub: USER, label: 'l', jti: 'j', iat: now, exp: now + 60 })}`;
      const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(input), Buffer.from(attacker.privateKey, 'hex'))).toString('base64url');
      await expect(verifyHandoffToken(`${input}.${signature}`)).rejects.toThrowError('BAD_SIGNATURE');
    });
  });

  describe('claims', () => {
    const key = newKey('key');
    beforeEach(() => {
      jwks.state.keys = [key.jwk];
    });

    /** Signs arbitrary claims with the good key, to test what the SDK does not let you create. */
    function forge(claims: Record<string, unknown>): string {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const body = { ...CLAIMS, sub: USER, label: 'l', jti: 'jti-1', iat: now, exp: now + 60, ...claims };
      const input = `${part({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${part(body)}`;
      const signature = ed25519.sign(new TextEncoder().encode(input), Buffer.from(key.privateKey, 'hex'));
      return `${input}.${Buffer.from(signature).toString('base64url')}`;
    }
    const now = () => Math.floor(Date.now() / 1000);

    it('a well-formed token is accepted', async () => {
      await expect(verifyHandoffToken(forge({}))).resolves.toMatchObject({ sub: USER });
    });

    it('a label of up to 256 characters, in any script, is accepted', async () => {
      for (const label of ['', 'a'.repeat(256), 'José Ñúñez · 山田太郎 <jose@example.com>']) {
        await expect(verifyHandoffToken(forge({ label }))).resolves.toMatchObject({ label });
      }
    });

    it.each([
      ['issuer', { iss: 'https://other.test' }, 'BAD_ISSUER'],
      ['missing issuer', { iss: undefined }, 'BAD_ISSUER'],
      ['audience', { aud: 'https://other.test' }, 'BAD_AUDIENCE'],
      ['missing audience', { aud: undefined }, 'BAD_AUDIENCE'],
      ['sub with the AAD separator', { sub: 'a|b' }, 'MALFORMED'],
      ['missing sub', { sub: undefined }, 'MALFORMED'],
      ['missing jti', { jti: undefined }, 'MALFORMED'],
      ['missing label', { label: undefined }, 'MALFORMED'],
      ['label that is not a string', { label: 5 }, 'MALFORMED'],
      ['label over 256 characters', { label: 'a'.repeat(257) }, 'MALFORMED'],
      ['label with a line break', { label: 'alice\nadmin' }, 'MALFORMED'],
      ['label with a NUL', { label: 'alice\u0000' }, 'MALFORMED'],
      ['label with a C1 control character', { label: 'alice\u0085' }, 'MALFORMED'],
      ['missing iat', { iat: undefined }, 'MALFORMED'],
      ['missing exp', { exp: undefined }, 'MALFORMED'],
      ['missing origin', { origin: undefined }, 'MALFORMED'],
      ['origin with a path', { origin: 'https://app.test/path' }, 'MALFORMED'],
      ['origin over http', { origin: 'http://app.test' }, 'MALFORMED'],
      ['invalid chain', { chain: { chainId: -1 } }, 'MALFORMED'],
      ['chain with an invalid rpcUrl', { chain: { chainId: 1, rpcUrl: 5 } }, 'MALFORMED'],
    ])('rejects %s, even with a valid signature', async (_label, patch, reason) => {
      await expect(verifyHandoffToken(forge(patch))).rejects.toThrowError(reason);
    });

    it('the audience is ORIGIN unless another one is configured', async () => {
      delete process.env.HANDOFF_AUDIENCE;
      process.env.ORIGIN = 'https://origin.test';
      await expect(verifyHandoffToken(forge({ aud: 'https://origin.test' }))).resolves.toMatchObject({ sub: USER });
      await expect(verifyHandoffToken(forge({}))).rejects.toThrowError('BAD_AUDIENCE');
    });

    it('rejects an expired token or one with a lifetime over 120 s', async () => {
      await expect(verifyHandoffToken(forge({ iat: now() - 100, exp: now() - 1 }))).rejects.toThrowError('EXPIRED');
      await expect(verifyHandoffToken(forge({ exp: now() + 121 }))).rejects.toThrowError('MALFORMED');
      await expect(verifyHandoffToken(forge({ iat: now() - 200, exp: now() + 30 }))).rejects.toThrowError('MALFORMED');
      await expect(verifyHandoffToken(forge({ iat: now() + 100, exp: now() + 110 }))).rejects.toThrowError('MALFORMED');
      await expect(verifyHandoffToken(forge({ exp: now() + 120 }))).resolves.toMatchObject({ sub: USER });
    });

    it('the request origin must be the signed one, and a rejection does not use up the token', async () => {
      const token = forge({ origin: 'https://app.test/', jti: 'from-app1' });
      await expect(consumeHandoffToken(token, { origin: 'https://other.test' })).rejects.toThrowError('ORIGIN_MISMATCH');
      await expect(consumeHandoffToken(token, { origin: undefined })).rejects.toThrowError('ORIGIN_MISMATCH');
      await expect(consumeHandoffToken(token, { origin: 'null' })).rejects.toThrowError('ORIGIN_MISMATCH');
      await expect(consumeHandoffToken(token, CONSUME)).resolves.toMatchObject({ origin: APP, jti: 'from-app1' });
    });

    it('ALLOWED_APP_ORIGINS restricts even when the token is valid, and when unset allows any', async () => {
      const other = 'https://other.test';
      process.env.ALLOWED_APP_ORIGINS = `${APP}, https://third.test`;
      try {
        await expect(consumeHandoffToken(forge({ origin: other, jti: 'a' }), { origin: other })).rejects.toThrowError('ORIGIN_NOT_ALLOWED');
        await expect(consumeHandoffToken(forge({ jti: 'b' }), CONSUME)).resolves.toMatchObject({ origin: APP });
      } finally {
        delete process.env.ALLOWED_APP_ORIGINS;
      }
      await expect(consumeHandoffToken(forge({ origin: other, jti: 'a' }), { origin: other })).resolves.toMatchObject({ origin: other });
    });

    it('the network must be the signed one, and a mismatch does not use up the token', async () => {
      const token = forge({ jti: 'with-chain', chain: { chainId: 5 } });
      await expect(consumeHandoffToken(token, { ...CONSUME, chainId: 6 })).rejects.toThrowError('CHAIN_REQUEST_MISMATCH');
      await expect(consumeHandoffToken(token, CONSUME)).rejects.toThrowError('CHAIN_REQUEST_MISMATCH');
      await expect(consumeHandoffToken(forge({ jti: 'without-chain' }), { ...CONSUME, chainId: 5 })).rejects.toThrowError('CHAIN_REQUEST_MISMATCH');
      await expect(consumeHandoffToken(token, { ...CONSUME, chainId: 5 })).resolves.toMatchObject({ jti: 'with-chain' });
      await expect(consumeHandoffToken(token, { ...CONSUME, chainId: 5 })).rejects.toThrowError('REPLAYED');
    });

    it('a jti is only valid once', async () => {
      const token = forge({ jti: 'unique' });
      await expect(consumeHandoffToken(token, CONSUME)).resolves.toMatchObject({ jti: 'unique' });
      await expect(consumeHandoffToken(forge({ jti: 'unique' }), CONSUME)).rejects.toThrowError('REPLAYED');
    });

    it.each(['', 'a', 'a.b.c', 'a.b', '!!.!!.!!', '..'])('rejects the malformed token %j', async (token) => {
      await expect(verifyHandoffToken(token)).rejects.toThrow();
    });

    it('the error never includes the token', async () => {
      const token = forge({ iss: 'https://other.test' });
      const error = await verifyHandoffToken(token).catch((cause: Error) => cause);
      expect((error as Error).message).toBe('BAD_ISSUER');
      expect(String((error as Error).stack)).not.toContain(token);
    });
  });
});
