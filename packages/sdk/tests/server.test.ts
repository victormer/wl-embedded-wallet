import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createHandoffSigner,
  createVaultServiceClient,
  generateHandoffSigner,
  HANDOFF_TTL_SECONDS,
  HandoffError,
  jwks,
  jwksHandler,
  jwksResponse,
  VaultUnavailableError,
  type HandoffAlgorithm,
} from '../src/server';

const CLAIMS = { sub: 'user-1', label: 'ana@example.com', iss: 'https://login.example.com', aud: 'https://vault.example.com', origin: 'https://app.example.com' };
const VERIFY = { issuer: CLAIMS.iss, audience: CLAIMS.aud, algorithms: ['EdDSA', 'ES256', 'RS256'] };
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

const pemFor: Record<HandoffAlgorithm, () => string> = {
  EdDSA: () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  ES256: () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  RS256: () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
};

describe('handoff signers (EdDSA, ES256, RS256)', () => {
  it.each(['EdDSA', 'ES256', 'RS256'] as const)('%s: a PEM key mints a token that verifies against its public JWK', async (alg) => {
    const signer = createHandoffSigner({ alg, kid: `key-${alg}`, privateKey: pemFor[alg]() });
    for (const member of PRIVATE_MEMBERS) expect(signer.publicJwk).not.toHaveProperty(member);
    expect(signer.publicJwk).toMatchObject({ kid: `key-${alg}`, alg, use: 'sig' });

    const chain = { chainId: 11155111, rpcUrl: 'https://rpc.example.com' };
    const token = await signer.mint({ ...CLAIMS, chain });
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks([signer.publicJwk]) as never), VERIFY);
    expect(protectedHeader).toEqual({ alg, kid: `key-${alg}`, typ: 'JWT' });
    expect(payload).toMatchObject({ sub: CLAIMS.sub, label: CLAIMS.label, origin: CLAIMS.origin, chain });
    expect(payload.exp! - payload.iat!).toBe(HANDOFF_TTL_SECONDS);
    expect(payload.jti).toBeTruthy();
  });

  it.each(['EdDSA', 'ES256', 'RS256'] as const)('%s: a generated signer works the same way', async (alg) => {
    const signer = await generateHandoffSigner(alg, 'generated');
    const token = await signer.mint({ ...CLAIMS, jti: 'fixed', nowSeconds: Math.floor(Date.now() / 1000) });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks([signer.publicJwk]) as never), VERIFY);
    expect(payload.jti).toBe('fixed');
    expect(payload).not.toHaveProperty('chain');
  });

  it('a private JWK is accepted too', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const signer = createHandoffSigner({ alg: 'ES256', kid: 'jwk', privateKey: privateKey.export({ format: 'jwk' }) });
    expect(decodeJwt(await signer.mint(CLAIMS)).sub).toBe(CLAIMS.sub);
  });

  it('rejects a key that does not match the algorithm, a weak RSA key and an empty kid', () => {
    expect(() => createHandoffSigner({ alg: 'ES256', kid: 'x', privateKey: pemFor.EdDSA() })).toThrow(HandoffError);
    expect(() => createHandoffSigner({ alg: 'EdDSA', kid: 'x', privateKey: pemFor.RS256() })).toThrow(HandoffError);
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    expect(() => createHandoffSigner({ alg: 'RS256', kid: 'x', privateKey: weak })).toThrow(HandoffError);
    expect(() => createHandoffSigner({ alg: 'EdDSA', kid: '', privateKey: pemFor.EdDSA() })).toThrow(HandoffError);
    expect(() => createHandoffSigner({ alg: 'EdDSA', kid: 'x', privateKey: 'not a key' })).toThrow(HandoffError);
  });

  it('rejects a `sub` that cannot go into the envelope AAD, and missing claims', async () => {
    const signer = await generateHandoffSigner('EdDSA', 'k');
    await expect(signer.mint({ ...CLAIMS, sub: 'ana@example.com' })).rejects.toThrow(HandoffError);
    await expect(signer.mint({ ...CLAIMS, sub: 'a|b' })).rejects.toThrow(HandoffError);
    await expect(signer.mint({ ...CLAIMS, origin: '' })).rejects.toThrow(HandoffError);
  });
});

describe('JWKS helpers', () => {
  it('refuses to publish private material', () => {
    expect(() => jwks([{ kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'secret' }])).toThrow('JWKS_PRIVATE_KEY');
  });

  it('jwksResponse is cacheable, jwksHandler answers 500 without configuration', async () => {
    const signer = await generateHandoffSigner('ES256', 'k');
    const response = jwksResponse([signer.publicJwk]);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await response.json()).toEqual({ keys: [signer.publicJwk] });

    expect((await jwksHandler(() => [signer.publicJwk], { maxAgeSeconds: 60 })().json())).toEqual({ keys: [signer.publicJwk] });
    const missing = jwksHandler(() => null)();
    expect(missing.status).toBe(500);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(await missing.json()).toEqual({ error: 'INTERNAL' });
    expect(jwksHandler(() => {
      throw new Error('boom');
    })().status).toBe(500);
  });

  it('jwksHandler answers a clean 500 when a key carries private material, and publishes nothing', async () => {
    const signer = await generateHandoffSigner('ES256', 'k');
    const response = jwksHandler(() => [signer.publicJwk, { kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'secret' }])();
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'INTERNAL' });
    expect(body).not.toContain('secret');
  });
});

describe('server-to-server account client', () => {
  const ADDRESS = '0x1111111111111111111111111111111111111111';
  const OWNER = '0x2222222222222222222222222222222222222222';

  function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    return { calls, client: createVaultServiceClient({ vaultOrigin: 'https://vault.example.com', serviceToken: 'service-token', fetch: fetcher }) };
  }

  it('sends the service token and returns the account, with the chain state when asked', async () => {
    const { calls, client: vault } = client(() => Response.json({ exists: true, address: ADDRESS, owner: OWNER, chainId: 1, deployed: false }));
    expect(await vault.getAccount('user/1', { chainId: 1, rpcUrl: 'https://rpc.example.com' })).toMatchObject({ exists: true, address: ADDRESS, deployed: false });
    expect(calls[0].url).toBe('https://vault.example.com/api/s2s/accounts/user%2F1?chainId=1&rpcUrl=https%3A%2F%2Frpc.example.com');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer service-token');
    await vault.getAccount('user-1');
    expect(calls[1].url).toBe('https://vault.example.com/api/s2s/accounts/user-1');
  });

  it('removes trailing slashes from vaultOrigin', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return Response.json({ exists: false });
    }) as unknown as typeof fetch;
    for (const vaultOrigin of ['https://vault.example.com/', 'https://vault.example.com//']) {
      await createVaultServiceClient({ vaultOrigin, serviceToken: 'service-token', fetch: fetcher }).getAccount('user-1', { chainId: 1 });
    }
    expect(calls).toEqual(['https://vault.example.com/api/s2s/accounts/user-1?chainId=1', 'https://vault.example.com/api/s2s/accounts/user-1?chainId=1']);
  });

  it('a user without a wallet', async () => {
    const { client: vault } = client(() => Response.json({ exists: false }));
    expect(await vault.getAccount('user-1')).toEqual({ exists: false, address: null, owner: null });
  });

  it.each([
    ['an error status', () => new Response('', { status: 401 })],
    ['a malformed body', () => Response.json({ exists: true, address: 'nope', owner: OWNER })],
    ['a network failure', () => Promise.reject(new Error('offline'))],
  ])('%s throws VaultUnavailableError', async (_name, respond) => {
    const { client: vault } = client(respond as () => Response);
    await expect(vault.getAccount('user-1')).rejects.toBeInstanceOf(VaultUnavailableError);
  });
});
