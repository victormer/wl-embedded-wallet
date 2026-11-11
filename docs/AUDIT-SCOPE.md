# Proposed audit scope

This document proposes the scope of a security audit of WL Embedded Wallet 0.1.0 with the unreleased pre-audit fixes ([CHANGELOG.md](../CHANGELOG.md#unreleased)): what to review, in which order, the third-party code the design relies on, and what is out of scope. Line counts are approximate (`wc -l`) and are given only to size the work.

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the components, [CRYPTO-SPEC.md](CRYPTO-SPEC.md) for the formats, and [THREAT-MODEL.md](THREAT-MODEL.md) for the goals, the accepted risks and the [weaknesses already noted](THREAT-MODEL.md#known-weaknesses-noted-for-the-audit). The interfaces are in [PROTOCOL.md](PROTOCOL.md) and [HTTP-API.md](HTTP-API.md). How to run every test suite: [TESTING.md](TESTING.md); what is not tested: [TEST-STATUS.md](TEST-STATUS.md).

## Questions the audit should answer

1. Can any party other than the user obtain the seed, or any two shares, outside the combinations listed in [THREAT-MODEL.md](THREAT-MODEL.md#what-each-factor-combination-yields)?
2. Is every piece of server or kit data authenticated before the seed is used, in every worker operation, and is the verification order in [CRYPTO-SPEC.md](CRYPTO-SPEC.md#14-reconstruction-and-verification-order) sufficient?
3. Are the cryptographic constructions (AES-256-GCM with HKDF or Argon2id, PRF salt, AADs, Ed25519 manifest, Shamir via wdk-utils) used correctly, with adequate parameters and domain separation?
4. Can code on the integrator origin, or a different integrator, obtain anything beyond addresses and signatures the user approved?
5. Can a handoff token, a session, or a relink be abused beyond the accepted risks?
6. Can the paymaster sponsorship be spent on anything other than deploying a user's own Safe, or beyond the configured caps and once per Safe and chain?
7. Do the rate limits, the body cap and the share A release budgets hold, across replicas, behind a proxy and on Vercel, and can a client choose the address it is counted under?
8. Is the offline tool genuinely network-free and reproducible, and does it recover correctly?
9. Do the CSP, Trusted Types and response headers hold on the vault, the static recovery page and the offline tool?

## Priority 1: cryptographic core (`packages/core/src`)

Pure TypeScript, no network, no storage, no UI. Every format and every decision about key material is here. In suggested review order:

| File | Lines | What to look at |
|---|---|---|
| `signer.ts` | ~380 | The worker request handler: every operation (`enroll`, `recover`, `sign`, `deploy`, `export`, `sign-recovered`, `export-recovered`, `sign-relink`, `upgrade-kit`), verification order, what each response may carry (only `export` and `export-recovered` return the mnemonic), buffer wiping, error mapping |
| `envelope.ts` | ~125 | AAD construction, expected-slot rule, salt and IV sizes, HKDF for share B, error uniformity |
| `recovery-code.ts` | ~150 | Code generation (128 bits, Crockford base32), normalization, Argon2id derivation, parameter bounds from untrusted envelopes |
| `seed-backup.ts` | ~70 | Separate label, owner-bound AAD, strict shape, seal-then-reopen |
| `manifest.ts` | ~115 | Canonical JSON, Ed25519 sign and verify (`zip215: false`), format and Safe recomputation checks, digests, address comparison |
| `shamir.ts` | ~70 | `verifyRecovery` and `recoverMnemonic` wrappers around wdk-utils; authentication of every share before combining |
| `kit.ts`, `schema.ts` | ~60, ~50 | Kit `v: 1` and `v: 2` parse rules, shape checks and their limits |
| `safe.ts` | ~285 | Safe parameters, address prediction, deployment operation and `isDeploymentOperation`, `userOperationMatches`, SafeOp and SafeMessage hashing and signer recovery |
| `sign-request.ts` | ~115 | Validation of untrusted signing requests from the app: sizes, key allowlists, quantities, typed data through viem |
| `relink.ts` | ~40 | Relink EIP-712 domain and types |
| `prf.ts` | ~17 | PRF salt and per-set user handle |
| `offline.ts` | ~70 | Kit + code recovery used by the offline tool: owner and Safe checks before returning the seed |
| `encoding.ts` | ~60 | Canonical base64url, hex, randomness, best-effort zeroing |
| `types.ts`, `errors.ts`, `operations.ts` | ~295, ~40, ~50 | Request and response types; `secretBuffersOf` decides which buffers are transferred and wiped |

Tests: `packages/core/tests/*.test.ts`, and the vault's crypto-level unit tests (`apps/vault/tests/unit/envelope.test.ts`, `prf.test.ts`, `seed-backup.test.ts`, `recovery.test.ts`, `sign.test.ts`, `export.test.ts`, `no-leak.test.ts`).

## Priority 2: vault client side (`apps/vault/lib`, `apps/vault/app`)

| Area | Files | What to look at |
|---|---|---|
| Worker entry and client | `lib/signer.worker.ts` (~65), `lib/signer-client.ts` (~40) | One worker per operation, transferables, which server calls the worker makes, `X-Vault-App-Origin` |
| `postMessage` channel | `lib/vault-channel.ts` (~130), `app/_components/vault-gate.tsx` (~70) | `ready` with `'*'`, acceptance only from `window.opener`, first request only, origin verification before data results, `renew()` |
| WebAuthn | `lib/prf.ts` (~195) | Creation and assertion options, PRF output handling, field-by-field registration JSON (no PRF output to the server), discoverable assertion for kit-free recovery |
| API client and deployment | `lib/vault-api.ts` (~155), `lib/aa-client.ts` (~60) | Token redemption request, origin confirmation, prepare and send of the server-built deployment, prefund check, which server codes reach the app |
| Flows | `app/activate`, `app/sign`, `app/deploy`, `app/unlock`, `app/recover`, `app/export`, `app/relink`, `app/_components/enroll-steps.tsx`, `recovery-forms.tsx`, `recovered-panel.tsx`, `kit-upgrade.tsx`, `export-panel.tsx`, `sign-review.tsx`, `recovery-tool.tsx` | Drill before activation, tool before kit, review before passkey, what each flow posts back to the app, kit `rpId` check, relink challenge checks |
| Downloads | `lib/seed-file.ts`, `lib/recovery-tool.ts` | Seed file contents and name, tool fetch acceptance rule |
| Page bootstrap | `app/layout.tsx` (~55), `lib/runtime-config.ts` | Trusted Types `default` policy, runtime delivery of RP ID and manifest public key |

## Priority 3: vault server (`apps/vault/server`, `apps/vault/app/api`)

| Area | Files | What to look at |
|---|---|---|
| Handoff tokens | `server/handoff.ts` (~185), `server/jwks.ts` (~125), `app/api/auth/handoff/route.ts` | Algorithm allowlist, claim validation, lifetime and skew, `jti` single use and its ordering, signed origin vs `event.origin`, `ALLOWED_APP_ORIGINS`, JWKS fetch limits, cache, cooldown, stale window, private-key rejection |
| Sessions and request guards | `server/http.ts` (~120) | `Origin` checks, `__Host-vault_session` attributes, `X-Vault-App-Origin` binding, the 128 KiB body cap of `readJson`, HSTS on API responses |
| Rate limits | `server/rate-limit.ts` (~125), `server/limits.ts` (~360), `scripts/peer-address.cjs` (~40), `server/startup.ts` | Client IP from the preload and `TRUSTED_PROXIES` (`X-Forwarded-For` parsing, IPv6 /64), or from `x-real-ip` with `CLIENT_IP_SOURCE=vercel` (honoured only with `VERCEL=1` and `VERCEL_REGION`; the startup checks that refuse ambiguous combinations), bucket keys, where each route counts its budgets (before or after authentication, before spending a `jti`), the fixed-window statement, share A budgets, the recovery challenge cap, the refusal to start without the preload |
| KMS stub | `server/kms.ts` (~45) | HKDF derivation from `MASTER_KEY`, envelope reuse |
| Share routes | `app/api/shares/route.ts` (~145), `app/api/shares/a/route.ts` (~65), `app/api/shares/exported/route.ts` | Enrollment validation order, owner uniqueness, Safe parameter checks, manifest signing, activation and revocation, share A release (pending sets only to the creating session, budgets before lookup, audit row before release) |
| WebAuthn server | `server/webauthn.ts` (~100), `app/api/webauthn/challenge`, `app/api/recovery/passkey/**` | Registration and assertion verification, challenge spending, counter compare-and-set, kit-free recovery response |
| Relink | `app/api/relink/nonce/route.ts`, `app/api/relink/route.ts`, store `relinkWallet` | Non-enumerating nonce issuance, typed data rebuilt server-side, transaction checks, session invalidation, audit row |
| Chains and AA proxy | `server/chains.ts` (~190), `server/safe-check.ts`, `server/sponsorship.ts` (~375), `app/api/aa/status/route.ts`, `app/api/aa/rpc/route.ts` (~90) | RPC URL resolution and allowlist, chain id check, three-method allowlist, the server-built deployment (fees, with the bundler's `pimlico_getUserOperationGasPrice` quote as a floor bounded by the cap, gas margin and caps, paymaster result validation), the comparison of the sent operation with the prepared one, the owner signature check, the `sponsored_deployments` state machine (single flight, release on failure, retry window), receipt restriction, sponsorship context, response limits |
| s2s | `app/api/s2s/accounts/[sub]/route.ts` (~55) | Rate limits before and after the bearer check, bearer token comparison, `sub` and `chainId` validation before any lookup, response contents |
| Configuration | `server/config.ts` (~250), `server/limits.ts`, `server/startup.ts`, `instrumentation.ts` | Startup validation, RP ID vs origin, insecure local mode, limit and sponsorship variables, `sslmode` required on Vercel |
| Stores | `server/store/*` (`sql-store.ts` ~480, `postgres.ts`, `postgres-url.ts` (the `sslmode` and `channel_binding` rewriting), `sqlite.ts`, `migrate.ts`, `migrations/*`) | Atomicity of single-use operations, rate-limit counters and sponsored deployment claims, locking, the one-active-set invariant, migrations (006 adds `rate_limits`, `share_a_releases`, `sponsored_deployments`) |
| Brand | `server/brand.ts` (~715), `app/brand/[file]/route.ts` | Validation of operator-supplied JSON, SVG and fonts; serving headers. Lower priority: the operator is trusted, but the code parses files |

## Priority 4: SDK (`packages/sdk/src`)

| File | Lines | What to look at |
|---|---|---|
| `client/index.ts` | ~300 | Popup opening, message origin and source checks, `targetOrigin`, supersede and close handling, per-action result validation (`PROTOCOL_ERROR`), `timeoutMs` |
| `protocol.ts` | ~55 | Wire types and constants |
| `server/handoff.ts`, `server/signer.ts` | ~110, ~100 | Token minting (claims, lifetime, `jti`), EdDSA, ES256 and RS256 signers, public JWK export |
| `server/jwks.ts` | ~40 | JWKS response and handler, private-key rejection (500 `INTERNAL` from the handler) |
| `server/service-client.ts` | ~75 | s2s client, `vaultOrigin` normalization |
| re-exported `core/safe` | | Signature verification helpers used by integrators |

## Priority 5: offline recovery

| Area | Files | What to look at |
|---|---|---|
| Offline tool | `packages/recovery-tool/src/page.ts`, `page.html`, `page.css`, `cli.ts`, `messages.ts` | DOM handling (`textContent` only), seed reveal, CLI code input (never an argument), exit codes |
| Tool build | `packages/recovery-tool/scripts/build.mjs` | Reproducibility, `fetch` stub, inline-script safety check, CSP with hashes |
| Static recovery page | `apps/vault/static-recovery/*`, `apps/vault/scripts/build-static-recovery.mjs` | `connect-src 'none'`, worker with no backend, Trusted Types policy, header file, input validation of build parameters |

See [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md) and [RECOVERY.md](RECOVERY.md).

## Priority 6: headers, CSP and container

| Area | Files |
|---|---|
| Vault CSP (nonce, Trusted Types), HSTS, the matcher that leaves out `/api/` | `apps/vault/proxy.ts` (~55) |
| Static headers and worker CSP; on Vercel, no standalone output and the brand traced into every function | `apps/vault/next.config.mjs` (~60), `apps/vault/vercel.json` (only `main` deploys, no previews) |
| Image | `apps/vault/Dockerfile` (the `peer-address.cjs` preload in the command), `.dockerignore`, `compose.yaml` (read-only root, dropped capabilities, non-root user) |

## Critical dependencies

Exact versions as pinned in the `package.json` files and resolved in `pnpm-lock.yaml`. Direct dependencies are pinned without ranges.

### Key material, cryptography and signing

| Package | Version | Used by | Role |
|---|---|---|---|
| `@tetherto/wdk-utils` | `1.0.0-beta.16` | core (browser worker) | `splitMnemonic` / `combineMnemonic`: BIP-39 entropy, 4-byte checksum, Shamir 2-of-3 |
| `shamir-secret-sharing` | `0.0.4` | transitive, via wdk-utils | The GF(2^8) Shamir implementation itself |
| `@noble/hashes`, `@noble/ciphers`, `@scure/base` | `2.4.0` | transitive, via wdk-utils | SHA-256 checksum, hex encoding inside wdk-utils |
| `@noble/curves` | `2.4.0` | core, sdk, vault | Ed25519 manifest signatures (core), Ed25519 handoff key helpers (sdk) |
| `@scure/bip39` | `2.4.0` | core, wdk-utils | Mnemonic generation (English wordlist) and entropy conversion |
| `viem` | `2.57.16` | core, vault, demo | `mnemonicToAccount` (BIP-32 derivation, secp256k1 signing), EIP-191 and EIP-712 hashing, typed-data signing, signature recovery, address utilities |
| `@scure/bip32` | `1.7.0` | transitive, via viem | BIP-32 derivation used by `mnemonicToAccount` |
| `@scure/bip39` | `1.6.0` | transitive, via viem | Mnemonic to seed inside `mnemonicToAccount` |
| `@noble/curves` | `1.9.1` | transitive, via viem | secp256k1 ECDSA used by viem accounts |
| `ox` | `0.14.59` | transitive, via viem | viem internals |
| `hash-wasm` | `4.12.0` | core | Argon2id (WebAssembly) |
| `abstractionkit` | `0.4.0` | core, demo, WDK | Safe 4337 v0.3.0: address prediction, factory data, call encoding, SafeOp EIP-712 hash, UserOperation signing and hashing |
| WebCrypto | platform | core, vault | AES-256-GCM, HKDF-SHA256, SHA-256, randomness |

### Authentication and server

| Package | Version | Used by | Role |
|---|---|---|---|
| `jose` | `6.2.15` | vault, sdk | Handoff JWT verification (`jwtVerify`, `createRemoteJWKSet`) and minting |
| `@simplewebauthn/server` | `14.0.3` | vault | Passkey registration and assertion verification |
| `@tetherto/wdk-wallet-evm-erc-4337` | `1.0.0-beta.24` | vault server | `predictSafeAddress` cross-check of new wallets (read-only; no keys) |
| `@tetherto/wdk-wallet-evm` | `1.0.0-beta.19` | transitive | Pulled in by the above |
| `@tetherto/wdk-wallet` | `1.0.0-beta.17` | transitive | Pulled in by the above |
| `@tetherto/wdk-failover-provider` | `1.0.0-beta.2` | transitive | Pulled in by the above |
| `ethers` | `6.17.0` | transitive | Pulled in by the WDK EVM packages |
| `sodium-native` / `sodium-universal` | `5.2.0` / `5.0.1` | transitive, via `@tetherto/wdk-wallet-evm` | Native addon loaded on the server; not used for any vault key operation |
| `pg` | `8.23.1` | vault | Postgres driver |
| `node:sqlite` | Node 22.13+ built-in | vault | SQLite store (development and tests); experimental in Node |

### Framework and build

| Package | Version | Used by | Role |
|---|---|---|---|
| `next` | `16.4.5` | vault, demo | Pages, route handlers, middleware (`proxy.ts`), standalone output |
| `react`, `react-dom` | `19.3.1` | vault, demo | UI |
| `esbuild` | `0.28.2` | recovery-tool, vault | Reproducible offline tool build; static recovery page build |
| `typescript` | `5.9.3` | all | Type checking |
| Node.js base image | `node:22-bookworm-slim`, pinned by digest in `apps/vault/Dockerfile` | vault image | Runtime |

Test-only: `vitest` `5.1.0`, `@playwright/test` `1.65.0`, Foundry `anvil` (not pinned by the repository), the Safe and EntryPoint bytecode fixtures in `apps/vault/tests/aa-stack/fixtures`.

Dependency review should at least confirm that the WDK beta packages and `shamir-secret-sharing` behave as [CRYPTO-SPEC.md](CRYPTO-SPEC.md#5-shamir-secret-sharing) describes, and that nothing in the worker bundle performs network access other than the vault's own `fetch` calls.

## Out of scope

| Item | Reason |
|---|---|
| `examples/demo` | Sample integrator app (password hashing, TOTP, sessions, its rate limits and database, its token endpoint and JWKS). It demonstrates the SDK; integrators write their own. Its use of the SDK may still be read as a reference. |
| `apps/vault/tests/aa-stack` | Local anvil chains, the test bundler, `TestVerifyingPaymaster.sol` and contract fixtures exist only for tests. |
| `e2e/` | Test harness. |
| `deploy/Caddyfile`, `deploy/recovery.Caddyfile` | Example TLS and static hosting configurations. |
| Hosting, DNS, TLS certificates, registries | Operator responsibility. |
| The Safe, Safe 4337 module and EntryPoint contracts | Third-party audited contracts, used at their canonical addresses. |
| Bundler and paymaster services | Third-party infrastructure, reached only from the vault server. How the vault validates their answers is in scope. |
| Brand assets in `brands/example` | Fictional sample content. |

## Suggested deliverables

- Findings rated by severity, mapped to the goals in [THREAT-MODEL.md](THREAT-MODEL.md#security-goals).
- An opinion on each [accepted risk](THREAT-MODEL.md#accepted-risks): acceptable, needs mitigation, or blocking for production.
- Confirmation (or correction) of [CRYPTO-SPEC.md](CRYPTO-SPEC.md), including its test vectors.

Reporting channel: [SECURITY.md](../SECURITY.md).
