import { ed25519 } from '@noble/curves/ed25519.js';

// JWT the integrator's backend issues for the vault. It is not the integrator's session JWT: it carries
// the vault's `aud`, a short lifetime and a single-use `jti`. Keys are passed as parameters: this module
// never reads the environment, so importing it never pulls a secret into a bundle. The vault verifies it
// with `jose`, so any JWT library supporting EdDSA, ES256 or RS256 can issue it.

export const HANDOFF_TTL_SECONDS = 60;
// `sub` ends up in the envelopes' AAD, `|`-separated.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface HandoffClaims {
  iss: string;
  aud: string;
  sub: string;
  label: string;
  // Exact origin of the app, set by its backend. This is what authorizes it to use the wallet.
  origin: string;
  jti: string;
  iat: number;
  exp: number;
  // Network for the operation. Signed by the integrator's backend: the browser cannot choose the RPC.
  chain?: { chainId: number; rpcUrl?: string };
}

export interface HandoffPublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

/** The message is only the reason: it never includes token data. */
export class HandoffError extends Error {
  readonly reason: 'MALFORMED';

  constructor(reason: 'MALFORMED') {
    super(reason);
    this.name = 'HandoffError';
    this.reason = reason;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new HandoffError('MALFORMED');
  return Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function randomJti(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** Compact EdDSA JWT. Integrator server only. `nowSeconds` exists for tests. */
export function createHandoffToken(
  input: {
    sub: string;
    label: string;
    iss: string;
    aud: string;
    origin: string;
    kid?: string;
    jti?: string;
    nowSeconds?: number;
    chain?: HandoffClaims['chain'];
  },
  privateKeyHex: string,
): string {
  if (!SAFE_ID.test(input.sub) || !input.iss || !input.aud || !input.origin) throw new HandoffError('MALFORMED');
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: HandoffClaims = {
    iss: input.iss,
    aud: input.aud,
    sub: input.sub,
    label: input.label,
    origin: input.origin,
    jti: input.jti ?? randomJti(),
    iat: now,
    exp: now + HANDOFF_TTL_SECONDS,
    ...(input.chain ? { chain: input.chain } : {}),
  };
  const header = { alg: 'EdDSA', typ: 'JWT', ...(input.kid ? { kid: input.kid } : {}) };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = ed25519.sign(new TextEncoder().encode(signingInput), hexToBytes(privateKeyHex));
  return `${signingInput}.${b64urlEncode(signature)}`;
}

/** JWKS entry for a hex Ed25519 public key. It never contains private material. */
export function ed25519PublicJwk(publicKeyHex: string, kid: string): HandoffPublicJwk {
  if (!kid) throw new HandoffError('MALFORMED');
  const x = hexToBytes(publicKeyHex);
  if (x.length !== 32) throw new HandoffError('MALFORMED');
  return { kty: 'OKP', crv: 'Ed25519', x: b64urlEncode(x), kid, use: 'sig', alg: 'EdDSA' };
}

/** What the integrator's JWKS endpoint publishes for its signing key. */
export function handoffPublicJwk(privateKeyHex: string, kid: string): HandoffPublicJwk {
  const publicKey = ed25519.getPublicKey(hexToBytes(privateKeyHex));
  return ed25519PublicJwk(Array.from(publicKey, (byte) => byte.toString(16).padStart(2, '0')).join(''), kid);
}
