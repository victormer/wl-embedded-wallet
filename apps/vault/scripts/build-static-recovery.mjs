// Static recovery page: kit + passkey + code, no backend. It can be deployed on any static hosting,
// on an origin valid for the RP ID. See docs/DEPLOYMENT.md#static-recovery-page.
//   pnpm --filter ./apps/vault build:static-recovery --rp-id vault.example.com --manifest-pubkey <hex> --out dist/recovery [--brand-dir brands/my-brand]
// `--brand-dir` is the same brand directory the vault mounts (`VAULT_BRAND_DIR`), with its `brand.json`.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

const { values } = parseArgs({
  options: {
    'rp-id': { type: 'string' },
    'manifest-pubkey': { type: 'string' },
    // Overrides the name in `brand.json`, like `VAULT_BRAND_NAME` in the vault.
    brand: { type: 'string' },
    'brand-dir': { type: 'string' },
    out: { type: 'string', default: 'dist/static-recovery' },
  },
  allowPositionals: true,
});

const rpId = values['rp-id'];
const manifestPubKey = values['manifest-pubkey'];
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
if (!rpId || !HOST.test(rpId)) throw new Error('--rp-id must be exactly the vault RP_ID');
if (!manifestPubKey || !/^[0-9a-f]{64}$/.test(manifestPubKey)) throw new Error('--manifest-pubkey must be the manifest public key: 32 bytes in lowercase hex');
if (values.brand !== undefined && (values.brand.trim() === '' || values.brand.length > 64 || /[\p{Cc}]/u.test(values.brand))) {
  throw new Error('--brand must be between 1 and 64 characters, with no control characters');
}

// `connect-src 'none'`: the page cannot talk to anything, not even the vault.
const pageCsp = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "img-src 'self'",
  // Only the brand fonts, next to the HTML.
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types default',
].join('; ');
// A worker's CSP comes from its script response, and a `<meta>` does not reach it: it needs headers from the hosting.
const headersCsp = `${pageCsp}; frame-ancestors 'none'`;

const common = {
  absWorkingDir: root,
  bundle: true,
  minify: true,
  write: false,
  logLevel: 'silent',
  charset: 'utf8',
  legalComments: 'eof',
  target: 'es2022',
  platform: 'browser',
  format: 'esm',
  tsconfig: 'tsconfig.json',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
};

async function bundle(entry) {
  const { outputFiles } = await build({ ...common, entryPoints: [entry] });
  return outputFiles[0].text;
}

/** The same validation and the same components as the vault, bundled for Node. */
async function staticBrand() {
  // Inside apps/vault, so that `react` and `react-dom` resolve from its node_modules.
  const dir = mkdtempSync(join(root, '.brand-build-'));
  try {
    const file = join(dir, 'brand-build.mjs');
    await build({ ...common, entryPoints: ['static-recovery/brand-build.tsx'], platform: 'node', packages: 'external', write: true, outfile: file, legalComments: 'none' });
    const { renderStaticBrand } = await import(pathToFileURL(file).href);
    return renderStaticBrand(values['brand-dir'] && resolve(process.cwd(), values['brand-dir']), values.brand);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const brand = await staticBrand();
if (brand.issues.length > 0) {
  for (const { variable, reason } of brand.issues) console.error(`Invalid brand: ${variable} ${reason}`);
  process.exit(1);
}

const files = {
  'recovery.js': await bundle('static-recovery/main.tsx'),
  'recovery-worker.js': await bundle('static-recovery/worker.ts'),
  'recovery.css': readFileSync(join(root, 'app/globals.css'), 'utf8'),
  'index.html': readFileSync(join(root, 'static-recovery/index.html'), 'utf8')
    .replace('__CSP__', () => pageCsp)
    .replace('__RP_ID__', () => rpId)
    .replace('__MANIFEST_PUBKEY__', () => manifestPubKey)
    .replace('__BRAND_HEAD__', () => brand.head)
    .replace('__BRAND_HEADER__', () => brand.header)
    .replace('__BRAND_FOOTER__', () => brand.footer)
    .replaceAll('__BRAND__', () => brand.name),
  ...brand.files,
  // Netlify and Cloudflare Pages format. On other hosting, use the same headers: see docs/DEPLOYMENT.md#static-recovery-page.
  _headers: `/*\n  Content-Security-Policy: ${headersCsp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`,
};

const out = resolve(process.cwd(), values.out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sums = [];
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(out, name), content);
  sums.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(sums.join('\n'));
