import { getUserByPendingSession, getUserBySession, SESSION_TTL_MS, type UserRecord } from './db';

export const SESSION_COOKIE = 'demo_session';
const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function fail(code: string, status: number): Response {
  return json({ error: code }, status);
}

/** Returns the error response, or `null` if the origin is the demo's. */
export function rejectForeignOrigin(request: Request): Response | null {
  return request.headers.get('origin') === process.env.ORIGIN ? null : fail('FORBIDDEN_ORIGIN', 403);
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sessionTokenFrom(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim();
  }
  return null;
}

/** User with a complete login, second factor included. */
export async function sessionUser(request: Request): Promise<UserRecord | null> {
  const token = sessionTokenFrom(request);
  return token ? await getUserBySession(token) : null;
}

/** User who passed the password check and still has to complete the second factor. */
export async function pendingSessionUser(request: Request): Promise<UserRecord | null> {
  const token = sessionTokenFrom(request);
  return token ? await getUserByPendingSession(token) : null;
}

// No `Domain`: a host-only cookie that `vault.localhost` never receives.
function cookieAttributes(maxAgeSeconds: number): string {
  const secure = process.env.ORIGIN?.startsWith('https://') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(SESSION_TTL_MS / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}
