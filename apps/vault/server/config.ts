import { ed25519 } from '@noble/curves/ed25519.js';
import { hexDecode, hexEncode } from '@wl-embedded-wallet/core/encoding';
import { currentBrand, MAX_BRAND_NAME_LENGTH } from './brand';
import { checkChainSponsorshipLimits, checkLimits } from './limits';

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const POSTGRES_URL = /^postgres(ql)?:\/\/.+/;
const MIN_SERVICE_TOKEN_LENGTH = 32;
/** `AA_CHAINS[].nativeCurrency`: letters, digits and `._-`, up to 11 characters (the ERC-20 convention). Shown as text. */
const NATIVE_CURRENCY = /^[A-Za-z0-9._-]{1,11}$/;
const MAX_POOL_SIZE = 200;
const LOCAL_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];
// What Neon gives (`require`) and the stricter spellings. `prefer` and `allow` would fall back to clear text with libpq.
const SSL_MODES = ['require', 'verify-ca', 'verify-full'];

export interface ConfigIssue {
  variable: string;
  /** Never includes the variable's value. */
  reason: string;
}

type Env = Record<string, string | undefined>;

/** `localhost`, `127.0.0.1`, `[::1]` and any `*.localhost`: the hosts where `http` is accepted in insecure local mode. */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.includes(hostname) || hostname.endsWith('.localhost');
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** `null` if valid; otherwise, the reason. */
function checkHttpUrl(value: unknown, allowInsecure: boolean): string | null {
  const url = typeof value === 'string' ? parseUrl(value) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol)) return 'must be an http(s) URL';
  if (url.protocol === 'http:' && !(allowInsecure && isLocalHost(url.hostname))) return 'must be https';
  return null;
}

function checkOrigin(value: string, allowInsecure: boolean): string | null {
  const invalid = checkHttpUrl(value, allowInsecure);
  if (invalid) return invalid;
  return new URL(value).origin === value ? null : 'must be an origin, without a path or trailing slash';
}

/** `true` if `http` is allowed on local hosts. */
export function allowsInsecureLocal(env: Env = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.ALLOW_INSECURE_LOCAL === '1';
}

/**
 * Scheme, host and port, without a path or trailing slash. `null` if it is not an acceptable origin:
 * HTTPS, except local hosts with `allowInsecure`.
 */
export function normalizeOrigin(value: unknown, allowInsecure: boolean = allowsInsecureLocal()): string | null {
  if (typeof value !== 'string') return null;
  const url = parseUrl(value);
  if (!url || checkHttpUrl(value, allowInsecure)) return null;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkAaChains(raw: string | undefined, allowInsecure: boolean): ConfigIssue[] {
  if (raw === undefined || raw === '') return [];
  let chains: unknown;
  try {
    chains = JSON.parse(raw);
  } catch {
    return [{ variable: 'AA_CHAINS', reason: 'is not valid JSON' }];
  }
  if (!isRecord(chains)) return [{ variable: 'AA_CHAINS', reason: 'must be an object keyed by chainId' }];

  const issues: ConfigIssue[] = [];
  for (const [chainId, config] of Object.entries(chains)) {
    const variable = `AA_CHAINS.${CHAIN_ID.test(chainId) ? chainId : '?'}`;
    if (!CHAIN_ID.test(chainId)) issues.push({ variable, reason: 'a key is not a chainId' });
    if (!isRecord(config)) {
      issues.push({ variable, reason: 'must be an object' });
      continue;
    }
    for (const field of ['rpcUrl', 'bundlerUrl', 'paymasterUrl']) {
      if (config[field] === undefined) continue;
      const invalid = checkHttpUrl(config[field], allowInsecure);
      if (invalid) issues.push({ variable: `${variable}.${field}`, reason: invalid });
    }
    for (const field of ['bundlerHeaders', 'paymasterHeaders']) {
      const headers = config[field];
      if (headers === undefined) continue;
      if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== 'string')) {
        issues.push({ variable: `${variable}.${field}`, reason: 'must be an object of strings' });
      }
    }
    if (config.nativeCurrency !== undefined && !(typeof config.nativeCurrency === 'string' && NATIVE_CURRENCY.test(config.nativeCurrency))) {
      issues.push({ variable: `${variable}.nativeCurrency`, reason: 'must be 1 to 11 letters, digits, dots, dashes or underscores' });
    }
    if (config.paymasterContext !== undefined && !isRecord(config.paymasterContext)) {
      issues.push({ variable: `${variable}.paymasterContext`, reason: 'must be an object' });
    }
    issues.push(...checkChainSponsorshipLimits(config.limits, `${variable}.limits`));
    if (config.sponsorTransactions !== undefined && typeof config.sponsorTransactions !== 'boolean') {
      issues.push({ variable: `${variable}.sponsorTransactions`, reason: 'must be true or false' });
    }
    if (config.sponsorTransactions === true && config.paymasterUrl === undefined) {
      issues.push({ variable: `${variable}.paymasterUrl`, reason: 'is required when sponsorTransactions is true' });
    }
    if (config.paymasterUrl !== undefined && config.bundlerUrl === undefined) {
      issues.push({ variable: `${variable}.bundlerUrl`, reason: 'is required when paymasterUrl is set' });
    }
  }
  return issues;
}

function checkEd25519PublicKey(value: string): boolean {
  if (!HEX_32_BYTES.test(value)) return false;
  try {
    ed25519.Point.fromHex(value.toLowerCase());
    return true;
  } catch {
    return false;
  }
}

/** The integrator's JWKS or, as an alternative, a fixed key: exactly one of the two. */
function checkHandoff(env: Env, allowInsecure: boolean): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (env.HANDOFF_JWKS_URL && env.HANDOFF_PUBLIC_KEY) {
    issues.push({ variable: 'HANDOFF_JWKS_URL', reason: 'set only one of HANDOFF_JWKS_URL and HANDOFF_PUBLIC_KEY' });
  } else if (!env.HANDOFF_JWKS_URL && !env.HANDOFF_PUBLIC_KEY) {
    issues.push({ variable: 'HANDOFF_JWKS_URL', reason: 'missing, or HANDOFF_PUBLIC_KEY as an alternative' });
  }
  if (env.HANDOFF_JWKS_URL) {
    const invalid = checkHttpUrl(env.HANDOFF_JWKS_URL, allowInsecure);
    if (invalid) issues.push({ variable: 'HANDOFF_JWKS_URL', reason: invalid });
  }
  if (env.HANDOFF_PUBLIC_KEY && !checkEd25519PublicKey(env.HANDOFF_PUBLIC_KEY)) {
    issues.push({ variable: 'HANDOFF_PUBLIC_KEY', reason: 'must be a 32-byte Ed25519 public key in hex' });
  }
  if (!env.HANDOFF_ISSUER) issues.push({ variable: 'HANDOFF_ISSUER', reason: 'missing' });
  for (const variable of ['HANDOFF_JWKS_CACHE_SECONDS', 'HANDOFF_JWKS_COOLDOWN_SECONDS', 'HANDOFF_JWKS_MAX_STALE_SECONDS']) {
    const value = env[variable];
    if (value && !(Number.isInteger(Number(value)) && Number(value) > 0)) issues.push({ variable, reason: 'must be a positive integer number of seconds' });
  }
  return issues;
}

/**
 * Returns every issue at once, so a deployment is not fixed one variable at a time.
 * `ALLOW_INSECURE_LOCAL=1`, for testing only, allows `http` on local hosts and SQLite.
 * Outside production it is always allowed, and the database is optional.
 */
export function validateConfig(env: Env = process.env, production: boolean = env.NODE_ENV === 'production'): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (variable: string, reason: string) => issues.push({ variable, reason });
  const allowInsecure = !production || env.ALLOW_INSECURE_LOCAL === '1';

  if (!env.MASTER_KEY) add('MASTER_KEY', 'missing');
  else if (!HEX_32_BYTES.test(env.MASTER_KEY)) add('MASTER_KEY', 'must be 32 bytes in hex');

  if (!env.MANIFEST_SIGNING_KEY) add('MANIFEST_SIGNING_KEY', 'missing');
  else if (!HEX_32_BYTES.test(env.MANIFEST_SIGNING_KEY)) add('MANIFEST_SIGNING_KEY', 'must be a 32-byte Ed25519 private key in hex');

  issues.push(...checkHandoff(env, allowInsecure));

  if (!env.VAULT_SERVICE_TOKEN) add('VAULT_SERVICE_TOKEN', 'missing');
  else if (env.VAULT_SERVICE_TOKEN.length < MIN_SERVICE_TOKEN_LENGTH) add('VAULT_SERVICE_TOKEN', `must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters`);

  if (!env.ORIGIN) add('ORIGIN', 'missing');
  else {
    const invalid = checkOrigin(env.ORIGIN, allowInsecure);
    if (invalid) add('ORIGIN', invalid);
  }

  if (!env.RP_ID) add('RP_ID', 'missing');
  else if (!HOSTNAME.test(env.RP_ID)) add('RP_ID', 'must be a hostname');
  else if (env.ORIGIN && parseUrl(env.ORIGIN)?.hostname !== env.RP_ID) {
    // A parent domain would allow requesting the passkey from any subdomain.
    add('RP_ID', 'must be exactly the host of ORIGIN');
  }

  // Optional: the domain is authorized by the signed `origin`. When set, it is an additional restriction.
  const appOrigins = (env.ALLOWED_APP_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of appOrigins) {
    const invalid = checkOrigin(origin, allowInsecure);
    if (invalid) add('ALLOWED_APP_ORIGINS', `invalid entry: ${invalid}`);
  }

  const database = env.DATABASE_URL;
  if (!database) {
    if (production) add('DATABASE_URL', 'missing');
  } else if (database.startsWith('sqlite:')) {
    if (!allowInsecure) add('DATABASE_URL', 'must be postgres:// in production');
  } else if (!POSTGRES_URL.test(database)) {
    add('DATABASE_URL', 'must start with postgres://');
  } else if (env.VERCEL === '1') {
    // On Vercel the database is always across the internet (Neon): never in clear text.
    const url = parseUrl(database);
    if (!url) add('DATABASE_URL', 'is not a valid URL');
    else if (!isLocalHost(url.hostname) && !SSL_MODES.includes(url.searchParams.get('sslmode') ?? '')) {
      add('DATABASE_URL', 'must set sslmode=require or verify-full on Vercel');
    }
  }

  if (env.DATABASE_POOL_SIZE !== undefined) {
    const size = Number(env.DATABASE_POOL_SIZE);
    if (!Number.isInteger(size) || size < 1 || size > MAX_POOL_SIZE) add('DATABASE_POOL_SIZE', `must be an integer between 1 and ${MAX_POOL_SIZE}`);
  }

  for (const host of (env.RPC_ALLOWED_HOSTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    // `[::1]` does not match `HOSTNAME`; IPs do, being digits and dots.
    if (!HOSTNAME.test(host) && !LOCAL_HOSTS.includes(host)) add('RPC_ALLOWED_HOSTS', 'an entry is not a hostname');
  }

  if (env.VAULT_BRAND_NAME !== undefined && (env.VAULT_BRAND_NAME.length > MAX_BRAND_NAME_LENGTH || /[\p{Cc}]/u.test(env.VAULT_BRAND_NAME))) {
    add('VAULT_BRAND_NAME', `must be up to ${MAX_BRAND_NAME_LENGTH} characters, with no control characters`);
  }

  issues.push(...checkAaChains(env.AA_CHAINS, allowInsecure));
  // Rate limits, share A budget, recovery challenge cap, sponsorship caps and trusted proxies.
  issues.push(...checkLimits(env));
  return issues;
}

export function allowedAppOrigins(): string[] {
  return (process.env.ALLOWED_APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** `VAULT_BRAND_NAME`, the `name` in `brand.json` or "Vault", in that order. See `server/brand.ts`. */
export function brandName(): string {
  return currentBrand().name;
}

/** What the HTML hands to the client. Public data only. */
export function publicRuntimeConfig(): { rpId: string; manifestPubKey: string; brand: string } {
  const signingKey = process.env.MANIFEST_SIGNING_KEY ?? '';
  return {
    rpId: process.env.RP_ID ?? '',
    manifestPubKey: HEX_32_BYTES.test(signingKey) ? hexEncode(ed25519.getPublicKey(hexDecode(signingKey.toLowerCase()))) : '',
    brand: brandName(),
  };
}
