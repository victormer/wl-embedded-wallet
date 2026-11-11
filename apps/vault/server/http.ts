import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getSession, SESSION_TTL_MS, type SessionRecord } from './store';

export const SESSION_COOKIE = '__Host-vault_session';
// Origin of the app the popup acts for. It must be the session's, fixed when the token is redeemed.
export const APP_ORIGIN_HEADER = 'x-vault-app-origin';

const NO_STORE = { 'Cache-Control': 'no-store' };
const HSTS = 'max-age=31536000';

/** As in `proxy.ts`, which does not see `/api/`: only in production and only when ORIGIN is https. */
function sendsHsts(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  try {
    return new URL(process.env.ORIGIN ?? '').protocol === 'https:';
  } catch {
    return false;
  }
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: sendsHsts() ? { ...NO_STORE, 'Strict-Transport-Security': HSTS } : NO_STORE });
}

export function fail(code: string, status: number): NextResponse {
  return json({ error: code }, status);
}

/** Same-origin reads carry no `Origin`; writes always do. */
export function originError(request: NextRequest, { write }: { write: boolean }): NextResponse | null {
  const origin = request.headers.get('origin');
  if (origin === null && !write) return null;
  return origin === process.env.ORIGIN ? null : fail('FORBIDDEN_ORIGIN', 403);
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function sessionToken(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE)?.value;
}

export type Guarded = { session: SessionRecord; token: string };

/** Returns the error response if there is no valid session. */
export async function requireSession(request: NextRequest): Promise<Guarded | NextResponse> {
  const token = sessionToken(request);
  const session = await getSession(token);
  if (!token || !session) return fail('UNAUTHORIZED', 401);
  if (!session.appOrigin || request.headers.get(APP_ORIGIN_HEADER) !== session.appOrigin) return fail('ORIGIN_MISMATCH', 403);
  return { session, token };
}

// The largest legitimate body, `POST /api/shares` with every field at its validator's limit, is about 102 KiB.
export const MAX_JSON_BODY_BYTES = 128 * 1024;

/** `null` for anything that is not a JSON object; the 413 response if the body exceeds `MAX_JSON_BODY_BYTES`. */
export async function readJson(request: NextRequest): Promise<Record<string, unknown> | null | NextResponse> {
  // The declared length rejects early, but the stream is counted too: the header can be missing or lie.
  if (Number(request.headers.get('content-length')) > MAX_JSON_BODY_BYTES) return fail('PAYLOAD_TOO_LARGE', 413);
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        // Stops the upload here instead of buffering the rest.
        await reader.cancel().catch(() => undefined);
        return fail('PAYLOAD_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // Same decoding as `request.json()`: lenient UTF-8, BOM stripped.
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** SHA-256 hex of a session token, for rate-limit buckets and audit rows: the raw token is never stored there. */
export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Hashes are compared so the token length does not leak through timing either. */
export function constantTimeEquals(a: string, b: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/** Message for the operator, with no user or key data. */
export function serverKeyMismatch() {
  console.error('[vault] MASTER_KEY does not decrypt the stored data: it is not the key they were encrypted with, or they are corrupted.');
  return fail('SERVER_KEY_MISMATCH', 500);
}
