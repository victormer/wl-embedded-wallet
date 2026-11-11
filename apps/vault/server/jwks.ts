import { createRemoteJWKSet, customFetch, errors, type FlattenedJWSInput, type JWSHeaderParameters } from 'jose';

const MAX_DOCUMENT_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
// A document with any of these fields publishes secret material.
const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export interface JwksOptions {
  /** After this, it refreshes, even if the keys are still valid. */
  cacheMs: number;
  /** Minimum time between refreshes for an unknown `kid`, and between retries after a failure. */
  cooldownMs: number;
  /** With the JWKS down, how long the last good document stays usable. After that, it fails closed. */
  maxStaleMs: number;
  timeoutMs?: number;
}

class JwksRejected extends Error {
  /** The material is no longer trustworthy: the cache is not used either. */
  readonly poisoned: boolean;

  constructor(cause: string, poisoned = false) {
    super(cause);
    this.poisoned = poisoned;
  }
}

async function readLimited(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_DOCUMENT_BYTES) throw new JwksRejected('document too large');
  const reader = response.body?.getReader();
  if (!reader) throw new JwksRejected('empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new JwksRejected('document too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function assertPublicDocument(text: string): void {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new JwksRejected('not valid JSON');
  }
  const keys = (document as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new JwksRejected('not a JWKS');
  for (const key of keys) {
    if (typeof key !== 'object' || key === null) throw new JwksRejected('not a JWKS');
    if (PRIVATE_FIELDS.some((field) => field in key) || (key as { kty?: unknown }).kty === 'oct') {
      throw new JwksRejected('the document includes private or symmetric keys', true);
    }
  }
}

function causeOf(error: unknown): string {
  if (error instanceof JwksRejected) return error.message;
  if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') return 'timed out';
  return 'network error';
}

/**
 * `jose` handles caching, the cooldown for an unknown `kid` and key selection.
 * What this module adds applies to the download: maximum size, no redirects, public keys only,
 * and reusing the last good document while the JWKS does not respond, with an expiry.
 */
export function createJwksSource(url: string, options: JwksOptions) {
  let lastGood: { text: string; at: number } | null = null;
  let loadedOnce = false;
  let lastFailureAt = 0;

  const staleUsable = () => lastGood !== null && Date.now() - lastGood.at <= options.maxStaleMs;
  const staleResponse = () => new Response(lastGood!.text, { status: 200, headers: { 'Content-Type': 'application/json' } });

  const download: typeof fetch = async (input, init) => {
    // After a failure, it does not retry on every token: an outage does not multiply the requests.
    if (lastFailureAt && Date.now() - lastFailureAt < options.cooldownMs) {
      if (staleUsable()) return staleResponse();
      throw new JwksRejected('cooling down after a failure');
    }
    try {
      // `manual`: a redirect is not 200, so it is rejected without following it.
      const response = await fetch(input, { ...init, redirect: 'manual', cache: 'no-store' });
      if (response.status !== 200) throw new JwksRejected(`HTTP ${response.status}`);
      const text = await readLimited(response);
      assertPublicDocument(text);
      lastGood = { text, at: Date.now() };
      loadedOnce = true;
      lastFailureAt = 0;
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      lastFailureAt = Date.now();
      if (error instanceof JwksRejected && error.poisoned) lastGood = null;
      const usable = staleUsable();
      // Only the cause: neither the URL nor the document content.
      console.error(`[vault] JWKS unavailable (${causeOf(error)}). ${usable ? 'Using the recent cache.' : 'No valid cache: tokens are rejected.'}`);
      if (usable) return staleResponse();
      throw error;
    }
  };

  const remote = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: options.cacheMs,
    cooldownDuration: options.cooldownMs,
    timeoutDuration: options.timeoutMs ?? TIMEOUT_MS,
    [customFetch]: download,
  });

  return async (header: JWSHeaderParameters, token: FlattenedJWSInput) => {
    // With several published keys, there is no safe way to choose without a `kid`.
    if (!header.kid) throw new errors.JWKSNoMatchingKey();
    // `jose` treats whatever the download returns as fresh, the cache included: expiry is checked here.
    if (loadedOnce && !staleUsable()) await remote.reload();
    return remote(header, token);
  };
}
