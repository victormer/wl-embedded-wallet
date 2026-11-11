// Reproducible build of the offline tool: the same sources, lockfile and esbuild version give the same bytes.
// Produces `dist/wl-embedded-wallet-recovery.html`, `dist/wl-embedded-wallet-recovery.mjs` and `dist/SHA256SUMS`.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
export const HTML_NAME = 'wl-embedded-wallet-recovery.html';
export const CLI_NAME = 'wl-embedded-wallet-recovery.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const cspHash = (value) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;

// An absolute path in the output would break reproducibility, and `metafile` or `sourcemap` would add one.
const common = {
  absWorkingDir: root,
  bundle: true,
  minify: true,
  write: false,
  logLevel: 'silent',
  charset: 'utf8',
  legalComments: 'eof',
  target: 'es2022',
  // abstractionkit cannot be tree-shaken and contains network code that is never called here. This way it does not even exist.
  define: { 'process.env.NODE_ENV': '"production"', fetch: '__noNetwork' },
};
const NO_NETWORK = "const __noNetwork=()=>{throw new Error('This tool does not use the network')};";

async function bundle(options) {
  const { outputFiles } = await build({ ...common, ...options });
  return outputFiles[0].text;
}

const js = await bundle({ entryPoints: ['src/page.ts'], platform: 'browser', format: 'iife', banner: { js: NO_NETWORK } });
// esbuild already escapes these sequences. If one appeared, the script would close prematurely.
if (/<\/script|<!--/i.test(js)) throw new Error('The bundle contains a sequence that breaks the inline script');

const css = readFileSync(join(root, 'src/page.css'), 'utf8').trim();
// With `connect-src` and `default-src` set to 'none', nothing can get out. `form-action` and `base-uri` close the other exits.
const csp = [
  "default-src 'none'",
  `script-src ${cspHash(js)} 'wasm-unsafe-eval'`,
  `style-src ${cspHash(css)}`,
  "connect-src 'none'",
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const html = readFileSync(join(root, 'src/page.html'), 'utf8')
  .replace('__CSP__', () => csp)
  .replace('__CSS__', () => css)
  .replace('__JS__', () => js);

const cli = await bundle({
  entryPoints: ['src/cli.ts'],
  platform: 'node',
  format: 'esm',
  banner: { js: `#!/usr/bin/env node\n${NO_NETWORK}` },
});

mkdirSync(dirname(join(dist, HTML_NAME)), { recursive: true });
writeFileSync(join(dist, HTML_NAME), html);
writeFileSync(join(dist, CLI_NAME), cli, { mode: 0o755 });
writeFileSync(join(dist, 'SHA256SUMS'), `${sha256(html)}  ${HTML_NAME}\n${sha256(cli)}  ${CLI_NAME}\n`);
console.log(`${sha256(html)}  ${HTML_NAME}\n${sha256(cli)}  ${CLI_NAME}`);
