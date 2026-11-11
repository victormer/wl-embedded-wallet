import { loadBrandFromEnv } from './brand';
import { type ConfigIssue, validateConfig } from './config';
import { clientIpSource } from './limits';
import { getStore } from './store';

const PEER_ADDRESS_ISSUE: ConfigIssue = {
  variable: 'peer-address preload',
  reason: 'is missing: start the server with `node --require ./peer-address.cjs server.js`',
};

/** Set by `scripts/peer-address.cjs`, without which rate limits would key on an address the client chooses. */
function hasPeerAddress(): boolean {
  return (globalThis as { __wdkVaultPeerAddress?: boolean }).__wdkVaultPeerAddress === true;
}

/**
 * Validates the configuration and applies migrations before accepting requests. In production, a
 * failure ends the process. Messages name the variable, never its value.
 */
export async function startup(): Promise<void> {
  const production = process.env.NODE_ENV === 'production';
  // The brand too: an invalid `brand.json`, or one without AA contrast, does not start in production.
  const issues = [...validateConfig(), ...loadBrandFromEnv().issues];
  // Outside production it only warns, and only in `next dev`: tests do not load the preload. On Vercel the address
  // comes from `x-real-ip` (`CLIENT_IP_SOURCE=vercel`), and `validateConfig` already refuses a source that cannot work.
  if (clientIpSource() !== 'vercel' && !(process.env.VERCEL === '1' && production) && !hasPeerAddress()) {
    const { variable, reason } = PEER_ADDRESS_ISSUE;
    if (production) issues.push(PEER_ADDRESS_ISSUE);
    else if (process.env.NODE_ENV === 'development') console.warn(`Warning: ${variable} ${reason}`);
  }
  for (const { variable, reason } of issues) console.error(`Invalid configuration: ${variable} ${reason}`);
  if (issues.length > 0 && production) process.exit(1);

  try {
    await getStore();
  } catch (error) {
    // The connection error may include the host or the user: only its code is shown.
    const code = (error as { code?: string }).code ?? 'no code';
    console.error(`Cannot prepare the DATABASE_URL database (${code})`);
    if (production) process.exit(1);
  }
}
