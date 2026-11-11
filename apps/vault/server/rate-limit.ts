import { isIP } from 'node:net';
import type { NextResponse } from 'next/server';
import { fail } from './http';
import { clientIpSource, rateLimitRule, trustedProxies, type RateLimitScope } from './limits';
import { hitRateLimit } from './store';

/** Set by `scripts/peer-address.cjs` to the socket address, overwriting any value the client sent. */
export const PEER_ADDRESS_HEADER = 'x-vault-peer-address';

/** Set by the Vercel edge, which overwrites any copy the client sent. Read only with `CLIENT_IP_SOURCE=vercel` on Vercel. */
export const VERCEL_CLIENT_IP_HEADER = 'x-real-ip';

const UNKNOWN_CLIENT = 'unknown';
const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** `true` if the preload runs in this process: only then does the header come from the socket and not from the client. */
export function peerAddressPreloaded(): boolean {
  return (globalThis as { __wdkVaultPeerAddress?: unknown }).__wdkVaultPeerAddress === true;
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

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 4 ? 'ipv4' : 'ipv6';
}

/** The socket address set by the preload. `null` without the preload, or if the socket had none. */
export function peerAddress(request: Request): string | null {
  if (!peerAddressPreloaded()) return null;
  const value = request.headers.get(PEER_ADDRESS_HEADER);
  return value ? normalizeIp(value) : null;
}

function bucketKey(address: string): string {
  return isIP(address) === 6 ? ipv6Prefix(address) : address;
}

/**
 * The client's address, as a rate-limit key. IPv6 is keyed by its /64.
 *
 * With `CLIENT_IP_SOURCE=vercel`, on a Vercel runtime only, it is `x-real-ip`, which the Vercel edge sets to the
 * client's address whatever the client sent; `X-Forwarded-For` and the peer header are never read then. With
 * `vercel` anywhere else, or an invalid source, no header is trusted and every client is `unknown`.
 *
 * Otherwise (`socket`, the default) it is the socket's peer. Only when that peer is one of `TRUSTED_PROXIES` is
 * `X-Forwarded-For` read, from the right: proxies append, so the first entry that is not a trusted proxy is the
 * address our proxy saw. An invalid entry there falls back to the peer rather than walking into what the client wrote.
 */
export function clientIp(request: Request): string {
  const source = clientIpSource();
  if (source === null) return UNKNOWN_CLIENT;
  if (source === 'vercel') {
    const address = normalizeIp(request.headers.get(VERCEL_CLIENT_IP_HEADER) ?? '');
    return address ? bucketKey(address) : UNKNOWN_CLIENT;
  }
  const peer = peerAddress(request);
  if (!peer) return UNKNOWN_CLIENT;
  let client = peer;
  const proxies = trustedProxies();
  if (proxies?.check(peer, familyOf(peer))) {
    const forwarded = (request.headers.get('x-forwarded-for') ?? '').split(',').reverse();
    for (const entry of forwarded) {
      const address = normalizeIp(entry);
      if (address && proxies.check(address, familyOf(address))) continue;
      if (address) client = address;
      break;
    }
  }
  return bucketKey(client);
}

/** `429 { "error": "RATE_LIMITED" }`, no-store, with `Retry-After` in whole seconds. */
export function rateLimited(retryAfterSeconds: number): NextResponse {
  const response = fail('RATE_LIMITED', 429);
  response.headers.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return response;
}

function secondsUntil(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

/** Counts one use of a custom budget. `allowed` is false once `max` uses in the window have been exceeded. */
export async function consumeLimit(bucket: string, max: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { hits, resetAt } = await hitRateLimit(bucket, windowMs);
  return { allowed: hits <= max, retryAfterSeconds: secondsUntil(resetAt) };
}

/**
 * Counts the request against the scope's per-IP limit and, if a `sub` is given, its per-`sub` limit. Returns the 429
 * response if either is exceeded, `null` otherwise. It depends only on the inputs, never on whether an account exists.
 */
export async function rateLimit(request: Request, scope: RateLimitScope, { sub = null }: { sub?: string | null } = {}): Promise<NextResponse | null> {
  const rule = rateLimitRule(scope);
  const budgets: { bucket: string; max: number }[] = [];
  if (rule.ip !== null) budgets.push({ bucket: `${scope}:ip:${clientIp(request)}`, max: rule.ip });
  if (sub && rule.sub !== null) budgets.push({ bucket: `${scope}:sub:${sub}`, max: rule.sub });
  const results = await Promise.all(budgets.map(({ bucket, max }) => consumeLimit(bucket, max, rule.windowMs)));
  const exceeded = results.filter((result) => !result.allowed);
  return exceeded.length ? rateLimited(Math.max(...exceeded.map((result) => result.retryAfterSeconds))) : null;
}
