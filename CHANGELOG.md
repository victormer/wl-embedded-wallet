# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

Fixes made before the external security audit. Not audited and not ready to hold real funds ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)).

**Breaking changes.** For integrators:

- the project rename to WL Embedded Wallet: package scope, protocol and cryptographic labels;
- the relink EIP-712 labels (relinks in flight fail);
- the `/api/aa/rpc` protocol;
- the SDK's stricter result validation and new error codes;
- `429` and `413` responses;
- validation on the s2s route.

For operators:

- the `peer-address.cjs` preload is required in production;
- `TRUSTED_PROXIES` is needed behind a proxy;
- migration 006 runs at startup;
- an invalid `DEMO_CHAINS` in the demo is now an error.

Each one is marked **Breaking** below.

### Security

- **Server-built sponsored deployment.** Before, the browser built the deployment UserOperation and the server checked only `sender`, `factory`, `factoryData`, `callData` and `nonce`, so a session could choose the gas limits, fees and paymaster fields the paymaster sponsored. Now the server builds it (`vault_prepareDeployment`):
  - fees come from the node, gas from the bundler's estimate (plus 20 %) and paymaster fields from the paymaster, each within caps;
  - it records the operation in `sponsored_deployments`;
  - `eth_sendUserOperation` forwards only that exact operation with the owner's signature, once per Safe and chain;
  - a resend of the same operation returns the recorded hash, and a different one is refused;
  - another sponsored deployment of the same Safe is allowed only after `AA_DEPLOYMENT_RETRY_SECONDS`;
  - receipts are only for the recorded hash;
  - paymaster and estimate results are validated (`UPSTREAM_INVALID`).
- **Rate limiting** in the vault (`server/rate-limit.ts`, `server/limits.ts`):
  - per-IP and per-`sub` fixed-window budgets per scope, stored in the database and shared by replicas;
  - scopes: handoff, share A, enrollment, kit-free recovery challenge and assertion, relink nonce and relink, AA status and proxy, s2s;
  - over a budget: `429 RATE_LIMITED` with `Retry-After`;
  - the client IP is the socket peer, set by a preload; `X-Forwarded-For` is read only from `TRUSTED_PROXIES`; IPv6 is keyed by its /64.
- **Kit-free recovery challenges** are capped globally (`RECOVERY_CHALLENGE_MAX_LIVE`), so they can no longer grow the table at will.
- **Request bodies** are capped at 128 KiB in `readJson` (`413 PAYLOAD_TOO_LARGE`), checking both `Content-Length` and the stream. The Next.js proxy no longer runs on `/api/`, because it buffered request bodies of up to 10 MB before the route ran.
- **HSTS:** `Strict-Transport-Security: max-age=31536000` on pages and API responses, in production with an `https` `ORIGIN`.
- **Share A release:**
  - a `pending` set's share A is released only to the session that created it, and only while it is younger than a session; otherwise `404`;
  - releases are budgeted per session and per user (`SHARE_A_*`), and the budgets are counted before the lookup;
  - every release is recorded in the new `share_a_releases` audit table before A is returned.
- **Handoff:**
  - every check, including `CHAIN_REQUEST_MISMATCH` and the per-`sub` rate limit, now runs before the `jti` is spent, so no rejection spends a token;
  - `label` is limited to 256 UTF-16 code units, with no control characters.
- **Token RPC URLs** may use plain HTTP only on local hosts and only in insecure local mode. Before, this was allowed in production too, when the host was in `RPC_ALLOWED_HOSTS`.
- **s2s route (Breaking for integrators):**
  - `sub` must match the handoff pattern (`400 INVALID_SUB`);
  - `chainId` must be a positive safe integer (`400 INVALID_CHAIN_ID`), also for accounts that do not exist;
  - invalid input touches neither the store nor the chain.
- **SDK result validation (Breaking for integrators):**
  - each action's result is validated, and a malformed result for the current request rejects at once with `PROTOCOL_ERROR` instead of waiting for the popup to close;
  - optional `timeoutMs`;
  - `jwksHandler` answers `500 INTERNAL` instead of throwing when a key carries private material.
- **Demo:** TOTP codes cannot be reused (`users.totp_last_step`).
- **Client address on Vercel** (`server/limits.ts`, `server/rate-limit.ts`, `server/startup.ts`): `CLIENT_IP_SOURCE=vercel` keys rate limits on `x-real-ip`, which the Vercel edge overwrites, and only when `VERCEL=1` and the runtime-only `VERCEL_REGION` are set; `X-Forwarded-For` and the peer header are never read then. Outside Vercel, `vercel` trusts no header (every client is `unknown`). Startup refuses, in production: an unknown value, `vercel` outside Vercel, `vercel` with `TRUSTED_PROXIES`, and `VERCEL=1` with the default `socket`. The peer-address preload is not required when `vercel` is in effect.
- **Demo rate limits** on register (10 per IP), login (20 per IP), TOTP and TOTP setup (20 per IP, 10 per user), per 60-second window, counted in the demo's database before any scrypt or TOTP work: `429 RATE_LIMITED` with `Retry-After`. The address is `x-real-ip` only on Vercel; elsewhere one shared bucket. No per-email limit on login, so nobody can lock another user out. `DEMO_RATE_LIMITS` overrides the defaults.
- **Postgres URLs** (vault and demo, `postgres-url.ts`): `sslmode=require|prefer|verify-ca` is spelled `verify-full` (same behavior in `pg`, without its `SECURITY WARNING`), and `channel_binding=require` becomes the pool's `enableChannelBinding` (`disable` and `prefer` are dropped). With `VERCEL=1` the vault refuses a non-local `DATABASE_URL` without `sslmode=require`, `verify-ca` or `verify-full`.

### Changed

- **Breaking:** the project is renamed **WL Embedded Wallet** (slug `wl-embedded-wallet`), built on Tether's Wallet Development Kit (WDK) and independent of Tether. The npm scope is now `@wl-embedded-wallet/*` (`core`, `sdk`, `recovery-tool`, `vault`, `demo`, `e2e`), and every domain-separation label starts with `wl-embedded-wallet/`: the envelope AAD, the share A and share B key derivation infos, the share B PRF input, the seed backup AAD, the app-to-vault protocol, and the relink purpose and EIP-712 domain. The popup window name, the Emergency Kit, seed and recovery tool file names, the Docker image (`wl-embedded-wallet-vault`) and the Compose project changed too. Envelopes, kits, seed backups and relink signatures made with the old labels no longer open or verify; no deployment existed, so there is no data to migrate. The test vectors in [docs/CRYPTO-SPEC.md](docs/CRYPTO-SPEC.md#22-test-vectors) and the published hashes of the offline recovery tool in [docs/REPRODUCIBLE-BUILDS.md](docs/REPRODUCIBLE-BUILDS.md) were recomputed.
- **Breaking for integrators:** the relink authorization labels are now `purpose: "wl-embedded-wallet/relink-wallet/v1"` and the EIP-712 domain `{ name: "wl-embedded-wallet/relink-wallet", version: "1" }`. Signatures made with the old labels no longer verify; a relink in flight during the upgrade (nonces live 5 minutes) must be restarted. The relink test vector in [docs/CRYPTO-SPEC.md](docs/CRYPTO-SPEC.md) changed accordingly.
- **Breaking for integrators:** `POST /api/aa/rpc` now admits only `vault_prepareDeployment`, `eth_sendUserOperation` and `eth_getUserOperationReceipt`, with exact parameter counts. `eth_estimateUserOperationGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `pm_getPaymasterStubData` and `pm_getPaymasterData` answer `403 METHOD_NOT_ALLOWED`, and `PAYMASTER_NOT_CONFIGURED` is no longer emitted. Only the vault's own pages call this route.
- **Breaking for integrators:** the SDK client is stricter. A missing `signature` or `userOperation` in a result is now `PROTOCOL_ERROR` (was `INTERNAL`). `getToken` returning anything but a non-empty string is `TOKEN_UNAVAILABLE`. An invalid `timeoutMs` throws `RangeError('INVALID_TIMEOUT')`.
- **Breaking for integrators:** most vault routes can answer `429 RATE_LIMITED`, and routes that read a body can answer `413 PAYLOAD_TOO_LARGE`. The `deploy` action can now fail with `FEES_TOO_HIGH`, `GAS_LIMIT_EXCEEDED`, `ALREADY_SPONSORED`, `DEPLOYMENT_IN_PROGRESS` or `RATE_LIMITED`.
- **Breaking for operators:** the image starts with `node --require ./peer-address.cjs server.js`, and with `NODE_ENV=production` the vault refuses to start without that preload. `pnpm start` and `pnpm dev` load it too. Behind a reverse proxy, set `TRUSTED_PROXIES`, or every client shares the proxy's rate-limit budget.
- **Breaking for operators:** migration `006-limits-and-audit` adds `rate_limits`, `share_a_releases`, `sponsored_deployments` and `share_sets.created_session_hash`. A set that was `pending` before the upgrade can no longer release share A, so that enrollment must be restarted.
- **Breaking for the demo:** an invalid `DEMO_CHAINS` is no longer treated as `[]`. It is validated (a JSON array; unique positive safe integer `chainId`; `name` of 1 to 64 characters; http(s) `rpcUrl`), and the pages and routes that need it answer `500 INTERNAL` without echoing the value.
- **Sponsored deployment fees** (`server/sponsorship.ts`): the vault also asks the bundler for `pimlico_getUserOperationGasPrice` (`standard` tier) and uses it as a floor; a bundler without it (method not found, an error, a malformed answer) leaves the node's values. The tip is now max(node tip, bundler tip) × `priorityFeeMultiplierPercent` / 100, and `maxFeePerGas` is max(gas price × `feeMultiplierPercent` / 100 + tip, bundler max fee × `priorityFeeMultiplierPercent` / 100), still clamped to the cap; any of these inputs above the cap is `FEES_TOO_HIGH`. Pimlico refuses sends below its own recent quotes, which on Sepolia are 4 to 7 orders of magnitude above the node's tip; on Polygon Amoy and Base Sepolia the node's tip equals Pimlico's floor, hence the margin. Fees are higher than before, the tip in particular; the caps are unchanged.
- The default `AA_MAX_VERIFICATION_GAS_LIMIT` is 3,000,000 (was 2,000,000): a Safe deployment on Ethereum Sepolia estimates about 1.83M, and the 20 % margin did not fit under 2M. The worst-case cost of a sponsored deployment rises accordingly.
- The deploy flow polls for the receipt for up to 180 seconds (every second for 30 polls, then every 3 seconds), instead of 60 × 1 s, for L1 testnets with slower inclusion.
- The deploy flow and the sign review show the chain's native currency symbol instead of a fixed `ETH`. The offline recovered-sign panel, which has no chain status, still shows `ETH`.
- **Demo database:** `DATABASE_URL` (`postgres://` or `postgresql://`) selects Postgres; unset or empty keeps SQLite at `DB_PATH` for local development, unit tests and e2e; any other value is an error, and so is `VERCEL=1` without a Postgres URL. The schema (`users`, `sessions`, `rate_limits`) is created on first use under an advisory lock. `DATABASE_POOL_SIZE` (1 to 200, default 5). The database functions are now asynchronous.
- With `VERCEL=1`, the Postgres pools of the vault and the demo default to 5 connections (the vault's default stays 10 elsewhere) and close idle connections after 5 seconds.
- `apps/vault/next.config.mjs`: `output: 'standalone'` except on Vercel, and with `VERCEL=1` at build time a relative `VAULT_BRAND_DIR` is traced into every function. The Docker image does not change.
- The root `package.json` pins `"packageManager": "pnpm@10.5.1"`; CI's `pnpm/action-setup` reads it instead of passing a version.
- `pnpm test:pg` runs the vault's Postgres suite and then the demo's (`pnpm test:pg:demo` alone), each against its own throwaway Postgres.
- `scripts/generate-secrets.mjs` explains on stderr that `VAULT_HANDOFF_*` are the names used by the SDK example, that any name works for your backend, and that the demo reads `DEMO_HANDOFF_PRIVATE_KEY` and `DEMO_HANDOFF_KID`.
- **Breaking for integrators:** bundler and paymaster rejections of a deployment now map to a code the user can act on, as for transactions (`upstreamErrorCode` in `lib/aa-client.ts`): `AA21` is `INSUFFICIENT_FUNDS`, `AA25` or an invalid nonce is `NONCE_CONFLICT`, `AA3x` or a paymaster, sponsorship or policy message (for example Pimlico's "sponsorship policy … is not active") is `SPONSORSHIP_REJECTED`; other `AAxx` errors stay `DEPLOY_FAILED`. Before, all of them were `DEPLOY_FAILED`.
- The `INSUFFICIENT_FUNDS`, `FEES_TOO_HIGH` and `GAS_LIMIT_EXCEEDED` texts in the vault no longer mention the deployment, since transactions use them too.
- **Demo:** the wallet page's signing panels are a WAI-ARIA tab group (`app/_components/tabs.tsx`): Message (EIP-191), Typed data (EIP-712) and Transaction. The Transaction tab replaces the UserOperation signing panel; `signUserOperation` itself is unchanged in the SDK.
- Migration `007-prepared-transactions` adds the `prepared_transactions` table (SQLite and Postgres) at startup. It changes no existing table.

### Added

- Vault environment variables, all optional, with defaults: `TRUSTED_PROXIES`, `RATE_LIMITS`, `SHARE_A_WINDOW_SECONDS`, `SHARE_A_MAX_PER_SESSION`, `SHARE_A_MAX_PER_USER`, `RECOVERY_CHALLENGE_MAX_LIVE`, `AA_MAX_VERIFICATION_GAS_LIMIT`, `AA_MAX_CALL_GAS_LIMIT`, `AA_MAX_PRE_VERIFICATION_GAS`, `AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT`, `AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT`, `AA_MAX_FEE_PER_GAS`, `AA_FEE_MULTIPLIER_PERCENT`, `AA_DEPLOYMENT_RETRY_SECONDS`. Invalid values stop the vault in production. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#environment-variables).
- `AA_CHAINS["<chainId>"].limits`, which overrides the sponsorship caps per chain (recommended on L2s).
- Vault variables `CLIENT_IP_SOURCE` (`socket` or `vercel`) and `AA_PRIORITY_FEE_MULTIPLIER_PERCENT` (100 to 1000, default 120; also `priorityFeeMultiplierPercent` in `AA_CHAINS[].limits`).
- `AA_CHAINS["<chainId>"].nativeCurrency` (`^[A-Za-z0-9._-]{1,11}$`), with built-in symbols for the known chains (`POL` on 137 and 80002, `ETH` on the others), else `ETH`. `ChainStatus`, and so `GET /api/aa/status`, gains `nativeCurrency`. Base Sepolia (84532) is a known chain.
- Demo variables `DATABASE_URL`, `DATABASE_POOL_SIZE` and `DEMO_RATE_LIMITS`; optional `explorerUrl` (http(s), no credentials, query or fragment) and `nativeCurrency` in each `DEMO_CHAINS` entry, shown in the browser (never `rpcUrl`).
- Vercel support: `apps/vault/vercel.json` and `examples/demo/vercel.json` (only `main` deploys, no previews), a root `.vercelignore` for CLI deploys, and `maxDuration` on the routes that call upstream services (60 s in the vault, 30 s in the demo). Guide and ready-to-paste values for Ethereum Sepolia, Polygon Amoy and Base Sepolia with Pimlico: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#deploy-to-vercel-and-neon).
- Error codes:
  - `RATE_LIMITED` (429), `PAYLOAD_TOO_LARGE` (413) and `INVALID_SUB` (400);
  - on `/api/aa/rpc`: `FEES_TOO_HIGH`, `GAS_LIMIT_EXCEEDED`, `ALREADY_SPONSORED`, `DEPLOYMENT_IN_PROGRESS`, `DEPLOYMENT_NOT_PREPARED` (409) and `UPSTREAM_INVALID` (502).
- SDK additions:
  - the `timeoutMs` option of `createVaultClient`, counted from opening the popup; on expiry it rejects with `TIMEOUT` and closes the popup;
  - an optional `close` on `VaultPopup`;
  - `VaultErrorCode` values `TIMEOUT`, `PROTOCOL_ERROR` and `INTERNAL`.
- **Sending transactions** from the deployed Safe:
  - SDK: `sendTransaction({ chain, to, value?, data? })` resolves to `{ address, owner, chainId, userOpHash, transactionHash }` once the UserOperation is included and its call succeeded. A malformed request rejects with `INVALID_REQUEST` (new `VaultErrorCode` value) before the popup opens. `signUserOperation` still only signs;
  - protocol: the `transaction` action (`{ kind: 'transaction', chain: { chainId }, transaction: { to, value, data? } }`) and the `/transaction` popup route. The result carries `chainId`, `userOpHash` and `transactionHash`. New codes from the popup: `CALL_NOT_ALLOWED`, `CALL_REVERTED`, `SPONSORSHIP_REJECTED`, `NONCE_CONFLICT`, `TRANSACTION_FAILED`, `TRANSACTION_REVERTED`, `TRANSACTION_TIMEOUT`, `TRANSACTION_EXPIRED` and `TRANSACTION_IN_PROGRESS`;
  - `POST /api/aa/rpc` gains `vault_prepareTransaction` (`[{ to, value, data? }]`, `value` in decimal wei). The server takes the nonce from the EntryPoint, encodes one CALL through `executeUserOpWithErrorString` (no delegatecall, no batches), sets fees and gas exactly as for deployments and within the same caps, adds paymaster fields only where the chain sponsors transactions, and records the operation in `prepared_transactions`. It refuses an undeployed Safe (`409 NOT_DEPLOYED`), a call with data to the Safe itself (`403 CALL_NOT_ALLOWED`) and a Safe whose balance does not cover `value` (plus the maximum fee when not sponsored) (`409 INSUFFICIENT_FUNDS`), before calling the paymaster or the bundler;
  - `eth_sendUserOperation` without `factory` forwards only an operation prepared for this Safe, found by its hash, signed by the owner and prepared less than 10 minutes before (`409 TRANSACTION_EXPIRED`), once (`409 TRANSACTION_IN_PROGRESS` while another request sends it; a resend gets the same hash). `eth_getUserOperationReceipt` also answers for the sent transactions of the session's Safe;
  - the worker op `send-transaction` checks that the operation executes exactly the reviewed call from this Safe, and refuses a call with data to the Safe itself and an undeployed Safe, before using the seed;
  - the review screen shows the requesting origin, the network, the Safe, the recipient, the amount in the chain's native currency, the calldata, an ERC-20 `transfer` or `approve` decoded when the data matches (with a caution for `approve` and for data it cannot decode), and "Sponsored" or the maximum network fee. It waits up to 3 minutes for the receipt;
  - demo: a Transaction tab (recipient, amount in native units, optional data) that shows whether the fee is sponsored and links the transaction hash to the chain's explorer.
- `AA_CHAINS["<chainId>"].sponsorTransactions` (boolean, default `false`; `true` requires `paymasterUrl`): the paymaster also sponsors transactions on that chain, not only the deployment. Arbitrary calls can drain the paymaster: see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and set spend limits in the paymaster's policy. `ChainStatus` (`GET /api/aa/status`), the s2s account response and `VaultServiceAccount` gain `transactionsSponsored`.
- Rate-limit scope `transaction` (30 per IP and 10 per `sub` per 60 s by default, configurable in `RATE_LIMITS`), on `vault_prepareTransaction`, on top of `aa`.
- Tests: `apps/vault/tests/unit/transactions.test.ts`, `packages/core/tests/transaction.test.ts`, SDK client and store contract tests, real-contract cases in `pnpm test:aa` (sponsored call, unsponsored value transfer, insufficient funds, reverting call, undeployed Safe), and `e2e/tests/q-transaction.spec.ts`. `apps/vault/tests/aa-stack` takes `sponsorTransactions` per chain; in `pnpm aa:stack`, chain 31001 sponsors transactions. No transaction has been sent through real providers yet ([docs/TEST-STATUS.md](docs/TEST-STATUS.md)).
- `packages/core/tests/crypto-spec-vectors.test.ts`, which checks the test vectors in [docs/CRYPTO-SPEC.md](docs/CRYPTO-SPEC.md) against the code. New vault, SDK, demo and e2e tests cover every fix ([docs/TESTING.md](docs/TESTING.md)).

### Fixed

- A `429` from the vault reaches the user and the app as `RATE_LIMITED` (new member of the core `WalletErrorCode`) from every vault call, including token redemption, share A, enrollment, kit-free recovery and relink; before, these became `INTERNAL`.
- `/relink` and `/export` send terminal errors to the app instead of leaving it waiting until the popup is closed. On `/relink`, wrong kit or code input stays retryable, and after a terminal error the popup offers only "back to app". On `/export`, the app gets `NO_WALLET` or the load error.
- SDK:
  - a `postMessage` or `window.open` that throws rejects with `INTERNAL`;
  - a failing `getToken` for an outdated `ready` is ignored;
  - `createVaultServiceClient` strips trailing slashes from `vaultOrigin`.
- Demo: the wallet panel says "Deployment status on this chain is unknown." when the vault could not check the chain.
- Removed dead code in the vault's export and sign flows, with no change in behavior.

## 0.1.0 (initial release)

Initial release, prepared for an external security audit. Not audited and not ready to hold real funds ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)).

### Added

- **Cryptographic core** (`@wl-embedded-wallet/core`): 2-of-3 Shamir split of a 12-word BIP-39 seed with `@tetherto/wdk-utils` `1.0.0-beta.16`; share A sealed by the server (HKDF-SHA256 from `MASTER_KEY`, AES-256-GCM), share B under the passkey's WebAuthn PRF output (HKDF-SHA256, AES-256-GCM), share C under a 128-bit recovery code (Argon2id, AES-256-GCM); Ed25519-signed manifest with per-share SHA-256 digests; strict, fixed-order verification before the seed is used; reconstruction only in a dedicated Web Worker, one per operation.
- **Emergency Kit** with the encrypted shares B and C, the signed manifest and a seed backup encrypted with the recovery code: kit plus code recover the seed offline.
- **Safe 4337 account** (modules 0.3.0, EntryPoint v0.7) with the same address on every EVM chain; sponsored deployment through a restricted bundler and paymaster proxy; Safe message (ERC-1271), EIP-712 and UserOperation signatures, only on chains where the Safe is deployed.
- **Vault service** (`apps/vault`): popup UI for activate, deploy, sign, unlock, recover, export and relink; HTTP API; SQLite and Postgres stores with versioned migrations; nonce-based CSP and Trusted Types; runtime configuration; Docker image and Compose file with an optional Caddy TLS profile.
- **Recovery paths:** A+B, A+C with re-enrollment, B+C without the server, kit plus code, kit-free recovery with a discoverable passkey plus code, relinking a wallet to a new app account with an owner signature, and kit upgrade for older kits.
- **Offline recovery tool:** a single self-contained HTML file and a Node CLI, with no network access, built reproducibly with a published SHA-256 ([docs/REPRODUCIBLE-BUILDS.md](docs/REPRODUCIBLE-BUILDS.md)), and a static recovery page builder for hosting without a backend.
- **SDK** (`@wl-embedded-wallet/sdk`): `/client` (`createVaultClient`), `/server` (handoff tokens with EdDSA, ES256 or RS256, JWKS helpers, server-to-server client, signature verification helpers) and `/protocol`.
- **Multi-app support:** several apps sharing one login issuer and one wallet per user, authorized by a signed `origin` claim and an optional `ALLOWED_APP_ORIGINS` allowlist.
- **Per-deployment branding** through a runtime-mounted `brand.json`, validated at startup; neutral default brand and the fictional "Acme Wallet" example in `brands/example`.
- **Sample integrator app** (`examples/demo`) using only the public SDK, with TOTP 2FA.
- **Test suites:** unit tests per package, Postgres store tests, real Safe and EntryPoint contracts on anvil, Playwright end-to-end suites (also against Postgres and against the real Docker image).
- **Documentation** for architecture, cryptography, protocol, HTTP API, threat model, audit scope, recovery, integration, deployment, branding and testing.

### Formats

All wire and storage formats introduced in this release are versioned:

| Format | Version or label |
|---|---|
| Envelope | `v: 1`, AAD `wl-embedded-wallet/envelope/v1\|{userId}\|{setId}\|{share}` |
| Share A key derivation | `wl-embedded-wallet/share-a/kms/v1\|{userId}\|{setId}` |
| Share B PRF input | `SHA-256("wl-embedded-wallet/share-b/prf/v1")` |
| Share B key derivation | `wl-embedded-wallet/share-b/aes/v1\|{userId}\|{setId}` |
| Seed backup | `v: 1`, AAD `wl-embedded-wallet/seed-backup/v1\|{owner}` |
| Manifest | `v: 1`, `format: "bip39-en/wdk-utils-hex"` |
| Emergency Kit | `v: 2` (with seed backup); `v: 1` (without) is still read |
| Relink authorization | EIP-712, domain `wl-embedded-wallet/relink-wallet` version `1`, purpose `wl-embedded-wallet/relink-wallet/v1` (changed before the audit; see [Unreleased](#unreleased)) |
| App-to-vault protocol | `wl-embedded-wallet/protocol/v1` |

See [docs/CRYPTO-SPEC.md](docs/CRYPTO-SPEC.md) for the complete specification.

