# Reproducible builds

The offline recovery tool is the user's last resort if the vault disappears: with it, the Emergency Kit and the recovery code they recover their seed on their own device, with no network. Because a malicious copy of the tool could steal exactly that, it is built reproducibly, it is identical for every deployment (no brand, no configuration), and its SHA-256 is published here. This document explains how it is built, how to verify it, how its Content Security Policy is pinned to its own contents, and how the separate static recovery page is built.

Related documents: [RECOVERY.md](RECOVERY.md) (how users use the tool), [DEPLOYMENT.md](DEPLOYMENT.md#offline-recovery-tool) (serving it), [THREAT-MODEL.md](THREAT-MODEL.md) (why the hash matters), [BRANDING.md](BRANDING.md#offline-recovery-tool) (why it is never branded).

## Published hashes (0.1.0)

```
6bd51cd1c1e3ab35a3b3a25c9d471f84a28fef4291ac58bd5a7cf64a5215dd63  wl-embedded-wallet-recovery.html
7324cf1edfc3c3ba81657f8112b231db633fbd9187ae06de689fb35ea75f7803  wl-embedded-wallet-recovery.mjs
```

These lines use the `sha256sum` format (hash, two spaces, file name), the same as `packages/recovery-tool/dist/SHA256SUMS`. The unit test `packages/recovery-tool/tests/html.test.ts` fails if the HTML hash above does not match the current build, so this document and the code cannot silently diverge.

For the hash to protect users, it must also be published **outside the vault's domain** (for example in release notes or on a separate site): a compromised vault could serve both a modified tool and a modified hash. In 0.1.0 it is published only in this repository.

## What is built

`packages/recovery-tool/scripts/build.mjs` produces, in `packages/recovery-tool/dist/`:

| File | Contents |
|---|---|
| `wl-embedded-wallet-recovery.html` | A single self-contained HTML page: markup from `src/page.html`, the stylesheet `src/page.css` inlined, and `src/page.ts` bundled with the core (including Argon2id as inlined WebAssembly) into one inline script |
| `wl-embedded-wallet-recovery.mjs` | A Node.js CLI (`src/cli.ts` bundled with the core), executable, with a `#!/usr/bin/env node` banner |
| `SHA256SUMS` | The SHA-256 of both files |

The script also prints both hash lines. It runs as part of `pnpm --filter @wl-embedded-wallet/recovery-tool build` (or `test`), and the vault's `dev` and `build` scripts run it first, because the vault serves the HTML at [`GET /recovery-tool`](HTTP-API.md#get-recovery-tool).

Both files run only `recoverFromKit` from `@wl-embedded-wallet/core/offline`: parse the kit, decrypt the seed backup with the code, derive the owner and the Safe, compare them with the kit, and reveal the seed only if both match ([CRYPTO-SPEC.md](CRYPTO-SPEC.md#11-seed-backup)).

## Why the output is deterministic

The same source tree, the same `pnpm-lock.yaml` (hence the same dependency versions) and the same esbuild version produce the same bytes. The build:

- uses `esbuild` pinned at **`0.28.2`** with fixed options: `bundle`, `minify`, `target: 'es2022'`, `charset: 'utf8'`, `legalComments: 'eof'`, `format: 'iife'` (page) or `'esm'` (CLI), `platform: 'browser'` or `'node'`;
- sets `absWorkingDir` to the package root and emits **no metafile and no source map**, so no absolute path of the build machine ends up in the output;
- writes in memory (`write: false`) and assembles the HTML by plain string replacement of `__CSP__`, `__CSS__` and `__JS__` in `src/page.html`;
- embeds no timestamps, no environment values other than `process.env.NODE_ENV = "production"`, and no brand or deployment configuration.

Nothing in the output depends on the operating system, the time, or the vault's configuration.

## No network by construction

Three independent layers:

1. **Build-time stub.** esbuild's `define` replaces every reference to `fetch` with `__noNetwork`, a function injected by the banner that throws `This tool does not use the network`. This also neutralizes network code in `abstractionkit`, which cannot be tree-shaken but is never called.
2. **CSP** in the page (below): `default-src 'none'` and `connect-src 'none'`.
3. **Tests:** `html.test.ts` checks there is no `fetch(`, `WebSocket`, `XMLHttpRequest` or `sendBeacon` in the inline script; `cli.test.ts` runs the CLI with `tests/no-network.mjs`, which makes any network use fail; the e2e suite opens the HTML from `file://` with the network cut.

## CSP pinned to the contents

The page carries its CSP in a `<meta http-equiv="Content-Security-Policy">` tag (a file opened from disk has no response headers). The build computes it from the exact inline script and style:

```
default-src 'none';
script-src 'sha256-<base64 SHA-256 of the inline script>' 'wasm-unsafe-eval';
style-src 'sha256-<base64 SHA-256 of the inline style>';
connect-src 'none';
img-src 'none';
base-uri 'none';
form-action 'none';
require-trusted-types-for 'script';
trusted-types 'none'
```

(joined with `; ` on one line in the file). Consequences:

- Only the one inline script and the one inline style whose hashes are listed can run or apply. Any modification to the script or the style without updating the CSP stops the page from working; a modified page must also change the CSP, and therefore the file's hash.
- No `unsafe-inline`, no `unsafe-eval`, no remote origins. `'wasm-unsafe-eval'` is required for Argon2id.
- `trusted-types 'none'` with `require-trusted-types-for 'script'` blocks every script-injection sink; the page only ever writes `textContent`.

Before assembling, the build refuses a bundle containing `</script` or `<!--`, which would end the inline script early. `html.test.ts` checks that the page loads nothing external (no `src`, `<link>`, `<img>`, `<iframe>`, `@import` or `url(`), that there is exactly one script, that the CSP hashes match the inline contents, and that Argon2id is inlined (no `.wasm` file).

## How to verify the tool

### What you downloaded

```bash
shasum -a 256 wl-embedded-wallet-recovery.html     # macOS
sha256sum wl-embedded-wallet-recovery.html         # Linux
```

Compare with the line in [Published hashes](#published-hashes-010) (and with a copy published outside the vault's domain). When the vault hands the tool out during enrollment, it computes the SHA-256 of the exact bytes it saved and shows it under the download button; the vault does **not** compare it with a published value itself, so the user or the operator has to.

### What a vault serves

```bash
curl -fsS https://vault.example.com/recovery-tool | sha256sum
```

Operators should run this after every deployment ([DEPLOYMENT.md](DEPLOYMENT.md#offline-recovery-tool)).

### Rebuild from source

```bash
git checkout <release tag or commit>
pnpm install --frozen-lockfile
pnpm --filter @wl-embedded-wallet/recovery-tool build
cat packages/recovery-tool/dist/SHA256SUMS
```

The output must equal the published lines. `html.test.ts` also rebuilds once more and requires `SHA256SUMS` to be byte-identical.

### Cross-platform evidence

- Two consecutive builds on the same machine are identical (unit test).
- In `pnpm test:e2e:image`, the tool served by the vault running **inside the Linux Docker image** (built in the image's own `pnpm build`) is downloaded and its hash compared with the `SHA256SUMS` built on the host (`e2e/tests/l-kit-tool.spec.ts`). This has been run with a macOS (arm64) host and a `linux/arm64` image.
- Windows builds and `linux/amd64` have not been checked ([TEST-STATUS.md](TEST-STATUS.md)).

### When the hash changes

Any change to `packages/recovery-tool/src`, to the parts of `packages/core` it bundles (`offline`, `kit`, `schema`, `seed-backup`, `recovery-code`, `safe`, `encoding`, `errors`, and their dependencies), to a resolved dependency version, or to esbuild changes the bytes. The release process must then update the published lines above (the unit test enforces the HTML line) and republish them outside the vault's domain.

## Static recovery page

The static recovery page is a different artifact: it lets users recover with kit + passkey + code (B+C) or kit + code on a static host, with no backend, using the same React components and the same worker logic as the vault's `/recover` page. Unlike the offline tool it **is** per deployment: it embeds the operator's RP ID, the manifest public key and the brand. It is therefore not covered by a single published hash; each operator publishes their own.

### Build

```bash
pnpm --filter ./apps/vault build:static-recovery \
  --rp-id vault.example.com \
  --manifest-pubkey <64 lowercase hex: the manifest Ed25519 public key> \
  --out dist/recovery \
  [--brand-dir brands/my-brand] [--brand "My Wallet"]
```

`apps/vault/scripts/build-static-recovery.mjs`:

- validates `--rp-id` as a host name, `--manifest-pubkey` as 32 bytes of lowercase hex, and `--brand` (1 to 64 characters, no control characters); the brand directory goes through the same validation as the vault's `brand.json` and the build fails on any issue;
- bundles `static-recovery/main.tsx` and `static-recovery/worker.ts` with esbuild (same pinned version, `minify`, `es2022`, ESM, no source maps); the worker's server dependencies are stubs that throw `NETWORK`, so only B+C and kit + code can work;
- copies `app/globals.css` as `recovery.css` and the brand files, and fills `static-recovery/index.html` (RP ID, public key and brand in `#vault-config`, brand header and footer);
- writes a `_headers` file (Netlify and Cloudflare Pages format) and a `SHA256SUMS` of every file it wrote, and prints those hashes.

Output files: `index.html`, `recovery.js`, `recovery-worker.js`, `recovery.css`, the brand files, `_headers`, `SHA256SUMS`.

Determinism: the bundles use the same pinned toolchain and options and no source maps, so rebuilding with the same inputs and lockfile should give the same files; this is not asserted by a test for the static page.

### Page CSP

In a `<meta>` tag in `index.html`:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'none'; worker-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types default
```

`connect-src 'none'`: the page cannot talk to anything, not even the vault. A Trusted Types `default` policy (`static-recovery/trusted-types.ts`, loaded first) admits only a same-origin script URL ending in `/recovery-worker.js`.

### Headers

A worker's CSP comes from the HTTP response that serves its script, not from the page's `<meta>` tag, so the host **must** send headers. `_headers` and the example `deploy/recovery.Caddyfile` send, for every path:

```
Content-Security-Policy: <the page CSP above>; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

### Hosting constraint

The page must be served from an origin valid for the vault's RP ID (the RP ID host itself or a subdomain, for example `recover.vault.example.com`), otherwise the browser refuses the passkey and only kit + code works. See [DEPLOYMENT.md](DEPLOYMENT.md#static-recovery-page) and [RECOVERY.md](RECOVERY.md#static-recovery-page).
