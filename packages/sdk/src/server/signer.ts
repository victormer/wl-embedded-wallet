import { createPrivateKey, createPublicKey, type JsonWebKey as NodeJwk, type KeyObject } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { HANDOFF_TTL_SECONDS, HandoffError, type HandoffClaims } from './handoff';

// Same constraint as `createHandoffToken`: `sub` ends up in the envelopes' AAD, separated by `|`.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Algorithms the vault accepts for handoff tokens. */
export type HandoffAlgorithm = 'EdDSA' | 'ES256' | 'RS256';

/** Public JWK as published in the integrator's JWKS. Never contains private material. */
export type PublicHandoffJwk = JWK & { kid: string; alg: HandoffAlgorithm; use: 'sig' };

export interface HandoffTokenInput {
  sub: string;
  label: string;
  iss: string;
  aud: string;
  /** Exact origin of the app, taken from server configuration, never from the client. */
  origin: string;
  chain?: HandoffClaims['chain'];
  /** Only for tests. */
  jti?: string;
  /** Only for tests. */
  nowSeconds?: number;
}

/** A signing key for handoff tokens. Server only: it holds a private key. */
export interface HandoffSigner {
  readonly alg: HandoffAlgorithm;
  readonly kid: string;
  /** The public half, ready to be listed in `/.well-known/jwks.json`. */
  readonly publicJwk: PublicHandoffJwk;
  /** Issues a single-use, 60-second handoff token with the same claims as `createHandoffToken`. */
  mint(input: HandoffTokenInput): Promise<string>;
}

const CURVE: Record<HandoffAlgorithm, (key: KeyObject) => boolean> = {
  EdDSA: (key) => key.asymmetricKeyType === 'ed25519',
  ES256: (key) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1',
  RS256: (key) => key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
};

function randomJti(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
}

function signerFor(alg: HandoffAlgorithm, kid: string, privateKey: KeyObject | CryptoKey, publicJwk: PublicHandoffJwk): HandoffSigner {
  return {
    alg,
    kid,
    publicJwk,
    async mint(input) {
      if (!SAFE_ID.test(input.sub) || !input.iss || !input.aud || !input.origin) throw new HandoffError('MALFORMED');
      const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
      return new SignJWT({ label: input.label, origin: input.origin, ...(input.chain ? { chain: input.chain } : {}) })
        .setProtectedHeader({ alg, kid, typ: 'JWT' })
        .setIssuer(input.iss)
        .setAudience(input.aud)
        .setSubject(input.sub)
        .setJti(input.jti ?? randomJti())
        .setIssuedAt(now)
        .setExpirationTime(now + HANDOFF_TTL_SECONDS)
        .sign(privateKey);
    },
  };
}

function publicJwkOf(publicJwk: JWK, alg: HandoffAlgorithm, kid: string): PublicHandoffJwk {
  // Only the public members, whatever the key type.
  const { kty, crv, x, y, n, e } = publicJwk;
  const members = Object.fromEntries(Object.entries({ kty, crv, x, y, n, e }).filter(([, value]) => value !== undefined));
  return { ...members, kid, alg, use: 'sig' } as PublicHandoffJwk;
}

/**
 * Loads an existing private key (PKCS#8 PEM or a private JWK) as a handoff signer.
 * The key type must match `alg`: Ed25519 for EdDSA, P-256 for ES256, RSA (2048 bits or more) for RS256.
 */
export function createHandoffSigner(options: { alg: HandoffAlgorithm; kid: string; privateKey: string | JWK }): HandoffSigner {
  const { alg, kid } = options;
  if (!kid) throw new HandoffError('MALFORMED');
  let privateKey: KeyObject;
  try {
    privateKey =
      typeof options.privateKey === 'string'
        ? createPrivateKey(options.privateKey)
        : createPrivateKey({ key: options.privateKey as NodeJwk, format: 'jwk' });
  } catch {
    throw new HandoffError('MALFORMED');
  }
  if (privateKey.type !== 'private' || !CURVE[alg](privateKey)) throw new HandoffError('MALFORMED');
  const publicJwk = publicJwkOf(createPublicKey(privateKey).export({ format: 'jwk' }) as JWK, alg, kid);
  return signerFor(alg, kid, privateKey, publicJwk);
}

/** Generates a fresh signer. Useful for development and tests; production keys should be generated and stored by you. */
export async function generateHandoffSigner(alg: HandoffAlgorithm, kid: string): Promise<HandoffSigner> {
  if (!kid) throw new HandoffError('MALFORMED');
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: false, ...(alg === 'RS256' ? { modulusLength: 2048 } : {}) });
  return signerFor(alg, kid, privateKey, publicJwkOf(await exportJWK(publicKey), alg, kid));
}
