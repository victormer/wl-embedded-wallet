import { isIP } from 'node:net';
import { hitRateLimit } from './db';
import { json } from './http';

/**
 * Per-IP (and, on the second factor, per-user) limits for the public demo's auth routes, counted in the database so
 * every instance shares them. Fixed windows; the check runs before any expensive work (scrypt, TOTP).
 */

type Env = Record<string, string | undefined>;

export type RateLimitScope = 'register' | 'login' | 'totp' | 'totp-setup';

export interface RateLimitRule {
  windowMs: number;
  /** Maximum hits per window per client IP. `null`: no IP limit. */
  ip: number | null;
  /** Maximum hits per window per user. `null`: no user limit. */
  user: number | null;
}

const UNKNOWN_CLIENT = 'unknown';
const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const DEFAULT_WINDOW_SECONDS = 60;

// Per 60 s window. The per-user limit on `totp` caps guessing the 6-digit code by someone who has the password.
export const DEFAULT_RATE_LIMITS: Record<RateLimitScope, { ip: number | null; user: number | null }> = {
  register: { ip: 10, user: null },
  login: { ip: 20, user: null },
  totp: { ip: 20, user: 10 },
  'totp-setup': { ip: 20, user: 10 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : null;
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parsed `DEMO_RATE_LIMITS`, or `{}` if it is unset or not a JSON object. */
function overrides(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The rule for a scope: the defaults, with each field of `DEMO_RATE_LIMITS`
 * (`{ "<scope>": { ip?, user?, windowSeconds? } }`) that is a positive integer taking precedence. Anything invalid
 * falls back to its default.
 */
export function rateLimitRule(scope: RateLimitScope, env: Env = process.env): RateLimitRule {
  const defaults = DEFAULT_RATE_LIMITS[scope];
  const override = overrides(env.DEMO_RATE_LIMITS)[scope];
  const fields = isRecord(override) ? override : {};
  return {
    windowMs: (positiveInteger(fields.windowSeconds) ?? DEFAULT_WINDOW_SECONDS) * 1000,
    ip: positiveInteger(fields.ip) ?? defaults.ip,
    user: positiveInteger(fields.user) ?? defaults.user,
  };
}

/** Canonical form: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 compressed and in lowercase. `null` if not an IP. */
export function normalizeIp(value: string): string | null {
  let address = value.trim();
  if (address.startsWith('[') && address.includes(']')) address = address.slice(1, address.indexOf(']'));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  // A zone (`fe80::1%en0`) does not identify a different client.
  address = address.split('%')[0];
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = MAPPED_IPV4.exec(canonical);
  if (!mapped) return canonical;
  const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** The /64 of an IPv6 address: one client usually holds a whole /64, so a per-address key would be trivial to rotate. */
function ipv6Prefix(canonical: string): string {
  const [head, tail = ''] = canonical.split('::');
  const left = head ? head.split(':') : [];
  const right = canonical.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

/**
 * The client's address, as a rate-limit key. Only on a Vercel runtime (`VERCEL=1` and `VERCEL_REGION`, which exists
 * at runtime but not in `vercel env pull`) is `x-real-ip` read: the Vercel edge overwrites it with the address it
 * saw. Anywhere else a client could write it, so every request shares the `unknown` bucket. `x-forwarded-for` is
 * never read.
 */
export function clientIp(request: Request, env: Env = process.env): string {
  if (env.VERCEL !== '1' || !env.VERCEL_REGION) return UNKNOWN_CLIENT;
  const header = request.headers.get('x-real-ip');
  const address = header ? normalizeIp(header) : null;
  if (!address) return UNKNOWN_CLIENT;
  return isIP(address) === 6 ? ipv6Prefix(address) : address;
}

/** `429 { "error": "RATE_LIMITED" }`, no-store, with `Retry-After` in whole seconds. */
export function rateLimited(retryAfterSeconds: number): Response {
  return json({ error: 'RATE_LIMITED' }, 429, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });
}

async function exceeded(bucket: string, max: number, windowMs: number): Promise<number | null> {
  const { hits, resetAt } = await hitRateLimit(bucket, windowMs);
  return hits > max ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : null;
}

/** Counts the request against the scope's per-IP limit. Returns the 429 response if it is exceeded, `null` otherwise. */
export async function limitByIp(request: Request, scope: RateLimitScope): Promise<Response | null> {
  const rule = rateLimitRule(scope);
  if (rule.ip === null) return null;
  const retryAfter = await exceeded(`${scope}:ip:${clientIp(request)}`, rule.ip, rule.windowMs);
  return retryAfter === null ? null : rateLimited(retryAfter);
}

/** Counts the request against the scope's per-user limit. Returns the 429 response if it is exceeded, `null` otherwise. */
export async function limitByUser(userId: string, scope: RateLimitScope): Promise<Response | null> {
  const rule = rateLimitRule(scope);
  if (rule.user === null) return null;
  const retryAfter = await exceeded(`${scope}:user:${userId}`, rule.user, rule.windowMs);
  return retryAfter === null ? null : rateLimited(retryAfter);
}
