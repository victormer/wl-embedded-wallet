# What is tested and what is not

This page states, area by area, what the automated tests of WL Embedded Wallet 0.1.0 actually exercise, and
what has never been tested. It is meant for auditors and for anyone deciding whether to deploy. How to run each
suite is in [TESTING.md](TESTING.md); the security assumptions behind the gaps are in
[THREAT-MODEL.md](THREAT-MODEL.md) and the scope of the audit in [AUDIT-SCOPE.md](AUDIT-SCOPE.md).

**Version 0.1.0 is the initial, pre-audit release and is not ready for production or real funds.** Everything below was run on a
single development machine (macOS on Apple silicon, arm64), against local services only.

## The short version

**Tested:**

- All cryptographic and recovery logic, with unit tests and end to end in Chromium.
- WebAuthn only with **Chromium's virtual authenticator** (CDP `WebAuthn.addVirtualAuthenticator`, CTAP 2.1,
  internal transport, resident keys, user verification, `hasPrf: true`).
- The real Safe, Safe 4337 module and EntryPoint v0.7 **bytecode** on local **anvil** chains, with a **local test
  bundler and paymaster** written for this repository.
- The production Next.js build (strict CSP, Trusted Types), SQLite and Postgres 17.6 in Docker, and the Docker image
  built and run on **arm64** macOS.
- Rate limits (the vault's and the demo's auth limits), the JSON body cap and the sponsorship caps, with unit tests
  on SQLite and Postgres, in-process fake bundlers and paymasters, and the local test bundler. The Vercel paths
  (`x-real-ip`, `sslmode`, the demo's Postgres requirement) only with stubbed environment variables.

**Not tested:**

- Real passkeys and platform authenticators, and whether they support PRF.
- Safari, Firefox and any mobile browser.
- Any real or public bundler or paymaster, and any public network, testnet or L2. The sponsorship caps, their
  defaults and the bundler gas price floor have never met a real provider.
- A deployment on Vercel and Neon. A local build with `VERCEL=1` traced the brand and the offline tool into the
  functions, but nothing has been deployed, so the Vercel edge's `x-real-ip`, Neon's pooler and channel binding are
  unverified.
- The `linux/amd64` image.
- A real KMS (none is implemented: `MASTER_KEY` in the environment stands in for one).
- HTTPS with a real domain and certificate, so HSTS has never been sent end to end.
- Load, rate limiting under real load or behind a real reverse proxy, multi-region or highly available deployments,
  backup restore.

## Legend

| Status | Meaning |
|---|---|
| Tested | Exercised by automated tests that fail if the behavior breaks, under the conditions stated in the notes |
| Partially | Some paths or conditions are covered and others are not; the notes say which |
| Not tested | No automated test, and no manual verification is recorded |
| Not implemented | The feature does not exist in 0.1.0, so there is nothing to test |

Paths in the Evidence column are relative to the repository root. "e2e" means `e2e/tests/` run with
`pnpm test:e2e`; "image" means `pnpm test:e2e:image`.

## Cryptography and key material

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Shamir 2-of-3 split and combine (`@tetherto/wdk-utils`), every pair | Tested | `packages/core/tests/shamir.test.ts`, `shamir-wrapper.test.ts`; e2e `d-flows`, `m-bc-operational`, `l-kit-tool` | A+B, A+C, B+C and kit + code, against the real shares of each enrollment |
| Share envelopes (AES-256-GCM, AAD from the signed manifest, slot binding) | Tested | `apps/vault/tests/unit/envelope.test.ts`, `recovery.test.ts` | Bit flips, foreign user or set, substituted envelopes |
| Manifest signature (Ed25519), digests and the fixed verification order | Tested | `packages/core/tests/manifest.test.ts`; `apps/vault/tests/unit/recovery.test.ts`, `export.test.ts`, `sign.test.ts`; e2e `e-tampering` | Every abort happens before combining shares |
| Share A sealing with the KMS stub (HKDF from `MASTER_KEY`) | Tested | `apps/vault/tests/unit/server.test.ts`; image `image.spec.ts` (wrong `MASTER_KEY`) | Only the stub: see "Real KMS" |
| Real KMS or HSM, client-side encryption of share A to the KMS | Not implemented | `apps/vault/server/kms.ts` | Share A travels to the server in the clear over TLS and is encrypted there |
| Recovery code (128-bit, Crockford, normalization) and Argon2id for share C | Tested | `packages/core/tests/recovery-code.test.ts` | Parameters read from the envelope with upper bounds |
| Seed backup in the kit (Argon2id + AES-GCM, owner-bound AAD) | Tested | `packages/core/tests/seed-backup.test.ts`; `apps/vault/tests/unit/seed-backup.test.ts`; e2e `l-kit-tool` | e2e intercepts all activation traffic in both directions to show the backup and the seed never leave the browser |
| Passkey PRF to share B key (HKDF) | Partially | `apps/vault/tests/unit/prf.test.ts`; e2e (virtual authenticator) | The fallback that reads PRF at `get` when `create` only reports `enabled` is unit-tested with mocks only. The e2e harness logs which path the virtual authenticator used but does not assert it |
| Wiping of secrets in memory | Partially | `recovery.test.ts` ("zeroes prf and code"), `export.test.ts` ("wipes the received PRF"), `sign.test.ts` | Only `Uint8Array` buffers are checked. The seed exists in full in the worker during every operation, and JavaScript strings cannot be reliably wiped; residual memory is not tested |
| No secrets in console output or server logs | Tested | e2e harness (every test), e2e `h-leaks`; `apps/vault/tests/unit/no-leak.test.ts`, `api.test.ts` | With the real values of each run. Only what reaches the console and logs is checked |
| Test vectors of [CRYPTO-SPEC.md](CRYPTO-SPEC.md#22-test-vectors) section 22 | Tested | `packages/core/tests/crypto-spec-vectors.test.ts` | The values are parsed from the document, not copied into the test. The share A vector is checked with the core primitives, and its `info` template in the source of `apps/vault/server/kms.ts` |

## WebAuthn and passkeys

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Enrollment, unlock and signing with a passkey with PRF | Tested | e2e `a-account`, `b-deploy-sign`, `d-flows` | **Chromium virtual authenticator only** |
| Real platform and roaming authenticators (iCloud Keychain, Google Password Manager, Windows Hello, 1Password, hardware security keys) and their PRF support | Not tested | | No manual checklist has been completed. Whether each provider returns PRF at `create` or only at `get` is unknown |
| Authenticators without PRF | Partially | `apps/vault/tests/unit/prf.test.ts` ("aborts if enabled is true but get returns no result") | Not exercised with a real authenticator that lacks PRF |
| Cross-device (hybrid/QR) passkey use | Not tested | | |
| Registration verification (challenge, origin, RP ID, user verification) and stored public key | Tested | `apps/vault/tests/unit/passkey-recovery.test.ts` (fake authenticator with real crypto, `@simplewebauthn/server` 14.0.3) | |
| Recovery without a kit (discoverable credential + code, no JWT, never share A) | Tested | `passkey-recovery.test.ts`; e2e `n-passkey-recovery` | Uniform `401 RECOVERY_FAILED`; timing differences when no credential exists are not addressed |
| Signature counter | Partially | `passkey-recovery.test.ts`; store contract (`apps/vault/tests/store/contract.ts`) | Against a fake authenticator; real authenticator counter behavior not observed |
| RP ID boundary (same host and subdomain work, another domain fails) | Tested | e2e `m-bc-operational` | On `*.localhost` over HTTP in Chromium |

## Browsers and clients

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Chromium (Playwright's bundled build) | Tested | `e2e/playwright.config.ts` (`browserName: 'chromium'`) | Desktop viewport only |
| Safari / WebKit | Not tested | | `__Host-` cookies with `Secure` over plain HTTP may be rejected, which could require local HTTPS for manual testing; `file://` may not expose `crypto.subtle` to the offline tool |
| Firefox | Not tested | | Same caveats as Safari |
| Mobile browsers (iOS, Android), mobile popups and viewports | Not tested | | The CSS has a 420 px breakpoint, but no test renders it. Popup behavior of `window.open` on mobile is unverified |
| Accessibility (screen readers, keyboard-only use) | Not tested | | Contrast is validated in code at startup; there are no automated accessibility tests |

## Vault isolation and web security

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Origin isolation from a compromised integrator app (XSS cannot reach the vault DOM, shares, passkey or cookies) | Tested | e2e `g-isolation`, `k-multi-app` | Chromium only |
| CSP with nonce and Trusted Types | Tested | e2e `g-isolation` ("the vault blocks injected scripts and the Worker and WASM still work") | Production build in Chromium. `pnpm dev` does not apply the CSP |
| Session cookie (`__Host-`, httpOnly, Secure, SameSite=Strict) and origin checks | Tested | e2e `g-isolation`; `apps/vault/tests/unit/api.test.ts` | Over `http://vault.localhost` |
| `postMessage` protocol (exact origins, `*` only for `ready`) | Tested | `packages/sdk/tests/client.test.ts`; e2e `k-multi-app`, `g-isolation` | |
| Handoff JWT verification with JWKS: algorithms, `kid`, rotation, caching, outage, private material, `label` limits | Tested | `apps/vault/tests/unit/handoff.test.ts` (real local JWKS server), `api.test.ts`; e2e `g-isolation`; image (JWKS fetched from the container) | Key rotation is not exercised end to end in e2e |
| Single-use `jti` across replicas | Tested | store contract on Postgres (`pnpm test:pg`); image `image.spec.ts` (two replicas) | |
| No rejection spends the `jti` (origin, chain, per-sub limit) | Tested | `api.test.ts`, `handoff.test.ts`, `route-limits.test.ts` | |
| Stolen live token: yields share A only | Tested | e2e `g-isolation` | Documented accepted risk, not a defense |
| Share A of a pending set only to the session that created it, within a session lifetime | Tested | `apps/vault/tests/unit/share-a.test.ts`; e2e `g-isolation` ("a pending set: only the session that created it gets share A, for the drill") | A pending set created before migration 6 has no recorded session and is never released while pending |
| Share A release budgets (per session, per user) and the audit record of each release | Tested | `share-a.test.ts`; store contract (`share A releases`) | A release whose record cannot be written does not happen. Nobody is notified: see "Notifying the user" |
| Signed `origin` claim and several apps sharing one wallet | Tested | e2e `k-multi-app` | Two demo instances on different origins |
| Per-origin user consent the first time an app uses a wallet | Not implemented | | |
| Vault rate limiting (handoff, share A, enrollment, recovery challenges and assertions, relink nonces and relink, AA proxy, server-to-server) | Partially | `apps/vault/tests/unit/rate-limit.test.ts`, `limits.test.ts`, `route-limits.test.ts`, `share-a.test.ts`, `s2s.test.ts`, `aa-rpc.test.ts`, `passkey-recovery.test.ts`, `relink.test.ts` (SQLite, and Postgres with `pnpm test:pg`); store contract (`rate limits`, across replicas); `vault-api.test.ts` (a `429` reaches the page and the app as `RATE_LIMITED`) | Correct counting and `429 RATE_LIMITED` with `Retry-After` only. **Not under real load and not behind a real reverse proxy.** The e2e suite sets generous `RATE_LIMITS`, because all its browsers share `127.0.0.1`, so no e2e test reaches a limit |
| Client IP: socket peer from the `peer-address.cjs` preload, `TRUSTED_PROXIES` and `X-Forwarded-For` | Partially | `peer-address.test.ts`, `rate-limit.test.ts` ("clientIp"), `limits.test.ts` ("trustedProxies"); e2e and image start the vault with the preload | `TRUSTED_PROXIES` and `X-Forwarded-For` are exercised in unit tests only, never with Caddy or another real proxy. Through Docker's published port the peer may be the bridge gateway; not tested. The refusal to start in production without the preload is unit-tested only |
| Client IP on Vercel (`CLIENT_IP_SOURCE=vercel`, `x-real-ip`) | Partially | `rate-limit.test.ts` ("clientIp on Vercel"), `limits.test.ts` ("clientIpSource"), `peer-address.test.ts`, `config.test.ts` | Unit tests with `VERCEL` and `VERCEL_REGION` stubbed: only `x-real-ip` is read, forged `X-Forwarded-For` shares the budget, and `vercel` outside Vercel trusts nothing. That the Vercel edge overwrites `x-real-ip` is Vercel's documented behavior, not verified here |
| JSON body cap (128 KiB, `413 PAYLOAD_TOO_LARGE`) | Tested | `body-limit.test.ts`; `proxy.test.ts` (the middleware does not run on `/api/`) | Includes a `POST /api/shares` registration with every field at its validator limit |
| HSTS (`Strict-Transport-Security`, production on an `https` `ORIGIN` only) | Partially | `proxy.test.ts` (pages and `json()` API responses) | Unit tests only. Every e2e origin is plain HTTP, so HSTS is never sent there |
| Server-to-server input (`sub` format, `chainId` a positive safe integer) | Tested | `s2s.test.ts`, `api.test.ts`; e2e `g-isolation` | Invalid input touches neither the store nor the chain |
| Demo rate limiting (register, login, TOTP, TOTP setup) | Partially | `examples/demo/tests/unit/rate-limit.test.ts`, `db.test.ts` (SQLite, and Postgres with `pnpm test:pg`) | Counting, `429` with `Retry-After`, per-user TOTP limits and the client address rules. Not on Vercel and not under load; the e2e suite raises the limits. No per-email limit on login, by design |

## Account abstraction and chains

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Safe address prediction equals WDK's | Tested | `apps/vault/tests/unit/chains.test.ts`; `apps/vault/tests/integration/aa-contracts.test.ts` | |
| Same address on several chains | Tested | `aa-contracts.test.ts`; e2e `c-multichain` | Local anvil chains with identical bytecode |
| Deployment through bundler and paymaster (ERC-4337 v0.7, ERC-7677), built by the server (`vault_prepareDeployment`) and only signed in the browser | Tested | `aa-contracts.test.ts` (through the vault routes); `apps/vault/tests/unit/aa-rpc.test.ts` (fake bundler and paymaster, `fake-upstream.ts`); e2e `b-deploy-sign`, `c-multichain` | **Only against the local test bundler and paymaster** in `apps/vault/tests/aa-stack/` and in-process fakes. The local bundler does not estimate gas (it returns fixed limits) |
| The send must equal the prepared operation; idempotent resend; `ALREADY_SPONSORED`, `DEPLOYMENT_IN_PROGRESS`, `DEPLOYMENT_NOT_PREPARED`; release after an upstream failure | Tested | `aa-rpc.test.ts`; store contract (`sponsored deployments`, across replicas); e2e `b-deploy-sign` (idempotent resend, `ALREADY_SPONSORED` for a changed fee, `ALREADY_DEPLOYED` on prepare, `403` for `pm_getPaymasterData` and `eth_gasPrice`) | Resending after a transport timeout is only exercised against fakes |
| Sponsorship caps and fee rules (gas caps, `maxFeePerGas` cap, fee and tip multipliers, the bundler's `pimlico_getUserOperationGasPrice` floor and the fallback without it, 20 % margin, retry window, per-chain `limits`, paymaster response checks) | Partially | `aa-rpc.test.ts` (including "fee and gas rules"), `limits.test.ts` ("sponsorshipLimits"), `config.test.ts` | **Not tested against real bundlers or paymasters, nor on any L2**: only the local aa-stack and fake upstreams. The local test bundler does not answer `pimlico_getUserOperationGasPrice` and enforces no minimum fee. The defaults are not tuned for OP-stack or Arbitrum, where `preVerificationGas` includes the L1 data cost |
| Real or public bundlers and paymasters (for example Pimlico, Candide, Alchemy) | Not tested | | Gas estimation, error formats, sponsorship policies and rate limits of real providers are unverified |
| Public networks and testnets (Sepolia or any mainnet) | Not tested | | Nothing has ever been sent through the vault to a public network. The only public-network access is `apps/vault/tests/aa-stack/fetch-contracts.mjs`, a read-only `eth_getCode` run by hand to copy bytecode from Sepolia, and a manual read-only check (2026-11-11) that the expected contracts exist and the factory returns the predicted address on Sepolia, Polygon Amoy and Base Sepolia ([DEPLOYMENT.md](DEPLOYMENT.md#public-testnets)) |
| Deployment without a paymaster from the browser (`INSUFFICIENT_FUNDS` path) | Partially | `aa-rpc.test.ts` ("without a paymaster the same server-built path applies, within the same caps") | A self-funded UserOperation is accepted at contract level in `aa-contracts.test.ts`, and the server path is unit-tested, but the vault UI and worker path without a paymaster is not exercised |
| ERC-1271 message and EIP-712 signatures as the Safe | Tested | `aa-contracts.test.ts`; `examples/demo/tests/unit/api.test.ts`; e2e `b-deploy-sign`, `m-bc-operational` | A signature valid on one chain fails on another |
| UserOperation signing | Partially | `apps/vault/tests/unit/sign.test.ts`; `aa-contracts.test.ts` (real `handleOps`) | In e2e and in B+C mode the UserOperation is only checked by recovering the owner, without `handleOps` |
| Sending arbitrary UserOperations (transfers, calls) | Not implemented | `POST /api/aa/rpc` proxy policy | The proxy only forwards the deployment it prepared for the session's Safe; other operations get `OPERATION_NOT_ALLOWED`, and the bundler and paymaster methods `METHOD_NOT_ALLOWED` (unit-tested in `aa-rpc.test.ts` and `api.test.ts`) |
| Missing factory on a chain | Tested | `aa-contracts.test.ts`; e2e `c-multichain` | |
| Factory that returns a different address | Partially | `chains.test.ts` | Only with a fake RPC |
| Chains with different CREATE2 derivation (for example zkSync) | Not tested | | Rejected by design (the factory must return exactly the predicted address); no such chain was tried |
| RPC provenance (signed in the token, `AA_CHAINS` precedence, HTTPS, plain HTTP only to local hosts in insecure local mode, host allowlist, `eth_chainId` check, no redirects, size cap) | Tested | `chains.test.ts`; e2e `c-multichain`, `g-isolation` | In image mode the token RPC path is replaced by `AA_CHAINS`, so it is only covered by `pnpm test:e2e` |
| Owner change and its propagation across chains | Not implemented | | Changing the owner on one chain does not propagate; undeployed chains deploy with the original owner |
| On-chain recovery (second owner, guardians) | Not implemented | | |

## Recovery paths

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Unlock A+B, lost device A+C with re-enrollment, rotation revokes the previous set | Tested | e2e `d-flows`; `apps/vault/tests/unit/recovery.test.ts` | |
| B+C without the server (sign, export, no `/api` call) | Tested | e2e `d-flows`, `m-bc-operational`; `seed-backup.test.ts` | |
| Kit + code without passkey or server (offline tool HTML from `file://` and CLI) | Tested | e2e `l-kit-tool`; `packages/recovery-tool/tests/`; `packages/core/tests/offline.test.ts` | Chromium only for the HTML. Network cut off in e2e; the CLI runs under a detector that fails any network use |
| Old kit still opens after rotation | Tested | e2e `l-kit-tool` | Documents a known limit: rotation does not revoke old kits |
| Recovery tool required before every kit | Tested | e2e `p-tool-required` | Including failures fetching the tool |
| Static recovery page with the backend down | Partially | e2e `m-bc-operational`, `p-tool-required` | Served by a local static server in the e2e setup. **No real static hosting** (S3/CloudFront, Cloudflare Pages, Netlify) and the generated `_headers` file has not been tried on one |
| Reproducible build of the offline tool | Partially | `packages/recovery-tool/tests/html.test.ts` (two builds, same bytes); image (Linux build in the image equals the macOS host build) | macOS and Linux only; Windows not tried |
| Relink a wallet to another account | Tested | `apps/vault/tests/unit/relink.test.ts`; store contract on Postgres; `crypto-spec-vectors.test.ts` (relink typed data hash); e2e `o-relink` | Terminal errors reach the app, and the popup then only offers to go back (e2e `o-relink`, "a failed relink reaches the app with its code, the popup only offers to go back, and the app can retry") |
| Notifying the user of share A delivery or of a relink | Not implemented | | Only the server-side audit trails exist (share A releases, relinks) |

## Storage and operations

| Area | Status | Evidence | Notes |
|---|---|---|---|
| SQLite store (development and tests only) | Tested | `apps/vault/tests/unit/store.sqlite.test.ts` | Uses `node:sqlite`, which is experimental in Node 22 |
| Postgres store, migrations 001 to 006, advisory lock, parallel startup | Tested | `apps/vault/tests/pg/store.pg.test.ts` with the store contract (`pnpm test:pg`) | Postgres 17.6 in Docker, no SSL |
| Concurrency between replicas | Partially | Store contract with two connections to one database (including rate limit buckets, capped WebAuthn challenges and sponsored deployment claims); image `image.spec.ts` (two vault containers) | Correctness under races only; no load or soak testing |
| Load, throughput, latency, connection pool sizing | Not tested | | |
| Postgres with SSL (`sslmode`), managed Postgres (Neon), behind a connection pooler | Not tested | `postgres-url.test.ts`, `examples/demo/tests/unit/db.test.ts` (URL normalization only) | The `sslmode` and `channel_binding` rewriting is unit-tested; no connection over SSL or through a pooler has been made |
| Demo database on Postgres | Tested | `examples/demo/tests/unit/db.test.ts`, `api.test.ts`, `rate-limit.test.ts` with `pnpm test:pg` | Postgres 17.6 in Docker, no SSL. The e2e suite runs the demo on SQLite only |
| Vercel build and deployment (`VERCEL=1`: no standalone output, brand and tool traced into the functions, `maxDuration`, previews disabled) | Partially | | A local Vercel-like build traced the brand files into every route and the tool into `/recovery-tool`, checked by hand. Never deployed: `/recovery-tool` and the brand on a real deployment, Deployment Protection, Fluid compute and the cross-site cookies on `*.vercel.app` are unverified |
| Backup and restore | Not tested | | Migrations have no down path; restore is the only rollback |
| Multi-region, failover, high availability | Not tested | | |
| Docker image on `linux/arm64` | Tested | image `image.spec.ts` (non-root, read-only root file system, dropped capabilities, no keys or `.env` in layers or history) | Built and run on arm64 macOS only |
| Docker image on `linux/amd64` | Not tested | | Never built or run here. `sodium-native` ships Linux binaries for both, but that is unverified for this image |
| Startup validation of configuration and brand | Tested | `apps/vault/tests/unit/config.test.ts`, `limits.test.ts`, `peer-address.test.ts`, `brand.test.ts`; e2e `i-deployment` | Errors name the variable, never its value. The limit variables (`CLIENT_IP_SOURCE`, `TRUSTED_PROXIES`, `RATE_LIMITS`, `SHARE_A_*`, `RECOVERY_CHALLENGE_MAX_LIVE`, `AA_*`), the Vercel-only checks (`sslmode`, the client IP source) and the missing preload are unit-tested only |
| Health check and recovery after a database outage | Tested | e2e `i-deployment`; image `image.spec.ts` | |
| Wrong or lost `MASTER_KEY` | Partially | image `image.spec.ts` (wrong key does not deliver A, correct key keeps working) | Loss of the key is not simulated as such; the B+C and kit + code paths that remain are tested independently |
| HTTPS with a real domain and certificate (Caddy `tls` profile) | Partially | image `image.spec.ts` | Only `docker compose config` and `caddy validate`. All e2e traffic is plain HTTP on `*.localhost` with `ALLOW_INSECURE_LOCAL=1`; an HTTPS origin, HSTS included, has never been exercised end to end |
| Published image in a registry, signed images, SBOM | Not implemented | | The image is built locally only |
| Observability (metrics, tracing, alerting) | Not implemented | | Logs to stdout and `/api/health` only |

## Branding

| Area | Status | Evidence | Notes |
|---|---|---|---|
| `brand.json` validation, contrast, accent hue, file and SVG checks, limits | Tested | `apps/vault/tests/unit/brand.test.ts` | See [BRANDING.md](BRANDING.md) |
| Serving brand files by hash with safe headers, no traversal | Tested | `apps/vault/tests/unit/brand-route.test.ts`; e2e `i-deployment` | |
| A mounted brand applied without rebuilding, notices unchanged | Tested | e2e `i-deployment`; image (example brand mounted at `/brand`) | |
| Contrast of derived colors (hover shade, tints) for arbitrary brands | Not tested | | Only the seven validated pairs are checked |

## Integrator side

| Area | Status | Evidence | Notes |
|---|---|---|---|
| SDK client, handoff token minting (EdDSA, ES256, RS256), JWKS helpers, server-to-server client | Tested | `packages/sdk/tests/` | |
| SDK result validation (`PROTOCOL_ERROR`), `timeoutMs` (`TIMEOUT`), `INTERNAL` when the popup cannot be opened or posted to | Tested | `packages/sdk/tests/client.test.ts` ("result validation", "timeoutMs") | Against a simulated popup, not a real browser window |
| Terminal errors of `/relink` and `/export` reach the app instead of waiting for the popup to close | Tested | e2e `o-relink`, `f-export` ("without a wallet, the app receives NO_WALLET instead of waiting for the popup to close") | |
| Documentation examples compile into working tokens | Tested | `packages/sdk/tests/docs-example.test.ts`; image (`curl` from `docs/INTEGRATION.md`) | |
| Demo app (registration, TOTP and its replay, `DEMO_CHAINS` validation, JWKS, signature verification, database, rate limits) | Tested | `examples/demo/tests/unit/api.test.ts` ("second factor replay", "chain configuration"), `chains.test.ts`, `db.test.ts`, `rate-limit.test.ts`, `messages.test.ts`; e2e | The demo is an example, not a hardened product. TOTP guessing during the intermediate session is bounded by the per-user `totp` limit (10 a minute by default) and a code is accepted only once |
| Integration with a real third-party identity provider or backend | Not tested | | Only the demo backend issues tokens |

## Dependencies

| Area | Status | Notes |
|---|---|---|
| `@tetherto/wdk-utils` 1.0.0-beta.16, `@tetherto/wdk-wallet-evm-erc-4337` 1.0.0-beta.24 | Pinned, beta | Beta packages without compatibility guarantees between versions. A unit test checks that the pinned wdk-utils version matches what is installed |
| `abstractionkit` 0.4.0 in the browser worker | Tested for address equality with WDK | WDK's ERC-4337 wallet does not bundle into the worker, so the browser uses `abstractionkit` directly; the server uses WDK as a cross-check |
| Third-party dependency audit | Not done | No external review of the dependency tree has been performed |

## Manual verification that would close the largest gaps

None of these has been done. They are listed so that whoever picks them up can record the result.

- Real passkeys with PRF: Chrome on macOS with iCloud Keychain, Safari 18 or later, Android with Google Password
  Manager, 1Password, Windows Hello on an up-to-date Windows 11, and a hardware security key. For each, record
  whether the PRF output arrives at `create` or only at `get` (the vault exposes this as `data-source` on the
  `prf-source` element during enrollment).
- The full flow in Safari and Firefox, including the offline tool opened from `file://`.
- Deployment and signing on a public testnet with a real bundler and paymaster, including an L2, to check the
  sponsorship caps and their defaults.
- The image built and run on `linux/amd64`.
- An HTTPS deployment on a real domain with the `tls` profile, including HSTS and the rate limits behind Caddy with
  `TRUSTED_PROXIES` set, and under load.
- Postgres over SSL and behind a pooler, and a backup restore.
- The Vercel and Neon deployment, with the [smoke tests](DEPLOYMENT.md#smoke-tests) in DEPLOYMENT.md, including a
  sponsored deployment through Pimlico on each of the three [public testnets](DEPLOYMENT.md#public-testnets).

## Related documents

[TESTING.md](TESTING.md), [AUDIT-SCOPE.md](AUDIT-SCOPE.md), [THREAT-MODEL.md](THREAT-MODEL.md),
[SECURITY.md](../SECURITY.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DEPLOYMENT.md](DEPLOYMENT.md),
[RECOVERY.md](RECOVERY.md), [ROADMAP.md](ROADMAP.md), [DECISIONS.md](DECISIONS.md).
