# Testing

How to run each test suite of WL Embedded Wallet 0.1.0 and what each one covers. For an honest summary of
what is **not** covered, read [TEST-STATUS.md](TEST-STATUS.md).

All commands run from the repository root. Test counts below are approximate: they are the number of test cases
reported by Vitest at the time of writing (parameterized cases expanded), or the number of `test(...)`
declarations for Playwright, and will drift as tests are added.

## Contents

- [Prerequisites](#prerequisites)
- [Summary](#summary)
- [`pnpm typecheck`](#pnpm-typecheck)
- [`pnpm test`: unit tests](#pnpm-test-unit-tests)
- [`pnpm test:pg`: Postgres](#pnpm-testpg-postgres)
- [`pnpm test:aa`: real contracts on anvil](#pnpm-testaa-real-contracts-on-anvil)
- [`pnpm aa:stack`: local chains for development](#pnpm-aastack-local-chains-for-development)
- [`pnpm test:e2e`: end to end](#pnpm-teste2e-end-to-end)
- [`pnpm test:e2e:pg`](#pnpm-teste2epg)
- [`pnpm test:e2e:image`: the real Docker image](#pnpm-teste2eimage-the-real-docker-image)
- [Ports](#ports)
- [Tests that depend on documentation](#tests-that-depend-on-documentation)
- [Test-only components](#test-only-components)

## Prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| Node.js >= 22.13 | Everything | `engines.node` in the root `package.json`. The vault's SQLite driver is `node:sqlite`. |
| pnpm 10 | Everything | Pinned by `"packageManager": "pnpm@10.5.1"` in the root `package.json`, which CI's `pnpm/action-setup` reads. The lockfile is `lockfileVersion: '9.0'`. `.npmrc` sets `save-exact=true`. Install with `pnpm install --frozen-lockfile`. |
| Foundry `anvil` | `test:aa`, `aa:stack`, all `test:e2e*` | Must be on `PATH`; the AA stack spawns `anvil` directly. |
| Docker with Compose v2 | `test:pg`, `test:pg:demo`, `test:e2e:pg`, `test:e2e:image` | `test:pg` pulls `postgres:17.6-alpine`. `test:e2e:image` builds the vault image and runs `docker compose`; it passes `--env-file /dev/null`, so it assumes a POSIX host. |
| Playwright Chromium | All `test:e2e*` | `pnpm --filter ./e2e exec playwright install chromium`. Playwright is pinned at 1.65.0. The suite runs Chromium only. |

The e2e suite uses `*.localhost` host names (`app.localhost`, `app2.localhost`, `vault.localhost`,
`recovery.vault.localhost`, `other.localhost`, `rpc.localhost`). Chromium resolves them internally; the test
process (Node) and Docker must resolve them too. If your system resolver does not, add them to `/etc/hosts`
pointing at `127.0.0.1`.

Development and testing have only been done on macOS on Apple silicon (arm64). Linux hosts are expected to work
(the setup has Linux-specific handling for the Docker host gateway), but that is not verified here.

## Summary

| Command | Runs | Needs | Approx. tests |
|---|---|---|---|
| `pnpm typecheck` | `tsc --noEmit` in every workspace package | Node | n/a |
| `pnpm test` | Vitest unit tests of `packages/core`, `packages/sdk`, `packages/recovery-tool`, `apps/vault`, `examples/demo` | Node | about 1350 tests (core 130, sdk 278, recovery-tool 14, vault 832, demo 96 with one skipped) |
| `pnpm test:pg` | Store contract and the vault route tests (API, AA proxy, transactions, body cap, share A, server-to-server, route limits, passkey recovery, relink), then the demo's database, API and rate-limit tests, each run against its own temporary Postgres. `pnpm test:pg:demo` runs only the demo part | Docker | about 385 vault tests plus about 80 demo tests |
| `pnpm test:aa` | Real Safe and EntryPoint contracts on anvil, without a browser | anvil | 15 |
| `pnpm aa:stack` | Not a test: keeps local chains running for `pnpm dev` | anvil | n/a |
| `pnpm test:e2e` | Playwright: production builds of the vault and demo, virtual passkeys, local chains | anvil, Chromium | about 79 tests |
| `pnpm test:e2e:pg` | The same e2e suite with the vault on Postgres | anvil, Chromium, Docker | about 79 tests (the same suite) |
| `pnpm test:e2e:image` | The e2e suite against the real Docker image with Postgres, plus image-specific tests | anvil, Chromium, Docker | about 89 tests (the 79 of the e2e suite plus 10 image tests) |

`pnpm build` (production builds of every package) is not a test suite, but the e2e suite performs its own
builds.

## `pnpm typecheck`

`pnpm -r --if-present run typecheck`: runs `tsc --noEmit` in `packages/core`, `packages/sdk`,
`packages/recovery-tool`, `apps/vault`, `examples/demo` and `e2e`. TypeScript is pinned at 5.9.3.

## `pnpm test`: unit tests

`pnpm -r --if-present run test`: runs each package's `test` script with Vitest 5.1.0. Nothing external is needed:
the vault uses SQLite in temporary directories, chains are faked with in-process RPC stubs, and WebAuthn is
exercised with a fake authenticator that does real cryptography. pnpm stops at the first package that fails; run
a single package with `pnpm --filter <path> test`.

### `packages/core` (about 130 tests)

Pure crypto and data formats shared by the vault, the worker and the offline tool. Config: Vitest defaults
(`tests/**/*.test.ts`).

| File | Covers |
|---|---|
| `tests/shamir.test.ts` | WDK Shamir 2-of-3: any pair recovers the seed, one share fails, shares from two splits do not mix |
| `tests/shamir-wrapper.test.ts` | `recoverMnemonic` and `verifyRecovery`: strict `true` from both verification callbacks, throwing callbacks, threshold checks |
| `tests/manifest.test.ts` | Canonical JSON, manifest signature (tampering, missing or foreign key), format checks, share digest, owner derivation, pinned wdk-utils version |
| `tests/recovery-code.test.ts` | Recovery code format (26 Crockford characters), normalization, two-group confirmation, share C envelope with Argon2id parameters read from the envelope |
| `tests/seed-backup.test.ts` | Seed backup encryption: AAD label and owner binding, tampering, wrong code, bounded Argon2id parameters, strict shape |
| `tests/kit.test.ts` | Kit versions: v2 carries the backup, v1 is still read, strict parsing |
| `tests/offline.test.ts` | Kit + code recovery: seed returned only when owner and Safe match; wrong code, tampered, foreign and old kits |
| `tests/sign-request.test.ts` | Parsing of message, EIP-712 and UserOperation sign requests; kit parsing without share A |
| `tests/transaction.test.ts` | One call from the deployed Safe: `buildTransactionOperation` (unsigned, `executeUserOpWithErrorString(to, value, data, 0)`, always a CALL); `isTransactionOperation` accepts the built operation (signed, with paymaster and gas filled in, in any address or hex case) and rejects another sender, a factory, the other module entry point and a MultiSend batch, even of the same call; `isAllowedTransactionCall` refuses a self-call with data and allows a plain self-transfer; `parseVaultCall` (decimal `value` up to 2^256 - 1, even-length hex `data` up to 128,000 characters, no extra keys) |
| `tests/crypto-spec-vectors.test.ts` | Every test vector of `docs/CRYPTO-SPEC.md` section 22 (PRF input and user handle, share A, B and C envelopes, recovery code, seed backup, Safe address, manifest signature, SafeMessage hash, relink typed data hash), with the values parsed from the document. See [Tests that depend on documentation](#tests-that-depend-on-documentation). |

### `packages/sdk` (about 278 tests)

The integrator SDK: `/client` (popup), `/server` (handoff tokens, JWKS, server-to-server client), `/protocol`.

| File | Covers |
|---|---|
| `tests/client.test.ts` | `createVaultClient`: popup opened synchronously with a fixed window name and no token in the URL, `ready`/`request`/`result` handshake to the exact origin, every operation kind, network passing, `sendTransaction` (opens `/transaction` with only the `chainId`, normalizes `value` to a decimal wei string and drops empty `data`, `INVALID_REQUEST` before opening the popup for a malformed call or chain, without superseding the pending operation; extra result fields dropped; vault codes such as `TRANSACTION_REVERTED` propagated), relink, export never returns the seed, listener cleanup; result validation per action (a malformed result rejects at once with `PROTOCOL_ERROR`); `timeoutMs` (`TIMEOUT`, closes the popup, invalid values refused with a `RangeError`); `INTERNAL` when `window.open` throws or the request cannot be posted; `TOKEN_UNAVAILABLE`; a failed token for an outdated `ready` is ignored |
| `tests/handoff.test.ts` | Handoff JWT: claims, verification with the published JWK by a standard library, wrong key/issuer/audience, no private material in the JWK, unique `jti`, refusal of invalid claims, interoperability with `jose` |
| `tests/server.test.ts` | EdDSA, ES256 and RS256 signers from PEM, generated or JWK keys; weak or mismatched keys; JWKS helpers refuse private material, and `jwksHandler` answers a clean 500 instead; server-to-server account client, trailing slashes removed from `vaultOrigin` |
| `tests/docs-example.test.ts` | The code examples in `packages/sdk/examples/` appear verbatim in `docs/INTEGRATION.md` and produce tokens that verify. See [Tests that depend on documentation](#tests-that-depend-on-documentation). |

### `packages/recovery-tool` (about 14 tests)

The `test` script first rebuilds `dist/` (`node scripts/build.mjs`), then runs Vitest.

| File | Covers |
|---|---|
| `tests/html.test.ts` | Single-file HTML: no external resources, strict CSP in a `<meta>` with exact hashes, no `fetch` in the output, Argon2 inlined, reproducible build (two runs, same bytes, matching `SHA256SUMS`), published hash in `docs/REPRODUCIBLE-BUILDS.md` |
| `tests/cli.test.ts` | Node CLI: checks owner and Safe, `--show-seed`, exit codes for wrong code and tampered kit, mismatch handling, old kits, refuses the code as an argument, no network use (`tests/no-network.mjs` is a detector that fails any network access) |
| `tests/messages.test.ts` | User-facing message for an old kit |

### `apps/vault` unit (about 832 tests)

Config: `apps/vault/vitest.config.ts`, `tests/unit/**/*.test.ts`, Node environment, 30 s timeout. API routes are
called in process (`tests/unit/route-harness.ts`). Several files run on SQLite by default and on Postgres when
`TEST_DATABASE_URL` is set (see `test:pg`).

| File | Covers |
|---|---|
| `api.test.ts` | API routes: handoff exchange and session cookie (`label` limits, a token refused for `CHAIN_REQUEST_MISMATCH` is not spent), server-to-server accounts, share set lifecycle (create, activate, revoke, fetch A), export audit, session network, network status and the bundler/paymaster proxy allowlist, Safe parameters in `POST /api/shares`, no secrets in logs, `/api/health` |
| `aa-rpc.test.ts` | Server-built sponsored deployment on `POST /api/aa/rpc` against fake bundler and paymaster servers (`fake-upstream.ts`): `vault_prepareDeployment` (network fees, the bundler's `pimlico_getUserOperationGasPrice` quote as a floor and the fallback without it, bundler estimate, paymaster stub and final data, fee and gas caps, paymaster and estimate shape checks, without a paymaster); `eth_sendUserOperation` only for the prepared operation with the owner's signature (any changed or extra field refused, idempotent resend, `ALREADY_SPONSORED`, retry window, concurrent sends forwarded once, release after an upstream or transport error); `eth_getUserOperationReceipt` only for the recorded hash; removed methods get `METHOD_NOT_ALLOWED`; another user's session; rate limits; the fee and gas rules |
| `transactions.test.ts` | Transactions from a deployed Safe on `POST /api/aa/rpc`, against fake bundler and paymaster servers: `vault_prepareTransaction` (nonce from the EntryPoint, network fees, bundler estimate with the margin, paymaster stub and final data only with `sponsorTransactions: true`, only a CALL, the same call prepared twice gives the same operation; gas, fee and paymaster gas caps and per-chain `limits`; `NOT_DEPLOYED`, `CALL_NOT_ALLOWED` for a self-call with data, `INSUFFICIENT_FUNDS` before any paymaster call, `INVALID_BODY` for malformed calls without going upstream; unsponsored, the balance must cover value plus prefund); `eth_sendUserOperation` without `factory` (exactly the prepared operation with the owner's signature, in decimal or hex and any address case, once; a delegatecall byte, dropped fields, an extra key, a wrong signature or an operation never prepared refused; idempotent resend, concurrent sends forwarded once, release after a bundler error, `TRANSACTION_EXPIRED` after `TRANSACTION_TTL_MS`); `eth_getUserOperationReceipt` only for a transaction this Safe sent on this chain; the `transaction` rate-limit scope per user and per IP; upstream errors (`UPSTREAM_ERROR` sanitized, paymaster policy rejections, `CHAIN_UNAVAILABLE`, `CHAIN_MISMATCH`); `upstreamErrorCode` for transactions and deployments; the page's `prepareTransaction` checks |
| `share-a.test.ts` | `GET /api/shares/a` of a pending set only to the session that created it and within a session lifetime (rotation in progress, sets created before migration 6, other users); the release audit record (none for a refused request, no release if it cannot be recorded); per-session and per-user budgets, spent before the lookup |
| `s2s.test.ts` | `GET /api/s2s/accounts/:sub` input: bearer checked first, `sub` format (`INVALID_SUB`), `chainId` a positive safe integer (`INVALID_CHAIN_ID`), no chain query for an unknown account; per-sub and per-IP limits, the same answers whether or not the account exists |
| `route-limits.test.ts` | `POST /api/auth/handoff` limits (per IP before verifying, per sub before the `jti` is spent); the shared enrollment budget of `POST /api/webauthn/challenge`, `POST` and `PATCH /api/shares`, per user and per IP |
| `vault-api.test.ts` | The vault page's API client: a `429` from any vault call becomes `RATE_LIMITED`, other failures stay `INTERNAL` |
| `body-limit.test.ts` | `readJson` 128 KiB cap (declared `Content-Length`, streamed body stopped early, exactly the cap and one byte more); `413` on routes; a `POST /api/shares` registration with every field at its validator limit is accepted |
| `rate-limit.test.ts` | `normalizeIp`; `clientIp` (with and without the preload, IPv4-mapped and IPv6 /64, `X-Forwarded-For` only from a trusted proxy, invalid `TRUSTED_PROXIES` trusts nobody; with `CLIENT_IP_SOURCE=vercel`, only `x-real-ip` on a Vercel runtime and no header outside one); the limiter per IP and per sub; `Retry-After` |
| `limits.test.ts` | `RATE_LIMITS` rules and defaults, share A and recovery challenge budgets, `sponsorshipLimits` (per chain, then the variable, then the default), `trustedProxies`, `clientIpSource` and its startup checks |
| `peer-address.test.ts` | The `scripts/peer-address.cjs` preload replaces any client copy of the peer header with the socket address; the startup refusal in production without it; on Vercel with `CLIENT_IP_SOURCE=vercel` it starts without the preload |
| `postgres-url.test.ts` | `normalizePostgresUrl`: `sslmode` aliases become `verify-full`, `channel_binding=require` becomes the pool option, the rest is kept verbatim, and an unparsable URL fails without echoing it |
| `proxy.test.ts` | Security headers of `proxy.ts`: HSTS only in production on an `https` `ORIGIN`, also on API responses from `json()`; the proxy does not run on `/api/` |
| `passkey-recovery.test.ts` | Passkey registration verification in `POST /api/shares` (`@simplewebauthn/server`), single-use challenges, `POST /api/recovery/passkey` (never returns A, uniform failure, counter) with a fake authenticator doing real crypto; challenge and assertion limits per IP, the cap on live challenges |
| `relink.test.ts` | Relinking a wallet to another account: owner EIP-712 signature, nonce reuse, expiry and ownership, session and origin checks, audit trail; nonce and relink limits per account and per IP |
| `handoff.test.ts` | Handoff token verification with a real local JWKS server: EdDSA/ES256/RS256, key rotation without restart, unknown and missing `kid`, download throttling, stale cache then fail-closed, private material rejection, claim checks (`label` length), a rejection does not use up the token |
| `server.test.ts` | KMS stub for share A (sealing, authenticated salt, wrong `MASTER_KEY`), handoff `jti` consumption |
| `config.test.ts` | `normalizeOrigin`, `validateConfig` for every environment variable (including the limit variables, all reported at once, `AA_CHAINS[].nativeCurrency`, `AA_CHAINS[].sponsorTransactions` (a boolean, `true` only with `paymasterUrl`), and a complete Vercel configuration with `sslmode` required there), exactly one of JWKS or fixed key, `publicRuntimeConfig` |
| `chains.test.ts` | Safe address equals WDK's; RPC provenance (HTTPS, plain HTTP only to local hosts in insecure local mode, credentials, host allowlist, configuration precedence); JSON-RPC client (no redirects, size cap, URL never in errors); `chainStatus` (factory must return the predicted address, missing bundler); `transactionsSponsored` only with a paymaster and `sponsorTransactions: true` |
| `envelope.test.ts` | Share envelopes A/B/C: AAD binding to user, set and slot, bit flips in `ct`/`iv`/`salt`, fresh IVs |
| `recovery.test.ts` | Enrollment logic, A+B, A+C and B+C recovery, every abort condition before combining (manifest signature, digest, tampered A, address, Safe, format, foreign set), zeroing of PRF and code, A+C re-enrollment |
| `seed-backup.test.ts` | Seed backup goes into the kit and never into the POST body; kit + code recovery; B+C operations without the server; relink signature; kit upgrade; worker transfer; `GET /recovery-tool` |
| `sign.test.ts` | Worker `sign` op (Safe message, EIP-712, UserOperation, nothing sent to the chain, seed rebuilt per signature, no secrets in the response, refusals), `deploy` op and `send-transaction` op (signs the reviewed call, a self-transfer without data allowed, PRF wiped; refuses another call, a batch, another sender or a factory, `CALL_NOT_ALLOWED` for a self-call with data, `WALLET_NOT_DEPLOYED`, `CHAIN_MISMATCH`, `MANIFEST_INVALID`) |
| `export.test.ts` | Worker `export` op: seed returned only after every check; PRF wiped |
| `prf.test.ts` | Passkey PRF: result at `create`, fallback to `get` when `create` only reports `enabled`, required options, per-set user handle, fixed salt, 32-byte output |
| `signer-client.test.ts` | Worker runner: transferables, single response, termination, errors mapped to `INTERNAL` |
| `recovery-tool.test.ts` | `fetchRecoveryTool` acceptance rules and that the route serves the reproducible build |
| `no-leak.test.ts` | No console output and no secrets in responses or errors across a full flow |
| `brand.test.ts` | `brand.json` validation, derived colors, stylesheet, file checks, name precedence, static recovery page build with a brand. See [BRANDING.md](BRANDING.md#tests). |
| `brand-route.test.ts` | `GET /brand/[file]` headers, lookup by hash only, read-once behavior |
| `scripts.test.ts` | `pnpm setup:env` writes consistent vault and demo environments without printing secrets or overwriting values |
| `store.sqlite.test.ts` | The shared store contract (`tests/store/contract.ts`) on SQLite, and file permissions 600 |

### `examples/demo` unit (about 96 tests)

Config: `examples/demo/vitest.config.ts`, `tests/unit/**/*.test.ts`.

| File | Covers |
|---|---|
| `tests/unit/api.test.ts` | Demo backend: registration and login, TOTP second factor (no token before it), TOTP replay (a code is accepted once per account, also from another session; concurrent use completes once), encrypted TOTP secret, public JWKS, handoff token minting, an invalid `DEMO_CHAINS` fails every route that reads it with `INTERNAL`, wallet lookup, signature verification (ERC-1271 for messages and EIP-712, owner recovery for UserOperations) |
| `tests/unit/chains.test.ts` | `DEMO_CHAINS` parsing: unset or empty means no chains, invalid values refused with an error that never includes them; optional `explorerUrl` and `nativeCurrency`; the browser view never carries `rpcUrl` |
| `tests/unit/db.test.ts` | The demo database on SQLite (on Postgres in `test:pg`): users, second factor and TOTP steps, sessions, rate-limit buckets, backend selection by `DATABASE_URL` (Postgres, SQLite, other values refused, required with `VERCEL=1`), URL normalization and `DATABASE_POOL_SIZE`, never echoing the URL |
| `tests/unit/rate-limit.test.ts` | Auth route limits: defaults and `DEMO_RATE_LIMITS`, the client address (`x-real-ip` only on Vercel, one bucket elsewhere, never `X-Forwarded-For`), `429` with `Retry-After` on register, login, TOTP and TOTP setup, per-user TOTP limits, a foreign origin rejected before it counts. One case runs only on Postgres |
| `tests/unit/messages.test.ts` | Deployment notice: an unknown state is shown as unknown, never as not deployed |
| `tests/unit/transaction.test.ts` | The Transaction tab's form: the amount converted from native units to wei, empty data dropped, invalid recipient, amount or data refused; every code the vault may return for a transaction has its own text |
| `tests/unit/setup-env.test.ts` | `pnpm setup:env` generates and preserves the demo TOTP key |

## `pnpm test:pg`: Postgres

```bash
pnpm test:pg        # the vault's suite, then the demo's
pnpm test:pg:demo   # the demo's suite only
```

`apps/vault/tests/pg/run.mjs` starts a throwaway `postgres:17.6-alpine` container (random name, random password,
data on `tmpfs`, published on `127.0.0.1` at a **random free port**), waits until `pg_isready` answers over TCP
(up to 120 attempts, 500 ms apart), sets `TEST_DATABASE_URL`, runs the command and always removes the container,
including on Ctrl-C. Without arguments it runs Vitest with `apps/vault/vitest.pg.config.ts`:

- `tests/pg/store.pg.test.ts`: the same store contract as SQLite (`tests/store/contract.ts`: users, sessions,
  `jti`, share sets, WebAuthn challenges, credentials, relink, rate limit buckets, share A releases, sponsored
  deployments, prepared transactions, migrations), including concurrency **across replicas** (several store instances on one database:
  single winner for a `jti`, an activation, a `setId`, a challenge, a counter step, a relink nonce, a sponsored
  deployment claim, a prepared transaction claim; a distinct count for each concurrent rate limit hit; the live challenge cap never exceeded;
  parallel migrations), plus opening Postgres by `DATABASE_URL` without leaking the password on failure. Between
  tests the schema is dropped and recreated.
- `tests/unit/api.test.ts`, `tests/unit/passkey-recovery.test.ts`, `tests/unit/relink.test.ts`,
  `tests/unit/aa-rpc.test.ts`, `tests/unit/transactions.test.ts`, `tests/unit/body-limit.test.ts`, `tests/unit/share-a.test.ts`,
  `tests/unit/s2s.test.ts`, `tests/unit/route-limits.test.ts`: the same files as in the unit suite, now backed by
  Postgres. These are the exact entries of `include` in `apps/vault/vitest.pg.config.ts`, besides
  `tests/pg/**/*.test.ts`.

Files run sequentially (`fileParallelism: false`) because they share one database. Timeout 60 s per test.

The demo's part (`pnpm --filter ./examples/demo test:pg`, also `pnpm test:pg:demo`) uses the same `run.mjs`, so it
gets its own throwaway container, and runs `examples/demo/vitest.pg.config.ts`: `tests/unit/db.test.ts`,
`tests/unit/api.test.ts` and `tests/unit/rate-limit.test.ts` with `DATABASE_URL` set to that database. That covers
the Postgres driver, the lazily created schema, TOTP replay and concurrent `consumeTotpStep` on Postgres, and the
database-backed rate limiter. Files run sequentially and the tables are emptied between tests.

## `pnpm test:aa`: real contracts on anvil

```bash
pnpm test:aa
```

Runs `apps/vault/tests/integration/aa-contracts.test.ts` with `apps/vault/vitest.integration.config.ts` (60 s
timeout, forked pool). It starts three anvil chains through `apps/vault/tests/aa-stack/stack.mjs` (chain IDs
31101, 31102 and 31103, on ports 38545-38547; see [Test-only components](#test-only-components)) and checks, with
no browser:

- the predicted Safe address equals WDK's (`@tetherto/wdk-wallet-evm-erc-4337`);
- the real factory returns exactly that address on both chains, and the vault reports them deployable;
- a chain without the factory is not supported; an RPC answering another `chainId` gives `CHAIN_MISMATCH`;
- the real EntryPoint rejects a tampered owner signature;
- deployment through the local bundler with the local paymaster on chain A at the predicted address, without
  touching chain B, then on chain B at the same address through the vault routes (prepared by the server with
  `vault_prepareDeployment`, sent once);
- ERC-1271: a Safe message signature is valid on its chain and not on the other;
- the real Safe accepts a self-funded UserOperation (no paymaster) signed for the deployed Safe;
- transactions through the vault routes (`vault_prepareTransaction`, then `eth_sendUserOperation`), with
  `sponsorTransactions` on chain B only: a sponsored 0-value call on B (the paymaster pays, the Safe's balance does
  not move, a resend returns the same hash without forwarding again); an unsponsored value transfer on A, paid by
  the Safe, with no paymaster call; `INSUFFICIENT_FUNDS` for a value the Safe cannot pay; a call that reverts is
  included with `success: false`; `NOT_DEPLOYED` for a Safe that is not deployed.

It uses the same ports as the e2e suite, so do not run `test:aa` and `test:e2e` at the same time.

## `pnpm aa:stack`: local chains for development

```bash
pnpm aa:stack
```

Not a test. `apps/vault/tests/aa-stack/run.mjs` keeps three local chains running for `pnpm dev` and prints the
matching `AA_CHAINS`, `RPC_ALLOWED_HOSTS` and `DEMO_CHAINS`. `pnpm setup:env` already writes these values. Chain
31001 also sponsors transactions (`"sponsorTransactions": true`); on 31002 the Safe pays for its own transactions.

| Chain ID | anvil RPC | Bundler | Paymaster |
|---|---|---|---|
| 31001 | 21545 | 22545 | 23545 |
| 31002 | 21546 | 22546 | 23546 |
| 31003 (no factory) | 21547 | none | none |

## `pnpm test:e2e`: end to end

```bash
pnpm --filter ./e2e exec playwright install chromium   # once
pnpm test:e2e
```

On a laptop, keep the machine awake for the whole run (on macOS, `caffeinate -dims pnpm test:e2e`). If the system sleeps, even briefly, the 20 s action timeouts expire mid-flow and many tests fail with timeouts that look like hangs.

Configuration: `e2e/playwright.config.ts`. Chromium only, one worker, no retries, `forbidOnly`, 180 s per test,
traces kept on failure. The HTML report goes to `e2e/playwright-report`, artifacts to `e2e/test-results`, and run
state to `e2e/.run`.

Global setup (`e2e/support/global-setup.ts`):

1. Kills leftovers from a previous run and fails if any [port](#ports) is busy.
2. Builds the offline recovery tool, then production builds of the vault and the demo into `.next-e2e` (so the
   development build and `.env.local` are not touched; `next-env.d.ts` and `tsconfig.json` are restored after the
   build).
3. Starts three anvil chains with the real contracts (chain IDs 31001, 31002, and 31003 without a factory), a local
   bundler and paymaster for the first two. Only 31001 sponsors transactions (`sponsorTransactions`).
4. Starts the vault standalone server (`node --require apps/vault/scripts/peer-address.cjs server.js`,
   `NODE_ENV=production`, so the strict CSP and Trusted Types apply) on 4301 with SQLite, the fictional example
   brand, deterministic test keys and `ALLOW_INSECURE_LOCAL=1`; two demo instances on 4300 and 4302 (two "apps"
   sharing one login); and a static server for the static recovery page on 4306.

The vault environment (`e2e/support/env.ts`) sets generous `RATE_LIMITS` for every scope, and the demo environment
generous `DEMO_RATE_LIMITS`: all browsers of the suite connect from `127.0.0.1` (and the demo, off Vercel, counts every
client as `unknown`), so the defaults would throttle the suite itself. The demo always runs on SQLite in e2e
(`DATABASE_URL` is set empty). No e2e test reaches a rate limit; the
limits are covered by the unit and Postgres suites only.

Each test gets a CDP **virtual WebAuthn authenticator** (`e2e/support/harness.ts`): CTAP 2.1, internal transport,
resident keys, user verification, `hasPrf: true`, automatic presence. Every test also registers the secrets it
sees (recovery codes, seeds, shares) and fails if any of them appears in the page, worker or server console
output. The demo accepts each TOTP step once per account, so the harness uses the next step's code for a second
sign-in within the same 30 s.

| File | Covers |
|---|---|
| `tests/a-account.spec.ts` | Demo sign-up with a TOTP QR read from the screen, full activation, the same Safe on sign-in, different users get different Safes, wrong password and duplicate email |
| `tests/b-deploy-sign.spec.ts` | Signing blocked until deployed, sponsored deployment, message/EIP-712/UserOperation signatures verified by the demo, rejection returns `USER_REJECTED`, rejected deployment deploys nothing. After the deployment, from the popup: resending the same operation returns the same hash, a changed fee gets `ALREADY_SPONSORED`, `vault_prepareDeployment` gets `ALREADY_DEPLOYED`, and `pm_getPaymasterData` and `eth_gasPrice` get `403` |
| `tests/c-multichain.spec.ts` | Same Safe on two chains with independent deployment and signing; invalid chains rejected without showing another address |
| `tests/d-flows.spec.ts` | Unlock with A+B; lost device A+C with re-enrollment, same Safe and the previous set revoked; the old passkey cannot open the new set; B+C without the server (no `/api` call, no session), also from the app's popup |
| `tests/e-tampering.spec.ts` | Tampered or foreign kit, tampered server data for A+C: abort before reconstruction, no address returned |
| `tests/f-export.spec.ts` | Seed export: optional, confirmation and passkey required, seed only in the downloaded file; from the app only addresses are returned and the export is recorded; without a wallet, the app receives `NO_WALLET` instead of waiting for the popup to close |
| `tests/g-isolation.spec.ts` | A compromised app: XSS cannot reach the vault DOM, shares or passkey; cookie flags and origin checks; what a compromised app can do (request a signature the user reviews); the browser cannot choose the RPC; injected scripts blocked while Worker and WASM work; handoff token single use, expiry and signature; the accepted stolen-live-token risk; a pending set: only the session that created it gets share A, for the drill; no token without TOTP; cross-user access; public JWKS; server-to-server auth |
| `tests/h-leaks.spec.ts` | The console secret detector works for page and worker; full sign-up, signing and recovery with no secret in any console; this Chromium supports `hasPrf` |
| `tests/i-deployment.spec.ts` | `/api/health`; the HTML carries only public configuration; production refuses to start with a missing or invalid variable (naming it, without its value), with an unreachable database, or with an invalid brand; the same build started with another RP ID, key and brand, without rebuilding |
| `tests/k-multi-app.spec.ts` | Two apps on different origins with one login share the Safe and the passkey; a token from app 1 sent from app 2 gets `ORIGIN_MISMATCH`; a third-party page gets no session, review or result, and cannot intercept results; a session bound to one origin cannot be used from another |
| `tests/l-kit-tool.spec.ts` | The seed backup and the plaintext seed never leave the browser (all traffic intercepted); worst case with no backend or network: kit and code recover the seed from `file://` and with the CLI; the tool's CSP blocks outbound traffic; wrong code, tampered, foreign and old kits; kit + code in the vault without a passkey; kit upgrade with A+B and B+C; after rotation the old kit still opens with the old code (documented limit); the tool is offered before the kit |
| `tests/m-bc-operational.spec.ts` | B+C in the vault without the API (sign and export); the static recovery page with the backend down on the RP ID host; the RP ID boundary (a subdomain works, another domain does not); re-enrollment from a kit with a session; a foreign kit does not re-enroll |
| `tests/n-passkey-recovery.spec.ts` | Recovery without a kit using one discoverable assertion (no JWT, never share A, no session, PRF output never leaves the browser); wrong code and reused challenge; wallets enrolled without a public key; unknown passkey gets the generic response |
| `tests/o-relink.spec.ts` | Relinking a wallet to a new account with kit and code, with B+C, and with passkey and code only; an account with a wallet cannot take another; a failed relink reaches the app with its code, the popup only offers to go back, and the app can retry; a valid token without the owner signature cannot relink |
| `tests/p-tool-required.spec.ts` | The kit cannot be downloaded before the recovery tool, at enrollment, rotation and kit upgrade, including when fetching the tool fails; the static page cannot fetch the tool and offers no kit |
| `tests/q-transaction.spec.ts` | Sending a transaction from the demo's Transaction tab: a sponsored 0-value call on 31001 reviewed in the vault (Safe, recipient, amount, no data, chain, "Sponsored"), sent on-chain and the hashes shown in the app and the popup, the paymaster's deposit spent and the Safe's balance unchanged, the result kept per tab; an unsponsored value transfer on 31002 with its maximum fee shown, paid by the Safe; an ERC-20 `transfer` decoded in the review; rejection (`USER_REJECTED`), not deployed (`WALLET_NOT_DEPLOYED`), a self-call with data (`CALL_NOT_ALLOWED`, never prepared), no funds (`INSUFFICIENT_FUNDS`), and a reverting call (the data caution shown, `TRANSACTION_REVERTED` to the app, the hashes in the popup) |

## `pnpm test:e2e:pg`

```bash
pnpm test:e2e:pg
```

Runs `apps/vault/tests/pg/run.mjs pnpm -w test:e2e`: the same temporary Postgres as `test:pg`, then the whole e2e
suite with the vault's `DATABASE_URL` pointing at it (`TEST_DATABASE_URL`, read by `e2e/support/env.ts`). The demo
still uses SQLite.

## `pnpm test:e2e:image`: the real Docker image

```bash
pnpm test:e2e:image
```

Sets `E2E_VAULT_IMAGE=1`. The global setup builds `apps/vault/Dockerfile` as `wl-embedded-wallet-vault:local`
and starts it with `compose.yaml` plus `e2e/compose.image.yaml` (project `wl-embedded-wallet-e2e`), which adds the
host alias `rpc.localhost` (Docker `host-gateway`, used to reach the anvil chains and the demo JWKS on the host)
and mounts `brands/example` read-only at `/brand`. The vault runs read-only, as non-root, with all capabilities
dropped and `no-new-privileges`, against the compose Postgres (17.6, pinned by digest), published on
`127.0.0.1:4301`. In this mode the chains are reached through `AA_CHAINS` `rpcUrl` values rather than the RPC in
the token, because the token path cannot reach host networks from inside the container; that path stays covered
by `pnpm test:e2e`.

All of `e2e/tests/` runs against the container. In addition, `e2e/tests-image/image.spec.ts` (about 10 tests):

| Group | Covers |
|---|---|
| Image contents | No keys, `.env` or foreign code (for example the demo) in the image, its layers or history; runs as non-root on the local architecture; `generate-secrets.mjs` produces a valid environment and keeps the handoff private key separate; `compose.yaml` with `.env.example` requires the secrets and validates with them, Caddy profile included |
| Container | The security restrictions are applied and effective; the server-to-server `curl` from `docs/INTEGRATION.md` works; a missing required variable exits and is not reported healthy; Postgres down makes the container unhealthy and it recovers; after restarting Postgres and recreating the vault, the user keeps the wallet and signs |
| Multiple replicas | A wallet created and deployed on one replica signs on another (port 4304); with a different `MASTER_KEY` share A is not delivered, the failure is clear, and the correct key keeps working |

The e2e test `l-kit-tool.spec.ts` also checks, in this mode, that the recovery tool served by the image (built on
Linux inside Docker) has the same SHA-256 as the host build in `packages/recovery-tool/dist/SHA256SUMS`.

## Ports

All e2e modes need these ports free on `127.0.0.1` (listed in `PORTS` in `e2e/support/env.ts`; the setup aborts
if any is busy):

| Port | Use |
|---|---|
| 4300 | Demo app 1 (`http://app.localhost:4300`), also serves the JWKS |
| 4301 | Vault (`http://vault.localhost:4301`); in image mode, the compose container |
| 4302 | Demo app 2 (`http://app2.localhost:4302`) |
| 4303 | Second vault instance in `i-deployment.spec.ts` (other RP ID, key and brand) |
| 4304 | Replica container in `image.spec.ts` |
| 4305 | Containers with a deliberately bad configuration in `image.spec.ts` |
| 4306 | Static recovery page server (`vault.localhost`, `recovery.vault.localhost`, `other.localhost`) |
| 38545, 38546, 38547 | anvil RPC for chains 31001, 31002, 31003 |
| 39545, 39546 | Local bundlers for chains 31001 and 31002 (RPC port + 1000) |
| 40545, 40546 | Local paymasters for chains 31001 and 31002 (RPC port + 2000) |

Chain 31003 has no contracts, so it has no bundler or paymaster: ports 39547 and 40547 are not used. `test:aa` uses
38545-38547, 39545-39546 and 40545-40546 too. `pnpm aa:stack` uses different ports (21545-21547 and up), so it can
run alongside the e2e suite; the e2e suite also uses ports distinct from the development servers (3200 and 3201).

## Tests that depend on documentation

Some tests read documentation files, so editing those documents can break them:

| Test | Requires |
|---|---|
| `packages/sdk/tests/docs-example.test.ts` | `docs/INTEGRATION.md` contains `packages/sdk/examples/mint-token.ts` and `mint-token-jose.ts` verbatim |
| `packages/recovery-tool/tests/html.test.ts` | `docs/REPRODUCIBLE-BUILDS.md` contains the SHA-256 line of the current `wl-embedded-wallet-recovery.html` build, as written in `dist/SHA256SUMS` |
| `packages/core/tests/crypto-spec-vectors.test.ts` | `docs/CRYPTO-SPEC.md` section 22 keeps its vector values and their formatting (labels such as `iv`, `AAD` and `ct`, quoted and repeated values), because the test parses them from the document. It also reads the share A `info` template from `apps/vault/server/kms.ts` |
| `e2e/tests-image/image.spec.ts` | `docs/INTEGRATION.md` contains the server-to-server `curl` example |

## Test-only components

- **`apps/vault/tests/aa-stack/`**: `stack.mjs` starts `anvil` chains, installs the real bytecode of the
  EntryPoint v0.7, SenderCreator, Safe proxy factory, Safe L2 singleton, Safe 4337 module, Safe module setup and
  MultiSend with `anvil_setCode` (from `fixtures/contracts.json`), deploys a test verifying paymaster
  (`contracts/TestVerifyingPaymaster.sol`, compiled artifact in `fixtures/`) with a 10 ETH EntryPoint deposit, and
  serves a minimal JSON-RPC bundler and an ERC-7677 paymaster that call `EntryPoint.handleOps` for real. Each
  chain can opt into `sponsorTransactions`, which `aaChainsConfig` writes into `AA_CHAINS`. The
  bundler does **not** estimate gas: `eth_estimateUserOperationGas` returns fixed limits. All keys there are the
  well-known public anvil keys.
- **`apps/vault/tests/aa-stack/fetch-contracts.mjs`**: run by hand, once, to copy the contract bytecode from
  Sepolia (read-only `eth_getCode`). It is the only script that touches a public network, and no test runs it.
- **`apps/vault/tests/unit/fake-authenticator.ts`** and **`fake-rpc.ts`**: an in-process WebAuthn authenticator with
  real signatures, and an RPC stub, for unit tests.
- **`apps/vault/tests/unit/fake-upstream.ts`**: a fake bundler or paymaster over local HTTP with per-method handlers
  and a record of the calls, for `aa-rpc.test.ts` and `transactions.test.ts`. It is not a real provider: the sponsorship caps and their
  defaults are not tested against real bundlers, paymasters or L2s.
- **`apps/vault/tests/store/contract.ts`**: the store contract shared by the SQLite and Postgres runs.
- **`e2e/support/`**: harness (virtual authenticator, secret detector, popup helpers), environment and
  deterministic test keys, image helpers, a second test brand.

All keys used by the tests are derived deterministically from labels (`e2e/support/env.ts`) or generated per run.
None is a production key.

## Related documents

[TEST-STATUS.md](TEST-STATUS.md), [AUDIT-SCOPE.md](AUDIT-SCOPE.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[DEPLOYMENT.md](DEPLOYMENT.md), [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md), [BRANDING.md](BRANDING.md).
