// JWKS publication for the integrator backend. The vault fetches this document to verify handoff tokens.

export const JWKS_MAX_AGE_SECONDS = 300;

/** Fields that only exist in private JWKs. None of them may ever be published. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export interface Jwks {
  keys: Record<string, unknown>[];
}

/** Builds the JWKS document. Throws if any key carries private material. */
export function jwks(keys: readonly object[]): Jwks {
  for (const key of keys) {
    if (PRIVATE_MEMBERS.some((member) => member in key)) throw new Error('JWKS_PRIVATE_KEY');
  }
  return { keys: keys.map((key) => ({ ...key })) };
}

/** `GET /.well-known/jwks.json` response, cacheable for five minutes by default. */
export function jwksResponse(keys: readonly object[], options: { maxAgeSeconds?: number } = {}): Response {
  return Response.json(jwks(keys), { headers: { 'Cache-Control': `public, max-age=${options.maxAgeSeconds ?? JWKS_MAX_AGE_SECONDS}` } });
}

const internalError = () => Response.json({ error: 'INTERNAL' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });

/**
 * A route handler for `/.well-known/jwks.json` (for example, Next.js `export const GET = jwksHandler(...)`).
 * When `getKeys` returns `null` (missing configuration) or throws, or a key carries private material, it answers
 * 500 `{ "error": "INTERNAL" }` without caching.
 */
export function jwksHandler(getKeys: () => readonly object[] | null, options: { maxAgeSeconds?: number } = {}): () => Response {
  return () => {
    try {
      const keys = getKeys();
      return keys ? jwksResponse(keys, options) : internalError();
    } catch {
      return internalError();
    }
  };
}
