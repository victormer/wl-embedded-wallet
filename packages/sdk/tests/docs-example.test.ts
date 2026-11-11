import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jwksResponse, mintVaultToken } from '../examples/mint-token';
import * as withJose from '../examples/mint-token-jose';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const { secretKey } = ed25519.keygen();
const LOGIN = 'https://login.example.com';
const APP = 'https://app.example.com';
const VAULT = 'https://vault.example.com';
const USER = { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', email: 'ana@example.com' };
const OPTIONS = { issuer: LOGIN, audience: VAULT, algorithms: ['EdDSA', 'ES256', 'RS256'] };

describe('docs/INTEGRATION.md examples', () => {
  beforeEach(() => {
    Object.assign(process.env, { VAULT_HANDOFF_PRIVATE_KEY: hex(secretKey), VAULT_HANDOFF_KID: 'key-1', LOGIN_ISSUER: LOGIN, APP_ORIGIN: APP, VAULT_ORIGIN: VAULT });
  });

  afterEach(() => {
    for (const name of ['VAULT_HANDOFF_PRIVATE_KEY', 'VAULT_HANDOFF_KID', 'LOGIN_ISSUER', 'APP_ORIGIN', 'VAULT_ORIGIN']) delete process.env[name];
  });

  it.each(['mint-token.ts', 'mint-token-jose.ts'])('the document contains %s verbatim', (file) => {
    const example = readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8');
    const docs = readFileSync(new URL('../../../docs/INTEGRATION.md', import.meta.url), 'utf8');
    expect(docs).toContain(example);
  });

  it('the SDK token verifies against its JWKS endpoint, with and without a network', async () => {
    const response = jwksResponse();
    expect(response.headers.get('cache-control')).toContain('max-age');
    const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const keys = createLocalJWKSet(jwks as never);

    const plain = await jwtVerify(mintVaultToken(USER), keys, OPTIONS);
    expect(plain.protectedHeader.kid).toBe('key-1');
    expect(plain.payload).toMatchObject({ sub: USER.id, label: USER.email, origin: APP });
    expect(plain.payload.chain).toBeUndefined();

    const chain = { chainId: 11155111, rpcUrl: 'https://rpc.example.com' };
    expect((await jwtVerify(mintVaultToken(USER, chain), keys, OPTIONS)).payload.chain).toEqual(chain);
  });

  it('an id that does not match the format is rejected', () => {
    expect(() => mintVaultToken({ id: 'ana@example.com', email: 'ana@example.com' })).toThrow();
  });

  it.each(['EdDSA', 'ES256', 'RS256'] as const)('the jose example mints %s and its JWKS has no private key', async (alg) => {
    const signer = await withJose.createSigner(alg, `key-${alg}`);
    const jwks = (await withJose.jwksResponse([signer]).json()) as { keys: Record<string, unknown>[] };
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(jwks.keys[0]).not.toHaveProperty(field);
    const token = await withJose.mintVaultToken(signer, USER, { iss: LOGIN, aud: VAULT, origin: APP });
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks as never), OPTIONS);
    expect(protectedHeader).toMatchObject({ alg, kid: `key-${alg}`, typ: 'JWT' });
    expect(payload).toMatchObject({ sub: USER.id, label: USER.email });
    expect(payload.jti).toBeTruthy();
  });
});
