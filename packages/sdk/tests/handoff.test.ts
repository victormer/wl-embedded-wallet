import { ed25519 } from '@noble/curves/ed25519.js';
import { importJWK, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createHandoffToken, ed25519PublicJwk, HANDOFF_TTL_SECONDS, HandoffError, handoffPublicJwk } from '../src/server/handoff';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const { secretKey, publicKey } = ed25519.keygen();
const PRIVATE = hex(secretKey);
const CONFIG = { iss: 'https://login.example', aud: 'https://vault.example', origin: 'https://app.example', kid: 'key-1' };

const decodePart = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('handoff token', () => {
  it('is a compact EdDSA JWT with the contract claims', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createHandoffToken({ sub: 'user-1', label: 'a@b.c', nowSeconds: now, ...CONFIG }, PRIVATE);
    const [header, payload, signature] = token.split('.');
    expect(decodePart(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'key-1' });
    const claims = decodePart(payload);
    expect(claims).toMatchObject({ iss: CONFIG.iss, aud: CONFIG.aud, origin: CONFIG.origin, sub: 'user-1', label: 'a@b.c', iat: now, exp: now + HANDOFF_TTL_SECONDS });
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(HANDOFF_TTL_SECONDS).toBe(60);
    expect(ed25519.verify(Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`), publicKey)).toBe(true);
  });

  it('a standard JWT library verifies it with the published JWK', async () => {
    const chain = { chainId: 31001, rpcUrl: 'https://rpc.example' };
    const token = createHandoffToken({ sub: 'user-1', label: 'a@b.c', chain, ...CONFIG }, PRIVATE);
    const key = await importJWK(handoffPublicJwk(PRIVATE, CONFIG.kid), 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, key, { algorithms: ['EdDSA'], issuer: CONFIG.iss, audience: CONFIG.aud });
    expect(protectedHeader.kid).toBe(CONFIG.kid);
    expect(payload.sub).toBe('user-1');
    expect(payload.chain).toEqual(chain);
  });

  it('another key does not verify it, nor does another issuer or audience', async () => {
    const token = createHandoffToken({ sub: 'user-1', label: 'a@b.c', ...CONFIG }, PRIVATE);
    const verify = async (key: Uint8Array, options = {}) => jwtVerify(token, await importJWK(handoffPublicJwk(hex(key), 'x'), 'EdDSA'), options);
    await expect(verify(ed25519.keygen().secretKey)).rejects.toThrow();
    await expect(verify(secretKey, { issuer: 'other' })).rejects.toThrow();
    await expect(verify(secretKey, { audience: 'other' })).rejects.toThrow();
  });

  it('the JWK has no private material, and the public key yields the same JWK', () => {
    const jwk = handoffPublicJwk(PRIVATE, 'key-1');
    expect(jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url'), kid: 'key-1', use: 'sig', alg: 'EdDSA' });
    expect(JSON.stringify(jwk)).not.toContain(Buffer.from(secretKey).toString('base64url'));
    expect(ed25519PublicJwk(hex(publicKey), 'key-1')).toEqual(jwk);
    expect(() => ed25519PublicJwk('ab', 'x')).toThrow(HandoffError);
    expect(() => handoffPublicJwk(PRIVATE, '')).toThrow(HandoffError);
  });

  it('generates a different jti for every token', () => {
    const jti = () => decodePart(createHandoffToken({ sub: 'u', label: 'l', ...CONFIG }, PRIVATE).split('.')[1]).jti;
    expect(jti()).not.toBe(jti());
  });

  it.each([{ sub: 'a|b' }, { sub: '' }, { iss: '' }, { aud: '' }, { origin: '' }])('refuses to mint with %j', (patch) => {
    expect(() => createHandoffToken({ sub: 'u', label: 'l', ...CONFIG, ...patch }, PRIVATE)).toThrow(HandoffError);
  });

  it('interoperates: a jose token and an SDK token have the same format', async () => {
    const key = await importJWK({ ...handoffPublicJwk(PRIVATE, 'x'), d: Buffer.from(secretKey).toString('base64url') }, 'EdDSA');
    const token = await new SignJWT({ label: 'l' }).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'x' }).setSubject('u').sign(key);
    expect(decodePart(token.split('.')[0])).toEqual(decodePart(createHandoffToken({ sub: 'u', label: 'l', ...CONFIG, kid: 'x' }, PRIVATE).split('.')[0]));
  });
});
