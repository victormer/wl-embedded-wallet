import { isB64url, isEnvelope, isSignedManifest } from '@wl-embedded-wallet/core/schema';
import { WalletError, type AssertionJson, type ChainStatus, type Envelope, type WalletErrorCode, type RelinkChallenge, type SignedManifest } from '@wl-embedded-wallet/core/types';

export interface ShareSet {
  setId: string;
  status: 'pending' | 'active';
  credentialId: string;
  encB: Envelope;
  encC: Envelope;
  signed: SignedManifest;
  exportedAt: string | null;
}

// Origin verified by the server when redeeming the token. It only exists from that point on.
let verifiedAppOrigin: string | null = null;

export function currentAppOrigin(): string | null {
  return verifiedAppOrigin;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (verifiedAppOrigin) headers.set('X-Vault-App-Origin', verifiedAppOrigin);
  try {
    return await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, headers });
  } catch {
    throw new WalletError('NETWORK');
  }
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
}

function assertOk(response: Response): void {
  if (response.status === 401 || response.status === 403) throw new WalletError('UNAUTHORIZED');
  assertNotLimited(response);
  if (!response.ok) throw new WalletError('INTERNAL');
}

/** A 429 reaches the user and the app as `RATE_LIMITED`, not as an internal error. */
function assertNotLimited(response: Response): void {
  if (response.status === 429) throw new WalletError('RATE_LIMITED');
}

/** `null` if the user does not have that set yet. */
export async function fetchShareSet(setId?: string): Promise<ShareSet | null> {
  const response = await call(setId ? `/api/shares?setId=${encodeURIComponent(setId)}` : '/api/shares');
  if (response.status === 404) return null;
  assertOk(response);
  const body = (await response.json()) as Record<string, unknown>;
  const signed = { manifest: body.manifest, signature: body.signature };
  if (
    !isEnvelope(body.encB, 'B', 'prf-hkdf-sha256') ||
    !isEnvelope(body.encC, 'C', 'argon2id') ||
    !isSignedManifest(signed) ||
    !isB64url(body.credentialId)
  ) {
    throw new WalletError('INTERNAL');
  }
  return {
    setId: body.setId as string,
    status: body.status as ShareSet['status'],
    credentialId: body.credentialId,
    encB: body.encB,
    encC: body.encC,
    signed,
    exportedAt: (body.exportedAt as string | null) ?? null,
  };
}

export async function activateShareSet(setId: string): Promise<void> {
  assertOk(await call('/api/shares', jsonInit('PATCH', { setId })));
}

export async function markSeedExported(): Promise<string> {
  const response = await call('/api/shares/exported', jsonInit('POST'));
  assertOk(response);
  return ((await response.json()) as { exportedAt: string }).exportedAt;
}

export interface HandoffSession {
  userId: string;
  label: string;
  origin: string;
}

async function errorCode(response: Response): Promise<WalletErrorCode | null> {
  const body = (await response.clone().json().catch(() => null)) as { error?: WalletErrorCode } | null;
  return body?.error ?? null;
}

/** `origin` is the request's `event.origin`, which the browser sets. */
export async function exchangeHandoff(token: string, origin: string, chainId?: number): Promise<HandoffSession> {
  verifiedAppOrigin = null;
  const response = await call('/api/auth/handoff', jsonInit('POST', { token, origin, ...(chainId ? { chainId } : {}) }));
  const code = await errorCode(response);
  if (code === 'CHAIN_REQUEST_MISMATCH' || code === 'ORIGIN_MISMATCH' || code === 'ORIGIN_NOT_ALLOWED') throw new WalletError(code);
  assertOk(response);
  const session = (await response.json()) as HandoffSession;
  verifiedAppOrigin = session.origin;
  return session;
}

/** Status of the Safe on the session's network, checked by the server on that network. */
export async function fetchChainStatus(): Promise<ChainStatus> {
  const response = await call('/api/aa/status');
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new WalletError('UNAUTHORIZED');
    throw new WalletError((await errorCode(response)) ?? 'INTERNAL');
  }
  return (await response.json()) as ChainStatus;
}

/** Single-use challenge for creating the passkey: the server will store its public key. */
export async function fetchRegisterChallenge(): Promise<string> {
  const response = await call('/api/webauthn/challenge', jsonInit('POST'));
  assertOk(response);
  return ((await response.json()) as { challenge: string }).challenge;
}

export interface PasskeyRecovery {
  setId: string;
  credentialId: string;
  encB: Envelope;
  encC: Envelope;
  signed: SignedManifest;
}

/** No session. The server never says why it fails: `RECOVERY_FAILED`. */
export async function fetchRecoveryChallenge(): Promise<string> {
  const response = await call('/api/recovery/passkey/challenge', jsonInit('POST'));
  assertNotLimited(response);
  if (!response.ok) throw new WalletError('INTERNAL');
  return ((await response.json()) as { challenge: string }).challenge;
}

/** Returns `encB`, `encC` and that credential's manifest. Never share A. */
export async function postRecoveryAssertion(assertion: AssertionJson): Promise<PasskeyRecovery | null> {
  const response = await call('/api/recovery/passkey', jsonInit('POST', { assertion }));
  if (response.status === 401) return null;
  assertNotLimited(response);
  if (!response.ok) throw new WalletError('INTERNAL');
  const body = (await response.json()) as Record<string, unknown>;
  const signed = { manifest: body.manifest, signature: body.signature };
  if (!isEnvelope(body.encB, 'B', 'prf-hkdf-sha256') || !isEnvelope(body.encC, 'C', 'argon2id') || !isSignedManifest(signed) || !isB64url(body.credentialId)) {
    throw new WalletError('INTERNAL');
  }
  return { setId: body.setId as string, credentialId: body.credentialId, encB: body.encB, encC: body.encC, signed };
}

export async function requestRelinkChallenge(safe: string, owner: string): Promise<RelinkChallenge> {
  const response = await call('/api/relink/nonce', jsonInit('POST', { safe, owner }));
  if (response.status === 409) throw new WalletError('WALLET_ALREADY_EXISTS');
  assertOk(response);
  return (await response.json()) as RelinkChallenge;
}

export async function postRelink(nonce: string, signature: string): Promise<{ address: `0x${string}`; owner: `0x${string}` }> {
  const response = await call('/api/relink', jsonInit('POST', { nonce, signature }));
  if (response.status === 409) throw new WalletError('WALLET_ALREADY_EXISTS');
  if (response.status === 403 && (await errorCode(response)) === 'RELINK_REJECTED') throw new WalletError('RELINK_REJECTED');
  assertOk(response);
  return (await response.json()) as { address: `0x${string}`; owner: `0x${string}` };
}
