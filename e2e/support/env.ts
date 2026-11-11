import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';

export const ROOT = resolve(import.meta.dirname, '../..');
export const RUN_DIR = resolve(import.meta.dirname, '../.run');
export const STATE_FILE = resolve(RUN_DIR, 'state.json');
export const SECRETS_FILE = resolve(RUN_DIR, 'secrets.txt');
export const DIST_DIR = '.next-e2e';
export const VAULT_STANDALONE = resolve(ROOT, 'apps/vault', DIST_DIR, 'standalone/apps/vault');

export const APP = 'http://app.localhost:4300';
// Another app, on another domain, with the same login and the same keys.
export const APP2 = 'http://app2.localhost:4302';
export const VAULT = 'http://vault.localhost:4301';
export const RP_ID = 'vault.localhost';
// The static recovery page, without a backend. Same host as the RP ID, on another port.
export const STATIC_RECOVERY_PORT = 4306;
export const STATIC_RECOVERY = `http://vault.localhost:${STATIC_RECOVERY_PORT}`;
// A subdomain of the RP ID is a valid origin for the passkey. Another domain is not.
export const STATIC_RECOVERY_SUBDOMAIN = `http://recovery.vault.localhost:${STATIC_RECOVERY_PORT}`;
export const STATIC_RECOVERY_FOREIGN = `http://other.localhost:${STATIC_RECOVERY_PORT}`;
export const RECOVERY_TOOL_DIST = resolve(ROOT, 'packages/recovery-tool/dist');
export const PASSWORD = 'long-test-password';
// The example brand: used by the suite's main vault and by the static page.
export const EXAMPLE_BRAND_DIR = resolve(ROOT, 'brands/example');
// Inside the container, mounted read-only here (`e2e/compose.image.yaml` and `support/image.ts`).
export const CONTAINER_BRAND_DIR = '/brand';

export const CHAIN_A = 31001;
export const CHAIN_B = 31002;
export const CHAIN_NO_FACTORY = 31003;
export const CHAIN_WRONG_RPC = 31004;
export const CHAIN_OUTSIDE = 31005;

// Ports different from `pnpm aa:stack`, so the e2e suite can run while the development environment is up.
export const RPC_PORTS = { [CHAIN_A]: 38545, [CHAIN_B]: 38546, [CHAIN_NO_FACTORY]: 38547 };
export const PORTS = [4300, 4301, 4302, 4303, 4304, 4305, 4306, 38545, 38546, 38547, 39545, 39546, 40545, 40546];

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// Deterministic keys, for this suite only.
function testKey(label: string): string {
  return createHash('sha256').update(`wl-embedded-wallet/e2e/${label}`).digest('hex');
}

function publicKey(privateKeyHex: string): string {
  return hexOf(ed25519.getPublicKey(Buffer.from(privateKeyHex, 'hex')));
}

export const MANIFEST_SIGNING_KEY = testKey('manifest');
export const MANIFEST_PUBKEY = publicKey(MANIFEST_SIGNING_KEY);
export const HANDOFF_PRIVATE_KEY = testKey('handoff');
export const HANDOFF_PUBKEY = publicKey(HANDOFF_PRIVATE_KEY);
export const HANDOFF_KID = 'e2e-key';
export const TOKEN_CLAIMS = { iss: APP, aud: VAULT, origin: APP, kid: HANDOFF_KID };
export const SERVICE_TOKEN = testKey('service-token');

// The vault configuration is runtime only: the build carries no keys.
export const VAULT_BUILD_ENV = { NEXT_DIST_DIR: DIST_DIR };

export function vaultEnv(dbPath: string, aaChains: unknown): Record<string, string> {
  return {
    ...VAULT_BUILD_ENV,
    RP_ID,
    MASTER_KEY: testKey('master-key'),
    MANIFEST_SIGNING_KEY,
    // The demo's real JWKS. From the container, the demo is on the host.
    HANDOFF_JWKS_URL: `http://${process.env.E2E_VAULT_IMAGE === '1' ? 'rpc.localhost' : 'app.localhost'}:4300/.well-known/jwks.json`,
    HANDOFF_ISSUER: APP,
    HANDOFF_AUDIENCE: VAULT,
    VAULT_SERVICE_TOKEN: SERVICE_TOKEN,
    ORIGIN: VAULT,
    // `pnpm test:e2e:pg` runs the suite against Postgres.
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? `sqlite:${dbPath}`,
    ALLOW_INSECURE_LOCAL: '1',
    RPC_ALLOWED_HOSTS: '127.0.0.1',
    AA_CHAINS: JSON.stringify(aaChains),
    VAULT_BRAND_DIR: process.env.E2E_VAULT_IMAGE === '1' ? CONTAINER_BRAND_DIR : EXAMPLE_BRAND_DIR,
    // Every browser of the suite connects from the same address, and one worker opens many popups a minute: the
    // defaults would throttle the suite itself. The limits themselves are tested by the unit and Postgres suites.
    RATE_LIMITS: JSON.stringify(
      Object.fromEntries(
        ['handoff', 'share-a', 'recovery-challenge', 'recovery-assertion', 'relink-nonce', 'relink', 'aa', 's2s', 'enroll'].map((scope) => [scope, { ip: 100_000, sub: 100_000 }]),
      ),
    ),
  };
}

export function demoEnv(dbPath: string, rpcUrl: Record<number, string>, origin: string = APP): Record<string, string> {
  return {
    NEXT_DIST_DIR: DIST_DIR,
    DEMO_HANDOFF_PRIVATE_KEY: HANDOFF_PRIVATE_KEY,
    DEMO_HANDOFF_KID: HANDOFF_KID,
    DEMO_TOTP_KEY: testKey('demo-totp'),
    VAULT_SERVICE_TOKEN: SERVICE_TOKEN,
    VAULT_ORIGIN: VAULT,
    ORIGIN: origin,
    // There is a single login: both apps sign with the same `iss`, each with its own `origin`.
    DEMO_HANDOFF_ISSUER: APP,
    DB_PATH: dbPath,
    // Empty: a DATABASE_URL in the developer's shell never reaches the demo, which stays on SQLite at DB_PATH.
    DATABASE_URL: '',
    // Every browser comes from one address and the suite logs in many times.
    DEMO_RATE_LIMITS: JSON.stringify(Object.fromEntries(['register', 'login', 'totp', 'totp-setup'].map((scope) => [scope, { ip: 100_000, user: 100_000 }]))),
    DEMO_CHAINS: JSON.stringify([
      { chainId: CHAIN_A, name: 'Chain A', rpcUrl: rpcUrl[CHAIN_A] },
      { chainId: CHAIN_B, name: 'Chain B', rpcUrl: rpcUrl[CHAIN_B] },
      { chainId: CHAIN_NO_FACTORY, name: 'No factory', rpcUrl: rpcUrl[CHAIN_NO_FACTORY] },
      // This RPC answers with a different `eth_chainId`.
      { chainId: CHAIN_WRONG_RPC, name: 'RPC of another chain', rpcUrl: rpcUrl[CHAIN_A] },
      { chainId: CHAIN_OUTSIDE, name: 'Host outside the allowlist', rpcUrl: 'https://outside.test/rpc' },
    ]),
  };
}

export interface RunState {
  chains: Record<number, { rpcUrl: string; paymasterAddress?: string }>;
  entryPoint: `0x${string}`;
  // Only with `pnpm test:e2e:image`: the container's `AA_CHAINS`.
  imageAaChains?: unknown;
}
