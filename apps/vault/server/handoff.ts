import { errors, importJWK, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { b64urlEncode, hexDecode } from '@wl-embedded-wallet/core/encoding';
import { allowedAppOrigins, normalizeOrigin } from './config';
import { createJwksSource } from './jwks';
import { consumeJti } from './store';

// Maximum lifetime of a token, even with a valid signature: it is single-use and for one operation.
const MAX_LIFETIME_SECONDS = 120;
const MAX_IAT_SKEW_SECONDS = 30;
const MAX_RPC_URL_CHARS = 2048;
// A display name or an email (at most 254 characters by RFC 5321), shown to the user and stored per user.
const MAX_LABEL_CHARS = 256;
// Never part of a name, and they can break the line the label is shown on.
const CONTROL_CHARACTER = /\p{Cc}/u;
// `sub` ends up in the envelopes' AAD, separated by `|`.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const JWKS_ALGORITHMS = ['EdDSA', 'ES256', 'RS256'];
const STATIC_KEY_ALGORITHMS = ['EdDSA'];

const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_STALE_SECONDS = 3600;

export type HandoffFailure =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'BAD_ALGORITHM'
  | 'BAD_ISSUER'
  | 'BAD_AUDIENCE'
  | 'EXPIRED'
  | 'REPLAYED'
  | 'UNKNOWN_KEY'
  | 'ORIGIN_MISMATCH'
  | 'ORIGIN_NOT_ALLOWED'
  | 'CHAIN_REQUEST_MISMATCH'
  | 'KEYS_UNAVAILABLE';

export interface HandoffClaims {
  iss: string;
  aud: string;
  sub: string;
  label: string;
  origin: string;
  jti: string;
  iat: number;
  exp: number;
  chain?: { chainId: number; rpcUrl?: string };
}

/** The message is only the reason: it never includes token data. */
export class HandoffError extends Error {
  readonly reason: HandoffFailure;

  constructor(reason: HandoffFailure) {
    super(reason);
    this.name = 'HandoffError';
    this.reason = reason;
  }
}

function seconds(value: string | undefined, fallback: number): number {
  return Number(value) > 0 ? Number(value) : fallback;
}

function issuerAndAudience() {
  return { issuer: process.env.HANDOFF_ISSUER ?? '', audience: process.env.HANDOFF_AUDIENCE || process.env.ORIGIN || '' };
}

// On `globalThis`: the JWKS cache is shared across routes and survives hot reload.
const holder = globalThis as typeof globalThis & { __vaultHandoffKeys?: { id: string; keys: JWTVerifyGetKey } };

function keySource(): { keys: JWTVerifyGetKey | CryptoKey | Promise<CryptoKey | Uint8Array>; algorithms: string[] } {
  const url = process.env.HANDOFF_JWKS_URL;
  if (url) {
    const options = {
      cacheMs: seconds(process.env.HANDOFF_JWKS_CACHE_SECONDS, DEFAULT_CACHE_SECONDS) * 1000,
      cooldownMs: seconds(process.env.HANDOFF_JWKS_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS) * 1000,
      maxStaleMs: seconds(process.env.HANDOFF_JWKS_MAX_STALE_SECONDS, DEFAULT_MAX_STALE_SECONDS) * 1000,
    };
    const id = JSON.stringify({ url, ...options });
    if (holder.__vaultHandoffKeys?.id !== id) holder.__vaultHandoffKeys = { id, keys: createJwksSource(url, options) };
    return { keys: holder.__vaultHandoffKeys.keys, algorithms: JWKS_ALGORITHMS };
  }
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: b64urlEncode(hexDecode(process.env.HANDOFF_PUBLIC_KEY ?? '')) };
  return { keys: importJWK(jwk, 'EdDSA') as Promise<CryptoKey>, algorithms: STATIC_KEY_ALGORITHMS };
}

function failureOf(error: unknown): HandoffFailure {
  if (error instanceof HandoffError) return error.reason;
  if (error instanceof errors.JWTExpired) return 'EXPIRED';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'BAD_ISSUER';
    if (error.claim === 'aud') return 'BAD_AUDIENCE';
    return 'MALFORMED';
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return 'BAD_ALGORITHM';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'BAD_SIGNATURE';
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) return 'UNKNOWN_KEY';
  if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid || error instanceof errors.JOSENotSupported) return 'MALFORMED';
  return 'KEYS_UNAVAILABLE';
}

function isValidChain(chain: unknown): boolean {
  if (chain === undefined) return true;
  const value = chain as { chainId?: unknown; rpcUrl?: unknown } | null;
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger(value.chainId) &&
    (value.chainId as number) > 0 &&
    (value.rpcUrl === undefined || (typeof value.rpcUrl === 'string' && value.rpcUrl.length <= MAX_RPC_URL_CHARS))
  );
}

function assertClaims(payload: JWTPayload, now: number): HandoffClaims {
  const claims = payload as Partial<HandoffClaims>;
  if (
    typeof claims.sub !== 'string' ||
    !SAFE_ID.test(claims.sub) ||
    typeof claims.jti !== 'string' ||
    !SAFE_ID.test(claims.jti) ||
    typeof claims.label !== 'string' ||
    claims.label.length > MAX_LABEL_CHARS ||
    CONTROL_CHARACTER.test(claims.label) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    !isValidChain(claims.chain)
  ) {
    throw new HandoffError('MALFORMED');
  }
  const { iat, exp } = claims as { iat: number; exp: number };
  const origin = normalizeOrigin(claims.origin);
  if (!origin) throw new HandoffError('MALFORMED');
  if (iat > now + MAX_IAT_SKEW_SECONDS || exp - iat > MAX_LIFETIME_SECONDS || exp - now > MAX_LIFETIME_SECONDS) throw new HandoffError('MALFORMED');
  return { ...claims, origin } as HandoffClaims;
}

/** Checks signature, algorithm, issuer, audience and lifetime. The single-use `jti` is enforced by the caller. */
export async function verifyHandoffToken(token: string, options: { nowSeconds?: number } = {}): Promise<HandoffClaims> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  try {
    const { keys, algorithms } = keySource();
    const { payload } = await jwtVerify(token, (await keys) as JWTVerifyGetKey, {
      ...issuerAndAudience(),
      algorithms,
      requiredClaims: ['iss', 'aud', 'sub', 'jti', 'iat', 'exp'],
      currentDate: new Date(now * 1000),
    });
    return assertClaims(payload, now);
  } catch (error) {
    throw new HandoffError(failureOf(error));
  }
}

export interface HandoffRequest {
  /** The `postMessage` origin, set by the browser: it must be the one the app backend signed. */
  origin: unknown;
  /** The popup's network. Absent or `null` only when the token has no `chain`. */
  chainId?: unknown;
  nowSeconds?: number;
}

/**
 * Every check of a redemption except the single use: the token, and the request against it. It spends nothing, so a
 * token rejected here can still be redeemed by a correct request. Throws `HandoffError`.
 */
export async function checkHandoffRequest(token: string, request: HandoffRequest): Promise<HandoffClaims> {
  const claims = await verifyHandoffToken(token, request);
  if (normalizeOrigin(request.origin) !== claims.origin) throw new HandoffError('ORIGIN_MISMATCH');
  const allowed = allowedAppOrigins();
  if (allowed.length > 0 && !allowed.includes(claims.origin)) throw new HandoffError('ORIGIN_NOT_ALLOWED');
  if ((request.chainId ?? null) !== (claims.chain?.chainId ?? null)) throw new HandoffError('CHAIN_REQUEST_MISMATCH');
  return claims;
}

/** Spends the `jti`, atomically: of several concurrent redemptions only one passes. Throws `HandoffError('REPLAYED')`. */
export async function spendHandoffToken(claims: HandoffClaims): Promise<void> {
  if (!(await consumeJti(claims.jti, claims.exp * 1000))) throw new HandoffError('REPLAYED');
}

/** `checkHandoffRequest`, then `spendHandoffToken`: a rejected token does not spend its `jti`. Throws `HandoffError`. */
export async function consumeHandoffToken(token: string, request: HandoffRequest): Promise<HandoffClaims> {
  const claims = await checkHandoffRequest(token, request);
  await spendHandoffToken(claims);
  return claims;
}
