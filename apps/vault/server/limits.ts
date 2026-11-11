import { BlockList, isIP } from 'node:net';

/**
 * Limits read from the environment at call time. An invalid value falls back to its default here; `validateConfig`
 * (`server/config.ts`) reports it, and in production the vault does not start with it.
 */

type Env = Record<string, string | undefined>;

/** Same shape as `ConfigIssue` in `server/config.ts`. Never includes the value. */
export interface LimitIssue {
  variable: string;
  reason: string;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const UINT256_LIMIT = 2n ** 256n;

/** A positive safe integer, from a decimal string or a number. `null` otherwise. */
export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : null;
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A positive integer below 2^256, from a decimal string or a safe integer. `null` otherwise. */
export function parsePositiveBigint(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? BigInt(value) : null;
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < UINT256_LIMIT ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value of an env variable that must be a positive integer, or the default if it is unset or invalid. */
function envInteger(env: Env, variable: string, fallback: number): number {
  return parsePositiveInteger(env[variable]) ?? fallback;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/* Rate limits */

export type RateLimitScope = 'handoff' | 'share-a' | 'recovery-challenge' | 'recovery-assertion' | 'relink-nonce' | 'relink' | 'aa' | 's2s' | 'enroll';

export interface RateLimitRule {
  windowMs: number;
  /** Maximum hits per window per client IP. `null`: no IP limit. */
  ip: number | null;
  /** Maximum hits per window per `sub`. `null`: no `sub` limit. */
  sub: number | null;
}

const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

// Per 60 s window. The routes without a session (recovery) only have an IP limit.
const DEFAULT_RATE_LIMITS: Record<RateLimitScope, { ip: number | null; sub: number | null }> = {
  handoff: { ip: 30, sub: 10 },
  'share-a': { ip: 60, sub: 30 },
  'recovery-challenge': { ip: 10, sub: null },
  'recovery-assertion': { ip: 10, sub: null },
  'relink-nonce': { ip: 10, sub: 5 },
  relink: { ip: 10, sub: 5 },
  aa: { ip: 240, sub: 120 },
  s2s: { ip: 600, sub: 60 },
  enroll: { ip: 20, sub: 10 },
};

export const RATE_LIMIT_SCOPES = Object.keys(DEFAULT_RATE_LIMITS) as RateLimitScope[];
const RATE_LIMIT_FIELDS = ['ip', 'sub', 'windowSeconds'] as const;

function isScope(value: string): value is RateLimitScope {
  return Object.hasOwn(DEFAULT_RATE_LIMITS, value);
}

/** Parsed `RATE_LIMITS`, or `{}` if it is unset or not a JSON object. */
function rateLimitOverrides(raw: string | undefined): Record<string, unknown> {
  if (!isSet(raw)) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The rule for a scope: the defaults, with each field of `RATE_LIMITS` (`{ "<scope>": { ip?, sub?, windowSeconds? } }`)
 * that is a positive integer taking precedence.
 */
export function rateLimitRule(scope: RateLimitScope, env: Env = process.env): RateLimitRule {
  const defaults = DEFAULT_RATE_LIMITS[scope];
  const override = rateLimitOverrides(env.RATE_LIMITS)[scope];
  const fields = isRecord(override) ? override : {};
  const windowSeconds = parsePositiveInteger(fields.windowSeconds) ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS;
  return {
    windowMs: windowSeconds * 1000,
    ip: parsePositiveInteger(fields.ip) ?? defaults.ip,
    sub: parsePositiveInteger(fields.sub) ?? defaults.sub,
  };
}

export function checkRateLimits(raw: string | undefined): LimitIssue[] {
  if (!isSet(raw)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ variable: 'RATE_LIMITS', reason: 'is not valid JSON' }];
  }
  if (!isRecord(parsed)) return [{ variable: 'RATE_LIMITS', reason: 'must be an object keyed by scope' }];
  const issues: LimitIssue[] = [];
  for (const [scope, rule] of Object.entries(parsed)) {
    if (!isScope(scope)) {
      issues.push({ variable: 'RATE_LIMITS.?', reason: `a key is not a scope (${RATE_LIMIT_SCOPES.join(', ')})` });
      continue;
    }
    const variable = `RATE_LIMITS.${scope}`;
    if (!isRecord(rule)) {
      issues.push({ variable, reason: 'must be an object' });
      continue;
    }
    for (const [field, value] of Object.entries(rule)) {
      if (!(RATE_LIMIT_FIELDS as readonly string[]).includes(field)) issues.push({ variable: `${variable}.?`, reason: `a key is not a field (${RATE_LIMIT_FIELDS.join(', ')})` });
      else if (parsePositiveInteger(value) === null) issues.push({ variable: `${variable}.${field}`, reason: 'must be a positive integer' });
    }
  }
  return issues;
}

/* Share A release budget */

const DEFAULT_SHARE_A_WINDOW_SECONDS = 3600;
const DEFAULT_SHARE_A_MAX_PER_SESSION = 5;
const DEFAULT_SHARE_A_MAX_PER_USER = 30;

/** How many times share A can be released per session and per user in each window. */
export function shareALimits(env: Env = process.env): { windowMs: number; perSession: number; perUser: number } {
  return {
    windowMs: envInteger(env, 'SHARE_A_WINDOW_SECONDS', DEFAULT_SHARE_A_WINDOW_SECONDS) * 1000,
    perSession: envInteger(env, 'SHARE_A_MAX_PER_SESSION', DEFAULT_SHARE_A_MAX_PER_SESSION),
    perUser: envInteger(env, 'SHARE_A_MAX_PER_USER', DEFAULT_SHARE_A_MAX_PER_USER),
  };
}

/* Recovery challenges */

const DEFAULT_RECOVERY_CHALLENGE_MAX_LIVE = 1000;

/** Maximum unexpired `recover` challenges at once, across all clients. */
export function recoveryChallengeMaxLive(env: Env = process.env): number {
  return envInteger(env, 'RECOVERY_CHALLENGE_MAX_LIVE', DEFAULT_RECOVERY_CHALLENGE_MAX_LIVE);
}

const POSITIVE_INTEGER_VARIABLES = ['SHARE_A_WINDOW_SECONDS', 'SHARE_A_MAX_PER_SESSION', 'SHARE_A_MAX_PER_USER', 'RECOVERY_CHALLENGE_MAX_LIVE', 'AA_DEPLOYMENT_RETRY_SECONDS'];

/* Sponsorship */

export interface SponsorshipLimits {
  maxVerificationGasLimit: bigint;
  maxCallGasLimit: bigint;
  maxPreVerificationGas: bigint;
  maxPaymasterVerificationGasLimit: bigint;
  maxPaymasterPostOpGasLimit: bigint;
  /** Wei. */
  maxFeePerGas: bigint;
  /** Margin on the base fee in `maxFeePerGas`, in percent (100 = none). */
  feeMultiplierPercent: bigint;
  /** Margin on the priority fee (the tip), in percent (100 = none): a bundler's floor can rise between prepare and send. */
  priorityFeeMultiplierPercent: bigint;
  /** How long a sent deployment blocks a new one for the same Safe. */
  deploymentRetryMs: number;
}

type GasLimitKey = Exclude<keyof SponsorshipLimits, 'deploymentRetryMs'>;

// Default caps on what the paymaster is asked to sponsor. Tune these values only; each has its own env variable,
// and `AA_CHAINS["<chainId>"].limits` overrides them per chain.
// 3M: a Safe deployment on Ethereum Sepolia estimates about 1.83M, and 2M left too little room for the +20 % margin.
export const DEFAULT_AA_MAX_VERIFICATION_GAS_LIMIT = 3_000_000n;
export const DEFAULT_AA_MAX_CALL_GAS_LIMIT = 500_000n;
export const DEFAULT_AA_MAX_PRE_VERIFICATION_GAS = 500_000n;
export const DEFAULT_AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT = 500_000n;
export const DEFAULT_AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT = 200_000n;
export const DEFAULT_AA_MAX_FEE_PER_GAS = 500_000_000_000n; // 500 gwei
export const DEFAULT_AA_FEE_MULTIPLIER_PERCENT = 200n;
export const DEFAULT_AA_PRIORITY_FEE_MULTIPLIER_PERCENT = 120n;
export const DEFAULT_AA_DEPLOYMENT_RETRY_SECONDS = 900;

const FEE_MULTIPLIER_RANGE = { min: 100n, max: 1000n };

const SPONSORSHIP_FIELDS: { key: GasLimitKey; variable: string; fallback: bigint }[] = [
  { key: 'maxVerificationGasLimit', variable: 'AA_MAX_VERIFICATION_GAS_LIMIT', fallback: DEFAULT_AA_MAX_VERIFICATION_GAS_LIMIT },
  { key: 'maxCallGasLimit', variable: 'AA_MAX_CALL_GAS_LIMIT', fallback: DEFAULT_AA_MAX_CALL_GAS_LIMIT },
  { key: 'maxPreVerificationGas', variable: 'AA_MAX_PRE_VERIFICATION_GAS', fallback: DEFAULT_AA_MAX_PRE_VERIFICATION_GAS },
  { key: 'maxPaymasterVerificationGasLimit', variable: 'AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT', fallback: DEFAULT_AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT },
  { key: 'maxPaymasterPostOpGasLimit', variable: 'AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT', fallback: DEFAULT_AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT },
  { key: 'maxFeePerGas', variable: 'AA_MAX_FEE_PER_GAS', fallback: DEFAULT_AA_MAX_FEE_PER_GAS },
  { key: 'feeMultiplierPercent', variable: 'AA_FEE_MULTIPLIER_PERCENT', fallback: DEFAULT_AA_FEE_MULTIPLIER_PERCENT },
  { key: 'priorityFeeMultiplierPercent', variable: 'AA_PRIORITY_FEE_MULTIPLIER_PERCENT', fallback: DEFAULT_AA_PRIORITY_FEE_MULTIPLIER_PERCENT },
];

const MULTIPLIER_KEYS: readonly GasLimitKey[] = ['feeMultiplierPercent', 'priorityFeeMultiplierPercent'];

/** `null` if the value is not valid for that field. */
function sponsorshipValue(key: GasLimitKey, value: unknown): bigint | null {
  const parsed = parsePositiveBigint(value);
  if (parsed === null) return null;
  if (MULTIPLIER_KEYS.includes(key) && (parsed < FEE_MULTIPLIER_RANGE.min || parsed > FEE_MULTIPLIER_RANGE.max)) return null;
  return parsed;
}

function chainLimitsOverride(raw: string | undefined, chainId: number): Record<string, unknown> {
  if (!isSet(raw)) return {};
  try {
    const chains: unknown = JSON.parse(raw);
    const chain = isRecord(chains) ? chains[String(chainId)] : undefined;
    return isRecord(chain) && isRecord(chain.limits) ? chain.limits : {};
  } catch {
    return {};
  }
}

/** For each field: `AA_CHAINS["<chainId>"].limits`, then its env variable, then the default. */
export function sponsorshipLimits(chainId: number, env: Env = process.env): SponsorshipLimits {
  const perChain = chainLimitsOverride(env.AA_CHAINS, chainId);
  const limits = {} as Record<GasLimitKey, bigint>;
  for (const { key, variable, fallback } of SPONSORSHIP_FIELDS) {
    limits[key] = sponsorshipValue(key, perChain[key]) ?? sponsorshipValue(key, env[variable]) ?? fallback;
  }
  return { ...limits, deploymentRetryMs: envInteger(env, 'AA_DEPLOYMENT_RETRY_SECONDS', DEFAULT_AA_DEPLOYMENT_RETRY_SECONDS) * 1000 };
}

function sponsorshipReason(key: GasLimitKey): string {
  return MULTIPLIER_KEYS.includes(key) ? `must be an integer between ${FEE_MULTIPLIER_RANGE.min} and ${FEE_MULTIPLIER_RANGE.max}` : 'must be a positive decimal integer';
}

/** `AA_CHAINS["<chainId>"].limits`. `variable` is how that object is named in the messages. */
export function checkChainSponsorshipLimits(value: unknown, variable: string): LimitIssue[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [{ variable, reason: 'must be an object' }];
  const issues: LimitIssue[] = [];
  const keys = SPONSORSHIP_FIELDS.map(({ key }) => key as string);
  for (const [key, field] of Object.entries(value)) {
    if (!keys.includes(key)) issues.push({ variable: `${variable}.?`, reason: `a key is not a limit (${keys.join(', ')})` });
    else if (sponsorshipValue(key as GasLimitKey, field) === null) issues.push({ variable: `${variable}.${key}`, reason: sponsorshipReason(key as GasLimitKey) });
  }
  return issues;
}

/* Trusted proxies */

/** One entry: an IPv4 or IPv6 address, or a CIDR. */
function addProxy(list: BlockList, entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (prefix === undefined) {
    list.addAddress(address, type);
    return true;
  }
  const bits = /^[0-9]{1,3}$/.test(prefix) ? Number(prefix) : NaN;
  if (!(bits >= 0 && bits <= (family === 4 ? 32 : 128))) return false;
  list.addSubnet(address, bits, type);
  return true;
}

function proxyEntries(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

let proxyCache: { raw: string; list: BlockList | null } | undefined;

/**
 * `TRUSTED_PROXIES`: comma-separated addresses or CIDRs of the reverse proxies in front of the vault. `null` if unset,
 * or if any entry is invalid: then no proxy is trusted, and `X-Forwarded-For` is never read.
 */
export function trustedProxies(env: Env = process.env): BlockList | null {
  const raw = env.TRUSTED_PROXIES ?? '';
  if (proxyCache?.raw === raw) return proxyCache.list;
  const entries = proxyEntries(raw);
  let list: BlockList | null = entries.length ? new BlockList() : null;
  for (const entry of entries) {
    if (!addProxy(list as BlockList, entry)) {
      list = null;
      break;
    }
  }
  proxyCache = { raw, list };
  return list;
}

export function checkTrustedProxies(raw: string | undefined): LimitIssue[] {
  const scratch = new BlockList();
  return proxyEntries(raw).some((entry) => !addProxy(scratch, entry)) ? [{ variable: 'TRUSTED_PROXIES', reason: 'an entry is not an IP address or a CIDR' }] : [];
}

/* Client IP source */

export type ClientIpSource = 'socket' | 'vercel';
const CLIENT_IP_SOURCES: readonly string[] = ['socket', 'vercel'];

/**
 * `true` only inside a Vercel function. `VERCEL_REGION` exists at runtime only, never in the output of
 * `vercel env pull`, so a copied `.env` with `VERCEL=1` does not make a laptop or a VPS look like Vercel.
 */
export function isVercelRuntime(env: Env = process.env): boolean {
  return env.VERCEL === '1' && isSet(env.VERCEL_REGION);
}

function rawClientIpSource(env: Env): string {
  return env.CLIENT_IP_SOURCE?.trim() || 'socket';
}

/**
 * `CLIENT_IP_SOURCE`: `socket` (the default: the peer-address preload, plus `TRUSTED_PROXIES`) or `vercel`
 * (`x-real-ip`, which the Vercel edge overwrites). `null` if the value is invalid, or `vercel` outside a Vercel
 * runtime: then no address is trusted and every client shares the `unknown` bucket.
 */
export function clientIpSource(env: Env = process.env): ClientIpSource | null {
  const raw = rawClientIpSource(env);
  if (raw === 'socket') return 'socket';
  if (raw === 'vercel') return isVercelRuntime(env) ? 'vercel' : null;
  return null;
}

/** Ambiguous combinations are refused: one source of client addresses, and the one that works where it runs. */
export function checkClientIpSource(env: Env): LimitIssue[] {
  const raw = rawClientIpSource(env);
  if (!CLIENT_IP_SOURCES.includes(raw)) return [{ variable: 'CLIENT_IP_SOURCE', reason: 'must be socket or vercel' }];
  const issues: LimitIssue[] = [];
  if (raw === 'vercel') {
    if (!isVercelRuntime(env)) issues.push({ variable: 'CLIENT_IP_SOURCE', reason: 'is vercel, but this is not a Vercel runtime (VERCEL=1 and VERCEL_REGION)' });
    if (isSet(env.TRUSTED_PROXIES)) issues.push({ variable: 'TRUSTED_PROXIES', reason: 'must be unset with CLIENT_IP_SOURCE=vercel' });
  } else if (env.VERCEL === '1') {
    issues.push({ variable: 'CLIENT_IP_SOURCE', reason: 'must be vercel on Vercel, where the peer-address preload cannot run' });
  }
  return issues;
}

/* Validation of the variables above, except `AA_CHAINS`, which `config.ts` validates with `checkChainSponsorshipLimits`. */

export function checkLimits(env: Env): LimitIssue[] {
  const issues: LimitIssue[] = [...checkClientIpSource(env), ...checkTrustedProxies(env.TRUSTED_PROXIES), ...checkRateLimits(env.RATE_LIMITS)];
  for (const variable of POSITIVE_INTEGER_VARIABLES) {
    if (isSet(env[variable]) && parsePositiveInteger(env[variable]) === null) issues.push({ variable, reason: 'must be a positive integer' });
  }
  for (const { key, variable } of SPONSORSHIP_FIELDS) {
    if (isSet(env[variable]) && sponsorshipValue(key, env[variable]) === null) issues.push({ variable, reason: sponsorshipReason(key) });
  }
  return issues;
}
