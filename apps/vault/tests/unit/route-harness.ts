import { ed25519 } from '@noble/curves/ed25519.js';
import { createHandoffToken } from '@wl-embedded-wallet/sdk/server';
import { smartAccountFor } from '@wl-embedded-wallet/core/safe';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { POST as postHandoff } from '../../app/api/auth/handoff/route';
import { PATCH as patchShares, POST as postShares } from '../../app/api/shares/route';
import { hexDecode, hexEncode, randomBytes, sha256Hex } from '@wl-embedded-wallet/core/encoding';
import type { Envelope, RegistrationJson } from '@wl-embedded-wallet/core/types';
import { SESSION_COOKIE } from '../../server/http';
import { closeDb } from '../../server/store';
import { resetPostgres } from '../store/postgres-test';

export const ORIGIN = 'http://vault.test';
export const RP_ID = 'vault.test';
export const APP_ORIGIN = 'https://app.test';
export const ISSUER = 'https://login.test';

export const SHARE_A = '0102030405060708090a0b0c0d0e0f101112131415';
const handoffKeys = ed25519.keygen();
const manifestKeys = ed25519.keygen();

/** Route environment, with SQLite or, with `pnpm test:pg`, against Postgres. */
export function useRouteEnv(): void {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-routes-'));
    process.env.MASTER_KEY = hexEncode(randomBytes(32));
    process.env.MANIFEST_SIGNING_KEY = hexEncode(manifestKeys.secretKey);
    process.env.HANDOFF_PUBLIC_KEY = hexEncode(handoffKeys.publicKey);
    process.env.HANDOFF_ISSUER = ISSUER;
    process.env.VAULT_SERVICE_TOKEN = 'service-token';
    process.env.ORIGIN = ORIGIN;
    process.env.RP_ID = RP_ID;
  });
  beforeEach(async () => {
    await closeDb();
    const postgresUrl = process.env.TEST_DATABASE_URL;
    if (postgresUrl) await resetPostgres(postgresUrl);
    process.env.DATABASE_URL = postgresUrl ?? `sqlite:${join(dir, `${crypto.randomUUID()}.db`)}`;
  });
  afterAll(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
}

type Options = { method?: string; cookie?: string; origin?: string | null; body?: unknown; appOrigin?: string | null; authorization?: string };

export function req(path: string, { method = 'POST', cookie, origin, body, appOrigin = APP_ORIGIN, authorization }: Options = {}) {
  const headers = new Headers();
  const effectiveOrigin = origin === undefined ? (method === 'GET' ? null : ORIGIN) : origin;
  if (effectiveOrigin) headers.set('origin', effectiveOrigin);
  if (cookie) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`);
  if (cookie && appOrigin) headers.set('x-vault-app-origin', appOrigin);
  if (authorization) headers.set('authorization', authorization);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const CLAIMS = { iss: ISSUER, aud: ORIGIN, origin: APP_ORIGIN };

/** A handoff JWT signed with the vault's configured key. */
export function handoffToken(sub: string, extra: { label?: string; jti?: string; chain?: { chainId: number } } = {}): string {
  return createHandoffToken({ sub, label: `${sub}@example.com`, ...CLAIMS, ...extra }, hexEncode(handoffKeys.secretKey));
}

export function sessionCookieOf(response: Response): string {
  return /__Host-vault_session=([^;]+)/.exec(response.headers.get('set-cookie') as string)?.[1] as string;
}

/** Real session: redeems a signed JWT. */
export async function openSession(sub: string): Promise<string> {
  const response = await postHandoff(req('/api/auth/handoff', { body: { token: handoffToken(sub), origin: APP_ORIGIN } }));
  expect(response.status).toBe(200);
  return sessionCookieOf(response);
}

/** The shape of every 429: no detail on which budget ran out, no-store, and `Retry-After` in whole seconds. */
export async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: 'RATE_LIMITED' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  const retryAfter = Number(response.headers.get('retry-after'));
  expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
}

const envelope = (share: 'B' | 'C', kdf: Envelope['kdf'], userId: string, setId: string): Envelope => ({
  v: 1,
  share,
  userId,
  setId,
  kdf,
  kdfParams: {},
  salt: 'AAAAAAAAAAAAAAAAAAAAAA',
  iv: 'AAAAAAAAAAAAAAAA',
  ct: 'AAAA',
});

export async function sharesBody(userId: string, address: string, extra: { credentialId?: string; registration?: RegistrationJson } = {}) {
  const setId = crypto.randomUUID();
  return {
    setId,
    credentialId: extra.credentialId ?? 'Y3JlZA',
    shareA: SHARE_A,
    encB: envelope('B', 'prf-hkdf-sha256', userId, setId),
    encC: envelope('C', 'argon2id', userId, setId),
    shareDigests: { A: await sha256Hex(hexDecode(SHARE_A)), B: 'b'.repeat(64), C: 'c'.repeat(64) },
    expectedAddress: address,
    smartAccount: smartAccountFor(address),
    wdkUtilsVersion: '1.0.0-beta.16',
    ...(extra.registration ? { registration: extra.registration } : {}),
  };
}

/** Creates and activates a wallet through the routes. */
export async function activeWallet(cookie: string, userId: string, address: string, extra: { credentialId?: string; registration?: RegistrationJson } = {}): Promise<string> {
  const body = await sharesBody(userId, address, extra);
  const created = await postShares(req('/api/shares', { cookie, body }));
  expect(created.status).toBe(201);
  expect((await patchShares(req('/api/shares', { method: 'PATCH', cookie, body: { setId: body.setId } }))).status).toBe(200);
  return body.setId;
}

export const MANIFEST_PUBKEY = hexEncode(manifestKeys.publicKey);
