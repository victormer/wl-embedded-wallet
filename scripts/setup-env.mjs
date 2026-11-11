// Generates apps/vault/.env.local and examples/demo/.env.local with mutually consistent keys.
// If they already exist, it only adds what is missing and never regenerates a key. `--force` regenerates them.
// It never prints a secret. `--root <dir>` changes the root directory, for tests.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : resolve(import.meta.dirname, '..');
const vaultPath = join(root, 'apps/vault/.env.local');
const demoPath = join(root, 'examples/demo/.env.local');

const vaultOrigin = 'http://vault.localhost:3201';
const appOrigin = 'http://app.localhost:3200';

function kidFor(publicKeyHex) {
  return `handoff-${createHash('sha256').update(publicKeyHex).digest('hex').slice(0, 16)}`;
}

/** Public key of a 32-byte Ed25519 private key, via its PKCS#8 DER header. */
function publicKeyOf(privateKeyHex) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(privateKeyHex, 'hex')]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('hex');
}

function readEnv(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

const valueOf = (lines, name) => lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);

/** Adds new variables to an existing environment. Existing keys are left untouched. */
function upgrade() {
  if (!existsSync(vaultPath) || !existsSync(demoPath)) {
    console.error('Only one of the .env.local files exists. Use --force to regenerate both: existing data will no longer be readable.');
    process.exit(1);
  }
  const added = [];
  const demo = readEnv(demoPath);
  const addDemo = (name, value) => {
    if (valueOf(demo, name) !== undefined) return;
    demo.push(`${name}=${value()}`);
    added.push(name);
  };
  addDemo('DEMO_HANDOFF_KID', () => kidFor(publicKeyOf(valueOf(demo, 'DEMO_HANDOFF_PRIVATE_KEY'))));
  addDemo('DEMO_TOTP_KEY', () => randomBytes(32).toString('hex'));

  let vault = readEnv(vaultPath);
  const addVault = (name, value) => {
    if (valueOf(vault, name) !== undefined) return;
    vault.push(`${name}=${value}`);
    added.push(name);
  };
  const app = valueOf(demo, 'ORIGIN') ?? appOrigin;
  addVault('HANDOFF_JWKS_URL', `${app}/.well-known/jwks.json`);
  addVault('HANDOFF_ISSUER', app);
  addVault('HANDOFF_AUDIENCE', valueOf(vault, 'ORIGIN') ?? vaultOrigin);
  // A single path: that public key is already published in the demo's JWKS.
  vault = vault.filter((line) => !line.startsWith('HANDOFF_PUBLIC_KEY='));

  writeFileSync(demoPath, `${demo.join('\n')}\n`, { mode: 0o600 });
  writeFileSync(vaultPath, `${vault.join('\n')}\n`, { mode: 0o600 });
  console.log(added.length ? `Added: ${added.join(', ')}.` : 'The .env.local files are already up to date.');
}

if ((existsSync(vaultPath) || existsSync(demoPath)) && !args.includes('--force')) {
  upgrade();
  process.exit(0);
}

function ed25519Hex() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const toHex = (b64url) => Buffer.from(b64url, 'base64url').toString('hex');
  return {
    publicKey: toHex(publicKey.export({ format: 'jwk' }).x),
    privateKey: toHex(privateKey.export({ format: 'jwk' }).d),
  };
}

const manifest = ed25519Hex();
const handoff = ed25519Hex();
const serviceToken = randomBytes(32).toString('hex');
// The local networks from apps/vault/tests/aa-stack/run.mjs: RPC on the port, bundler on +1000 and paymaster on +2000.
const localAaChains = Object.fromEntries(
  [[31001, 21545], [31002, 21546]].map(([chainId, port]) => [
    chainId,
    { name: `Local ${chainId}`, bundlerUrl: `http://127.0.0.1:${port + 1000}`, paymasterUrl: `http://127.0.0.1:${port + 2000}` },
  ]),
);
const localDemoChains = [
  { chainId: 31001, name: 'Local A', rpcUrl: 'http://127.0.0.1:21545' },
  { chainId: 31002, name: 'Local B', rpcUrl: 'http://127.0.0.1:21546' },
  { chainId: 31003, name: 'Local without factory', rpcUrl: 'http://127.0.0.1:21547' },
];

const vault = [
  `MASTER_KEY=${randomBytes(32).toString('hex')}`,
  `MANIFEST_SIGNING_KEY=${manifest.privateKey}`,
  `HANDOFF_JWKS_URL=${appOrigin}/.well-known/jwks.json`,
  `HANDOFF_ISSUER=${appOrigin}`,
  `HANDOFF_AUDIENCE=${vaultOrigin}`,
  `VAULT_SERVICE_TOKEN=${serviceToken}`,
  'RP_ID=vault.localhost',
  `ORIGIN=${vaultOrigin}`,
  'DATABASE_URL=sqlite:data/vault.db',
  // Local only: `pnpm start` runs in production mode, over http and with SQLite.
  'ALLOW_INSECURE_LOCAL=1',
  // Hosts allowed for an RPC carried in the token, and the networks of `pnpm --filter ./apps/vault aa:stack`.
  'RPC_ALLOWED_HOSTS=127.0.0.1',
  `AA_CHAINS=${JSON.stringify(localAaChains)}`,
  // The project's own brand, relative to apps/vault (the e2e suites mount brands/example themselves).
  // Without it, the vault's neutral brand is used.
  'VAULT_BRAND_DIR=../../brands/wl',
];

const demo = [
  `DEMO_HANDOFF_PRIVATE_KEY=${handoff.privateKey}`,
  `DEMO_HANDOFF_KID=${kidFor(handoff.publicKey)}`,
  `DEMO_TOTP_KEY=${randomBytes(32).toString('hex')}`,
  `VAULT_SERVICE_TOKEN=${serviceToken}`,
  `VAULT_ORIGIN=${vaultOrigin}`,
  `ORIGIN=${appOrigin}`,
  'DB_PATH=data/demo.db',
  `DEMO_CHAINS=${JSON.stringify(localDemoChains)}`,
];

writeFileSync(vaultPath, `${vault.join('\n')}\n`, { mode: 0o600 });
writeFileSync(demoPath, `${demo.join('\n')}\n`, { mode: 0o600 });
console.log('Generated apps/vault/.env.local and examples/demo/.env.local.');
