# Implementation decisions

This document pins down the original design specification wherever it left room for interpretation, and records every place where the implementation deviates from it. It is the contract between `packages/core`, `packages/sdk`, `apps/vault/lib`, `apps/vault/server`, the HTTP API and the vault pages.

Related documents: [README.md](../README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CRYPTO-SPEC.md](CRYPTO-SPEC.md), [PROTOCOL.md](PROTOCOL.md), [HTTP-API.md](HTTP-API.md), [THREAT-MODEL.md](THREAT-MODEL.md), [RECOVERY.md](RECOVERY.md), [DEPLOYMENT.md](DEPLOYMENT.md), [BRANDING.md](BRANDING.md), [ROADMAP.md](ROADMAP.md).

## Deviations from the specification

| # | Specification | Implementation | Rationale |
|---|---|---|---|
| 1 | Enrollment: seed → passkey → code | Passkey → code and confirmation → worker (seed, split, encryption, POST) | The seed does not exist until everything it needs is in place, and it lives for a single worker operation. If the passkey does not support PRF, nothing has been generated yet. |
| 2 | The API creates the set and invalidates the previous one | The set is created `pending`. It only becomes `active` after the A+B dry run (`PATCH /api/shares`), and only then is the previous set revoked | If the dry run fails during a rotation, the previous set remains valid. |
| 3 | The main thread performs the `GET` for share A | The worker requests A and performs the `POST` | The main thread never sees a plaintext share. |
| 4 | The `wrappers` from the WDK documentation | Implemented in `packages/core/src/shamir.ts` | `recoverMnemonic` and `verifyRecovery` are examples from the WDK guide, not exports of the package. |
| 5 | A single Next.js project | Monorepo with `apps/vault`, `examples/demo`, `packages/core`, `packages/sdk` and `packages/recovery-tool` | To validate origin isolation against an XSS in the integrator app. |
| 6 | Persistence in `data/db.json` | A separate database per app. The demo uses SQLite; the vault uses SQLite in development and Postgres in production | Product requirement: no external database for local development. Postgres was added later for production (see "Deployment"). |
| 7 | Login with username and TOTP inside the single application | Login, registration and 2FA live in the integrator app (the demo). The vault receives a single-use JWT, verifies it against the app's JWKS and, without a second factor of its own, delivers share A | Design decision: a single 2FA, the one in the app's normal login, and the vault is activated without asking for another code. See "Trust model". |
| 8 | Signing and wallet out of scope | The account is a Safe 4337. Real deployment through a bundler and paymaster. Message, EIP-712 and UserOperation signing only once the Safe is deployed on that network | Product requirement. See "Smart account". |
| 9 | Fixed `AA_CHAIN_ID` | Multichain: network and RPC per operation, signed into the token | Product requirement. See "Multichain". |
| 10 | The kit only carries B and C | The kit also carries a backup of the seed, encrypted with the recovery code, **on by default, with no opt-out checkbox** | Design decision: keep the wallet usable if the backend holding A disappears. This changes the threat model. See "Recovery". |

## Architecture

```
apps/vault                   vault.localhost:3201  Share A, encB, encC, manifest and MASTER_KEY. Reconstructs only in the browser worker.
examples/demo                app.localhost:3200    Sample integrator app: users and sessions. Never sees shares or the seed.
packages/core                                      @wl-embedded-wallet/core: pure crypto core (envelopes, manifest, kit, recovery code, seed backup, Safe, worker logic).
packages/sdk                                       @wl-embedded-wallet/sdk: /client (activate(), deploy(), signMessage(), signTypedData(), signUserOperation(), unlock(), recover(), export(), relink()), /server (handoff tokens, JWKS, s2s client), /protocol
packages/recovery-tool                             Offline tool built on the core: a single-file HTML page and a Node CLI
```

Separate hosts are used because two ports on `localhost` share the RP ID and cookies, which would not exercise isolation. The RP ID is exactly `vault.localhost`. Development ports: `3200` (demo) and `3201` (vault), to stay clear of the commonly used `3000` and `3001`. End-to-end ports: `4300` (demo), `4301` (vault), `4302` (a second app) and `4306` (static recovery page). See [ARCHITECTURE.md](ARCHITECTURE.md) and [TESTING.md](TESTING.md).

### User flow

1. The user registers or logs in to the demo (email and password hashed with scrypt, stored in SQLite locally or in Postgres when `DATABASE_URL` is set, as on Vercel).
2. The demo server queries the vault with `GET /api/s2s/accounts/:sub` (header `Authorization: Bearer VAULT_SERVICE_TOKEN`). Response: `{ exists, address, owner }`, plus `deployed` on that network when `chainId` is given. `address` is the Safe.
3. If `exists`, the demo shows the existing wallet. Otherwise it shows "Activate wallet".
4. Activating or signing opens a vault popup. The popup announces `ready`, and the SDK sends it, via `postMessage`, a fresh token from the demo plus the request. The token never travels in the URL.
5. The vault verifies the token and opens a session.
6. Activation: passkey → code → worker → recovery tool → kit → A+B dry run → return the address.
7. Deployment: review screen with the Safe, network, RPC host and cost → passkey → worker (A+B) signs the UserOperation → bundler via the vault proxy → receipt.
8. Signing: review screen with the decoded data, the requesting origin and the network → Approve → passkey → worker (A+B) → signature. Every signature reconstructs and then discards the seed. Rejecting returns `USER_REJECTED`. Without the Safe deployed on that network: `WALLET_NOT_DEPLOYED`.
9. The demo server verifies the signature (`POST /api/signatures/verify`): messages and EIP-712 through ERC-1271 on the contract, and the UserOperation by recovering the owner. Only the deployment reaches the chain.

See [INTEGRATION.md](INTEGRATION.md) for the integrator side of this flow.

### Handoff token

A compact JWT signed by the integrator's backend, issued specifically for the vault: it is not the app's session JWT. Claims: `{ iss, aud, sub, label, origin, jti, iat, exp, chain? }`, with `kid` in the header. Lifetime 60 s; the vault rejects any token with a lifetime over 120 s. The `jti` is single-use, also across replicas.

The vault verifies it with `jose`, with no custom JWT code:

- **Keys:** `createRemoteJWKSet` against `HANDOFF_JWKS_URL`, the JWKS published by the app. Allowed algorithms: `EdDSA`, `ES256` and `RS256`. The key is never selected from the token contents, except for the `kid`, which is mandatory with a JWKS.
- **Alternative without a JWKS:** `HANDOFF_PUBLIC_KEY`, a fixed Ed25519 key, `EdDSA` only. It uses the same verification path, and startup requires exactly one of the two.
- **`iss` and `aud`:** exactly `HANDOFF_ISSUER` and `HANDOFF_AUDIENCE` (`ORIGIN` by default).

JWKS download (`apps/vault/server/jwks.ts`, on top of the `jose` `customFetch` hook):

- 5 s timeout, 64 KiB maximum, redirects are not followed.
- Cached for `HANDOFF_JWKS_CACHE_SECONDS`, with `HANDOFF_JWKS_COOLDOWN_SECONDS` between refreshes triggered by an unknown `kid` or after a failure: made-up `kid` values or an outage do not multiply downloads.
- While the JWKS is down, the last good document is used for up to `HANDOFF_JWKS_MAX_STALE_SECONDS`. After that the vault fails closed with `INVALID_TOKEN` and logs the cause, without the URL or any token data. `/api/health` does not depend on the JWKS.
- A document containing private or symmetric key material (`d`, `p`, `q`, `k`, ...) is rejected and also invalidates the cache, because that key can no longer be trusted.

### Multiple apps and the signed origin

- **`origin` claim, mandatory:** the exact origin of the app, set by its backend. It is normalized (scheme, host and port, no path or trailing slash) and must be HTTPS, except for local hosts with `ALLOW_INSECURE_LOCAL`.
- **Check:** the popup redeems the token together with the request's `event.origin`, which is set by the browser. The server requires `claims.origin === origin` or responds `ORIGIN_MISMATCH`, without consuming the `jti`.
- **`ALLOWED_APP_ORIGINS`:** optional. When set, it is an additional restriction (`ORIGIN_NOT_ALLOWED`). A popup without a valid token is never accepted, even if a live session exists.
- **Session:** every redemption creates a session bound to its origin. Every later request must declare that origin in `X-Vault-App-Origin` or gets `ORIGIN_MISMATCH`. This header protects against accidentally using another app's session; someone holding a live token outside the browser can declare the signed origin (accepted risk).
- **Identity:** the wallet is bound to `sub` within the single `HANDOFF_ISSUER`. There is no multi-issuer support. The passkey works from any app because its RP ID is the vault's.
- **Shared login backend:** it must validate the request's `Origin` against its own allowlist and never reflect it, because that claim authorizes an app to use the wallet.

### Trust model

The vault has no authenticator code of its own. 2FA belongs to the app's login, and the vault cannot verify it: it trusts the token from the app's backend. Redeeming a token opens a 15-minute session, and that session is enough to receive share A. After that, the passkey or the recovery code is required as usual.

**Accepted risk:** whoever compromises the app's backend, its signing key, its JWKS or a live token obtains that user's share A. Compromising the JWKS is equivalent to compromising the signing key. A alone is useless. Combined with the user's recovery code it yields the seed, so the code must keep 128 bits: with A and `encC`, a short code could be brute-forced offline. An e2e test demonstrates this behavior. See [THREAT-MODEL.md](THREAT-MODEL.md).

### Popup and `postMessage`

- Versioned protocol (`wl-embedded-wallet/protocol/v1`, defined in `packages/sdk/src/protocol.ts`). The vault accepts messages only from `window.opener`. The SDK accepts messages only from the popup window and from the exact vault origin. See [PROTOCOL.md](PROTOCOL.md).
- **`*` only for `ready`:** the vault does not know the app's origin in advance, so `ready`, which carries no data, is sent with `targetOrigin: '*'`. No other message uses `*`. Every `result` goes to `claims.origin` as an exact target, and a rejection issued before the token is validated carries only the error code and goes to `event.origin`. No review screen is shown until the token has been validated.
- `window.open` always uses a fixed window name (`wl-embedded-wallet-vault`). The vault ends with a "Back to the app" screen and does not close itself. This lets the e2e tests reuse the same window, because the CDP virtual authenticator is per tab and its PRF secret cannot be exported to another tab.
- The vault must not use a COOP header that severs `window.opener`.

### Vault security

Nonce-based CSP through `apps/vault/proxy.ts` (Next 16), enforced only in production: `default-src 'none'; script-src 'self' 'nonce-…' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. `font-src 'self'` is for the brand fonts, and `/brand/` is served with its own sandbox CSP: see "Per-deployment branding". `require-trusted-types-for 'script'` and `trusted-types default` are appended to that list. No third-party scripts. No CORS.

- **Trusted Types:** they work with Next 16 and Turbopack through a single `default` policy, defined in an inline nonce-bearing script in `apps/vault/app/layout.tsx`. It only admits URLs under `/_next/static/`, and since it defines neither `createHTML` nor `createScript`, those sinks are blocked. Verified in Chromium with the production build: `new Worker`, wasm, signing and downloads keep working.
- **Worker CSP:** a worker's CSP is the one on its script response, not the page's. That is why `apps/vault/next.config.mjs` adds its own CSP to `/_next/static/`, with `connect-src 'self'` and `wasm-unsafe-eval`.
- **Cookie:** `__Host-vault_session`, host-only, httpOnly, Secure and SameSite=Strict. Chromium accepts it on `http://vault.localhost`. Not verified in Safari or Firefox, which may reject `Secure` over HTTP: if so, manual testing will need local HTTPS.
- **One wallet per user:** `POST /api/shares` responds `409 WALLET_ALREADY_EXISTS` if there is an active set with a different address, and `/activate` returns the existing wallet instead of creating another. A rotation must keep the address. The address is declared by the client: the server cannot check that it matches the shares.
- **One session per token:** every token opens a session and closes the previous one in that browser, so a session never carries over to another `sub`.

## Technical decisions

- **Versions:** `@tetherto/wdk-utils@1.0.0-beta.16`. TypeScript on the latest 5.x, not 7, for Next.js compatibility.
- **Seed:** 12 words (128 bits). The shares are `A`, `B`, `C`, in the order returned by `splitMnemonic`.
- **Digest:** SHA-256 of the share bytes (hex-decoded), as lowercase hex.
- **Envelope plaintext:** the share bytes.
- **AAD:** `wl-embedded-wallet/envelope/v1|{userId}|{setId}|{share}`, built from the expected values in the signed manifest, never from the envelope's own fields. Otherwise, replacing the whole envelope would pass the check. `envelope.share === expected share` is also required. See [CRYPTO-SPEC.md](CRYPTO-SPEC.md).
- **`kms` envelope (share A):** key = HKDF-SHA256(`MASTER_KEY`, `salt`, `"wl-embedded-wallet/share-a/kms/v1|" + userId + "|" + setId`). This also effectively authenticates `salt`. Share B uses the same construction over the PRF output, with info `wl-embedded-wallet/share-b/aes/v1|{userId}|{setId}`.
- **`kdfParams` are untrusted data:** they are read from the envelope, but bounded (`memorySize ≤ 1048576`, `iterations ≤ 10`, `parallelism ≤ 4`, `hashLength = 32`) to prevent a DoS through a tampered kit.
- **`wdkUtilsVersion`:** a version different from the bundled one does not abort, because the expected address already detects a wrong result. The worker returns `wdkVersionMismatch: true` and the UI shows a warning. A different `format` does abort.
- **PRF salt:** a single, fixed, public value, `SHA-256("wl-embedded-wallet/share-b/prf/v1")`. It is not per credential: the per-credential secret is supplied by the authenticator. See "Recovery without a kit".
- **Passkey `user.id`:** `SHA-256(userId + "|" + setId)`. With a fixed `user.id`, a new resident passkey would replace the previous one in the same provider and break the old set before the dry run. The trade-off is that old passkeys accumulate in the provider.
- **`RP_ID`:** delivered to the client at runtime in the HTML (`apps/vault/lib/runtime-config.ts`), not through a build-time variable: see "Deployment". `ORIGIN` is checked on the server in every method that writes.
- **Recovery code:** normalization = uppercase, hyphens and spaces removed, `I`/`L`→`1`, `O`→`0` (Crockford base32). Exact length 26. The Argon2id password is the ASCII bytes of the normalized code.
- **Users in the vault:** `userId = sub` from the app's token. The vault stores no user credentials.
- **SQLite:** `node:sqlite`. The demo uses `DB_PATH`, or Postgres when `DATABASE_URL` is set. The vault is configured with `DATABASE_URL`: see "Deployment".
- **Variables:** `pnpm setup:env` generates `apps/vault/.env.local` and `examples/demo/.env.local` with mutually consistent keys.

## Vault API

All routes use `runtime = 'nodejs'`, respond with `Cache-Control: no-store`, and return errors as `{ "error": "CODE" }`. The full reference is [HTTP-API.md](HTTP-API.md); route handlers live under `apps/vault/app/api`.

| Method and route | Input | Output |
|---|---|---|
| `POST /api/auth/handoff` | `{ token, origin, chainId? }` | `200 { userId, label, origin }` + session cookie (random token in the database, 15 min). Stores the token's network in the session · `401` · `400 CHAIN_REQUEST_MISMATCH` |
| `GET /api/s2s/accounts/:sub?chainId=&rpcUrl=` | `Authorization: Bearer` | `200 { exists, address, owner }`. With `chainId`, also `{ chainId, deployed, deployable, sponsored }`, or `deployed: null` and `chainError` · `401` · `400 INVALID_SUB`, `400 INVALID_CHAIN_ID` |
| `GET /api/aa/status` | Session | `200 { chainId, chainName, nativeCurrency, rpcHost, deployed, deployable, sponsored, bundler, balance }` on the session's network · `409 { error }` |
| `POST /api/aa/rpc` | `{ method, params }`. Session | `200 { result }` · `403 METHOD_NOT_ALLOWED` · `403 OPERATION_NOT_ALLOWED` · `409 { error }` · `502 UPSTREAM_ERROR`, `502 UPSTREAM_INVALID`. See "Proxy" |
| `POST /api/shares/exported` | | `200 { exportedAt }`. Audit only, no seed data |
| `POST /api/shares` | `{ setId, credentialId, shareA, encB, encC, shareDigests, expectedAddress, smartAccount, wdkUtilsVersion }` | `201 { manifest, signature }`. Set is `pending`. Checks that the envelopes' `userId`/`setId`/`share` match the session, that `SHA-256(shareA)` matches its digest, and the Safe (`400 SMART_ACCOUNT_MISMATCH`) |
| `GET /api/shares[?setId=]` | Without `setId`: the active set | `200 { setId, status, encB, encC, credentialId, manifest, signature, exportedAt }` · `404` · `410` if revoked |
| `PATCH /api/shares` | `{ setId }` | `200 { status: "active" }`. The previous set becomes `revoked` and its encrypted material is deleted |
| `GET /api/shares/a?setId=` | | `200 { shareA }`: the active set, or a `pending` set only to the session that created it. Budgeted per session and per user, and every release is recorded in `share_a_releases` · `401` · `404` · `410` · `429` |
| `POST /api/webauthn/challenge` | Session | `200 { challenge }`. Challenge for creating the passkey, bound to that session, single-use, 15 min |
| `POST /api/recovery/passkey/challenge` | No session | `200 { challenge }`. Single-use, 5 min. At most `RECOVERY_CHALLENGE_MAX_LIVE` live at once (`429`) |
| `POST /api/recovery/passkey` | `{ assertion }`. No session | `200 { setId, credentialId, encB, encC, manifest, signature }`. **Never A**, and no session is opened · `401 RECOVERY_FAILED`, always the same response |
| `POST /api/relink/nonce` | `{ safe, owner }`. Session | `200 { safe, owner, newSub, issuer, vaultOrigin, nonce, expiresAt }`, whether or not that wallet exists · `409 WALLET_ALREADY_EXISTS` if this account already has one |
| `POST /api/relink` | `{ nonce, signature }`. Session | `200 { address, owner }` · `403 RELINK_REJECTED`, without stating the reason · `409 WALLET_ALREADY_EXISTS` |
| `GET /recovery-tool` | Public | The offline tool, as a download. Contains nobody's data |

`POST /api/shares` also accepts `registration`, the `credentials.create` response without PRF output: the server checks challenge, origin, RP ID and user verification, and stores the public key. Without that field, the set is created without a key, like older sets. It rejects a body containing `seedBackup` (`400`), and a new wallet whose owner is already active in another account (`409 WALLET_ALREADY_EXISTS`).

Without a valid session: `401`. With a different `Origin`: `403`. Over a rate limit: `429 RATE_LIMITED` with `Retry-After` (every route above except `GET /api/shares`, `POST /api/shares/exported` and `/recovery-tool`). A JSON body over 128 KiB: `413 PAYLOAD_TOO_LARGE`.

## Emergency kit

```json
{ "v": 2, "rpId": "vault.localhost", "credentialId": "b64url", "encB": {}, "encC": {}, "manifest": {}, "signature": "b64url",
  "seedBackup": { "v": 1, "kdf": "argon2id", "kdfParams": {}, "salt": "b64url", "iv": "b64url", "ct": "b64url" } }
```

Saved as `wl-embedded-wallet-kit-{setId[0..8]}.json`. `parseKit` (`packages/core/src/kit.ts`) is strict: `v: 2` requires a valid `seedBackup` with no extra fields, and `v: 1` must not carry one. `v: 1` kits are still readable.

## Worker protocol

Each operation creates a worker, which receives one message and responds with exactly one. The worker then wipes its buffers and calls `self.close()`. `prf` and `code` are transferred `Uint8Array`s. The worker entry point is `apps/vault/lib/signer.worker.ts`; the logic is `handleWorkerRequest` in `packages/core/src/signer.ts`, and the types are in `packages/core/src/types.ts`.

```ts
type WorkerRequest =
  | { op: 'enroll'; userId: string; setId: string; credentialId: string; prf: Uint8Array; code: Uint8Array;
      source?: RecoverAC | OfflineSource; // with source: re-enrollment, same seed
      linkedOwner?: string; // owner of this session's wallet according to the server, after a relink
      registration?: RegistrationJson } // so the server can store the public key
  | RecoverAB | RecoverAC | RecoverBC | RecoverKitCode
  | { op: 'sign'; chainId: number; signed: SignedManifest; encB: Envelope; prf: Uint8Array; request: SignRequest }
  | { op: 'deploy'; chainId: number; signed: SignedManifest; encB: Envelope; prf: Uint8Array; userOperation: UserOperationJson }
  | { op: 'export'; signed: SignedManifest; encB: Envelope; prf: Uint8Array }
  // Without share A. None of these calls the server or the chain.
  | { op: 'sign-recovered'; chainId: number; source: OfflineSource; request: SignRequest }
  | { op: 'export-recovered'; source: OfflineSource } // like `export`, its response carries `mnemonic`
  | { op: 'sign-relink'; source: OfflineSource; relink: RelinkChallenge } // signed directly by the owner, not by the Safe
  | { op: 'upgrade-kit'; source: RecoverAB | RecoverBC; encC: Envelope; code: Uint8Array } // A+B does request A

type SignRequest =
  | { kind: 'message'; message: string }
  | { kind: 'typedData'; typedData: TypedDataRequest }
  | { kind: 'userOperation'; userOperation: UserOperationRequest } // no factory, never submitted on-chain

type RecoverAB = { op: 'recover'; combo: 'A+B'; signed: SignedManifest; encB: Envelope; prf: Uint8Array }
type RecoverAC = { op: 'recover'; combo: 'A+C'; signed: SignedManifest; encC: Envelope; code: Uint8Array }
type RecoverBC = { op: 'recover'; combo: 'B+C'; signed: SignedManifest; encB: Envelope; encC: Envelope; prf: Uint8Array; code: Uint8Array }
type RecoverKitCode = { op: 'recover'; combo: 'kit+code'; signed: SignedManifest; seedBackup: SeedBackup; code: Uint8Array }
type OfflineSource = RecoverBC | RecoverKitCode

type WorkerResponse =
  | { ok: true; address: string /* the Safe */; owner: string; wdkVersionMismatch: boolean; signature?: string; userOperation?: UserOperationJson; enrolled?: { signed: SignedManifest; encB: Envelope; encC: Envelope; seedBackup: SeedBackup }; mnemonic?: string /* export and export-recovered only */; seedBackup?: SeedBackup /* upgrade-kit only */ }
  | { ok: false; code: WalletErrorCode } // never contains sensitive material
```

`WalletErrorCode` (`packages/core/src/errors.ts`): `MANIFEST_INVALID`, `FORMAT_UNSUPPORTED`, `DECRYPT_FAILED`, `SERVER_KEY_MISMATCH`, `SHARE_TAMPERED`, `COMBINE_FAILED`, `ADDRESS_MISMATCH`, `WALLET_NOT_DEPLOYED`, `CHAIN_MISMATCH`, `CHAIN_NOT_SUPPORTED`, `CHAIN_UNAVAILABLE`, `CHAIN_REQUEST_MISMATCH`, `ORIGIN_MISMATCH`, `ORIGIN_NOT_ALLOWED`, `INSUFFICIENT_FUNDS`, `DEPLOY_FAILED`, `KDF_PARAMS_INVALID`, `BAD_RECOVERY_CODE`, `INVALID_KIT`, `NO_SEED_BACKUP`, `WALLET_ALREADY_EXISTS`, `RELINK_REJECTED`, `RECOVERY_FAILED`, `NETWORK`, `UNAUTHORIZED`, `INTERNAL`.

The verification order is fixed: manifest signature → format → Safe recomputed from the owner → decryption → digest of each share → `combineMnemonic` → owner address. In `sign` and `deploy`, before all of that, the worker asks the server for the wallet's status on that network.

## Module layout

What the original specification placed in a single `lib/` directory is now split between the core package and the vault app:

- `packages/core/src/types.ts` and `errors.ts`: shared types and `WalletError`.
- `packages/core/src/encoding.ts`: b64url and hex.
- `packages/core/src/shamir.ts`: `recoverMnemonic` and `verifyRecovery`.
- `packages/core/src/signer.ts`: pure enrollment, recovery and signing logic, with no `self` and no direct `fetch` (`fetchShareA`, `postShares` and `fetchChainStatus` are injected through `SignerDeps`). Used by the vault worker, the static recovery page's worker and the tests.
- `packages/core/src/relink.ts`: the EIP-712 relink message.
- `packages/core/src/kit.ts`, `schema.ts`, `recovery-code.ts`, `seed-backup.ts`, `envelope.ts`, `manifest.ts`, `prf.ts`, `safe.ts`, `offline.ts`: kit, schema validation, recovery code, seed backup, envelopes, manifest, PRF salt, Safe and offline checks. The offline tool and the worker use this same code.
- `apps/vault/lib/signer-client.ts`: starts the worker and returns its response. The static page injects its own worker.
- `apps/vault/lib/recovered.ts`: what allows operating without A, and how the passkey is requested for each operation.
- `apps/vault/lib/vault-channel.ts`: the popup side of the `postMessage` channel.

## Popup protocol

Defined in `packages/sdk/src/protocol.ts`. Sequence:

1. The SDK opens `{vaultOrigin}/{kind}` with `window.open` inside the user gesture, to avoid popup blocking.
2. The vault sends `ready` to `window.opener`.
3. The SDK asks its own server for a fresh token at that moment, because it expires in 60 s, and replies with `request`.
4. The vault responds with `result`, carrying a `WalletErrorCode` or `USER_REJECTED` on failure. If the user closes the popup, the SDK rejects with `POPUP_CLOSED` (other SDK-side codes: `POPUP_BLOCKED`, `TOKEN_UNAVAILABLE`, `SUPERSEDED`, `NOT_IN_BROWSER`, `TIMEOUT` when the optional `timeoutMs` expires, `PROTOCOL_ERROR` for a malformed `result`, and `INTERNAL` when the browser fails to open the popup or post to it).

Token format: compact JWT, see "Handoff token". `sub` and `jti` must match `^[A-Za-z0-9_-]{1,64}$`, which is why the demo's user ids are UUIDs. See [PROTOCOL.md](PROTOCOL.md).

## Seed export

Optional, at the user's request, and only inside the vault.

- **When:** at the end of activation, after the dry run, and later from `/export`.
- **How:** the warning requires explicit confirmation. Then the passkey is requested and the worker reconstructs the seed with A+B in the op `{ op: 'export'; signed; encB; prf }`, whose response adds `mnemonic`. This (together with `export-recovered`) is the only operation in which the seed leaves the worker, and it only reaches the vault's main thread to generate the `.txt` file.
- **Never leaves the vault:** it does not go through `postMessage`, the API or the logs, and it is not kept in React state beyond generating the file.
- **Audit:** `POST /api/shares/exported` stores `exportedAt` on the user, without any seed data. If the user has exported, the UI says so.
- **Limitation:** a rotation creates a new set but does not change the seed. If the file leaks, rotating does not help: the user must create a new wallet and move the funds.

## Recovery

See [RECOVERY.md](RECOVERY.md) for the user-facing procedures.

### Threat model change

**Previously, kit + code yielded only share C. Now they yield the seed, with no passkey and no server.** This is what keeps the wallet alive if the backend disappears for good together with share A. It is a design decision, on by default and with no opt-out checkbox. Consequences:

- **The kit and the code must be stored separately.** Together, they are the wallet. Both the code screen and the kit screen say so.
- Whoever steals both together needs neither the passkey nor share A, nor for the vault to exist. There is nothing to revoke.
- The code still has 128 bits: stealing **only** the kit is useless, and offline brute force against Argon2id is not feasible.
- The server gains nothing: the backup never reaches it. An e2e test that intercepts all activation traffic proves it, and `POST /api/shares` rejects a body that carries it.

### Seed backup

- **Where it is generated:** in the worker, during `enroll`, before anything is sent to the server. It is decrypted and compared with the seed before continuing. If it does not match, enrollment stops.
- **Encryption:** Argon2id with the same parameters as C, with its own salt and nonce, and AES-256-GCM over the seed text.
- **AAD:** `wl-embedded-wallet/seed-backup/v1|<lowercase owner>`. The label separates it from the C envelope, whose AAD starts with `wl-embedded-wallet/envelope/v1`, and the owner comes from the manifest, never from the backup. A backup moved into another kit does not decrypt.
- **If the owner or the Safe do not match:** the seed is not released, not even with `--show-seed`. The tool shows what it computed and what the kit claims. A false match can only be achieved by knowing the code or by tampering with the kit, and whoever can tamper with the kit could also destroy it.
- **Manifest signature:** the offline tool does not verify it, because it does not have the public key and would not put it in the kit: it would be a key taken from the same file it is supposed to authenticate. What authenticates the backup is AES-GCM under the code.

### Offline tool

`packages/recovery-tool` builds with esbuild, into `dist/`:

- `wl-embedded-wallet-recovery.html`: a single file, with Argon2 inlined (`hash-wasm` embeds its wasm as base64). CSP via `<meta>` with the exact hash of its script and style, `default-src 'none'`, `connect-src 'none'`, `base-uri` and `form-action` set to `'none'`, and Trusted Types. It works from `file://`, on the main thread, because workers are not available there.
- `wl-embedded-wallet-recovery.mjs`: the CLI, with no network modules.
- `SHA256SUMS`.

`abstractionkit` cannot be tree-shaken and carries network code that is never called here. The build defines `fetch` as a function that throws, so the output contains no call to `fetch` at all. The seed is shown only after pressing a button, or with `--show-seed`. The CLI does not accept the code as an argument, because it would end up in the shell history and the process list; it prompts without echo or reads it with `--code-stdin`.

The vault serves the tool at `GET /recovery-tool`, as a download: with every kit delivery, and on the final screen. The UI computes the fingerprint of what was downloaded.

**Mandatory before every kit.** Without the tool, the kit cannot be opened if the service disappears. Every kit delivery (enrollment, rotation with A+C or with the kit, and a new kit for an old kit from `/unlock`, `/activate` or after B+C) goes through `KitDeliverySteps`: two steps in order, with the kit step disabled until the first is complete. It is required on every delivery, including rotations, with no "I already have it" checkbox, so that the user stores the current version next to the kit. It counts as done when `fetchRecoveryTool` receives a 200 whose body starts with `<!doctype html` and the download has been triggered; a network error, another status or a different page shows the error and allows a retry. The state lives in the flow, not in the browser. The static page cannot obtain the tool, because its CSP is `connect-src 'none'`, so it does not deliver kits: it sends the user to the vault. A deployment whose build output lacks the tool cannot complete any enrollment. The build is reproducible: see [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md). `pnpm test:e2e:image` compares what the image serves, built on Linux, with the host build.

### Old kits and rotation

- **New kit for a wallet with a `v: 1` kit:** `upgrade-kit`, from `/unlock` or `/activate` with A+B, or after recovering with B+C in the vault. The code is not stored, so it has to be requested; it is checked by decrypting C and comparing against its digest. It does not create a new set. The tool must be downloaded first, as during enrollment. The static page does not offer this.
- **Rotation does not revoke old kits:** a `v: 2` kit still opens with its old code, and yields the same seed, forever. An e2e test documents this. After rotating, the previous kit and code must be destroyed, and if they have leaked, the user must create another wallet and move the funds.

### Operating with B+C

With B+C, or with the kit and code, the user can sign messages, EIP-712 and UserOperations, and download the seed, in the worker and without any API call. The chain is not queried: the signature is not submitted, and it will only be valid if the Safe is deployed on that network. The screen says so. Every operation reconstructs and discards the seed, and with B+C the passkey is requested again.

Re-enrolling does require the server and a session: that is the "Redo with my kit" tab in `/recover`. The "Without the server" tab still makes no call at all, and it answers the app as soon as it recovers, so it cannot request a token afterwards. A token lasts 60 s and is single-use: `channel.renew()` (`apps/vault/lib/vault-channel.ts`) requests a new one when switching to a tab that opens a session.

### Static recovery page

`apps/vault/static-recovery` and `apps/vault/scripts/build-static-recovery.mjs` (`pnpm --filter ./apps/vault build:static-recovery`). Same components and same `handleWorkerRequest` as `/recover`, with a different entry point: its worker has no network dependencies, and `connect-src 'none'` prevents it from talking to anyone. `--rp-id` and `--manifest-pubkey` are baked into the HTML, because there is no server to deliver them.

**The real RP ID limit.** `RP_ID` is exactly the host of `ORIGIN`, with no parent domain. WebAuthn only accepts that host or a subdomain of it, and the browser enforces this, so the page can only use the passkey when served from `https://vault.example.com` or `https://recovery.vault.example.com`. It works as long as that DNS is under control, with the backend down. An e2e test covers it with a subdomain, and with a different domain the passkey fails.

**If the domain is lost, B stops working for everyone, with no fix.** The only path left is code + seed backup (the offline tool). No page can avoid this: Related Origin Requests are also published on the RP ID's domain.

### Recovery without a kit

Discoverable passkey + code, without a JWT. The server verifies the assertion and returns only `encB`, `encC` and the manifest for that credential, never A. Without the code they are useless, and no session is opened.

**PRF salt: why the problem does not arise here.** The salt must be known before the assertion, and without `allowCredentials` the credential is not known. That would force two touches if the salt were per credential. Here it is a single, fixed, public salt: `packages/core/src/prf.ts` computes it without knowing the credential. Nothing was weakened to save a touch, because it has been this way since enrollment and changing it would make existing B shares unusable. The per-credential secret is supplied by the authenticator: the output is `HMAC(CredRandom of that credential, salt)`, and the same assertion yields both identity and PRF. An e2e test checks that there is a single passkey prompt, without `allowCredentials`. **The PRF output never leaves the browser:** it is copied field by field and `toJSON()` is never used, and another e2e test checks this across all traffic.

**Verification:** [`@simplewebauthn/server`](https://simplewebauthn.dev/) 14.0.3. It is maintained, covers CBOR, COSE and the algorithms already in use (EdDSA, ES256 and RS256), and hand-writing this in a key management system has no advantage. Version 14.0.3 is pinned rather than 14.1.0, which had been published the day before this change. It checks origin, RP ID, challenge, user verification, signature and counter. The vault adds the rest:

- **Challenge:** single-use, with expiry, stored in the database and consumed in a single statement, also across replicas. The registration challenge is bound to the session. It is consumed before verification.
- **Resident credential:** `residentKey: 'required'` at creation. `credProps.rk: false` is rejected, but this is declared by the browser, unsigned: the real guarantee is the former.
- **Counter:** incremented with `UPDATE … WHERE counter = expected`. An authenticator that always returns 0 keeps working, as the specification requires.
- **No enumeration:** a single response, `401 RECOVERY_FAILED`, for challenge, unknown credential, missing key, signature or counter failures. Timing does vary when there is no credential, but ids are random and cannot be guessed.
- **One id, one key:** a unique index prevents registering someone else's credential id with one's own key, which would lock its owner out of this flow.

**Wallets without a public key.** Wallets enrolled before this feature cannot use this flow until they re-enroll, because there is nowhere to get the key from. The migration does not touch them. The screen and the error say so. A passkey that has already been replaced does not work either.

### Relinking to another account

A user who has lost their login creates a new account, with a valid JWT and a `sub` without a wallet, and proves control of the wallet by signing with its owner. **A valid JWT only says who the new `sub` is.**

- **Message:** EIP-712 `WalletRelink` (domain `wl-embedded-wallet/relink-wallet`, version `1`, no `chainId`), with purpose (`wl-embedded-wallet/relink-wallet/v1`), Safe, owner, new `sub`, issuer, vault origin, nonce and expiry. The server rebuilds it from its own values and the browser only supplies nonce and signature, so a signature for another `sub` or another vault recovers a different address.
- **Nonce:** bound to that `sub`, single-use, 5 min, stored in the database. `POST /api/relink/nonce` responds the same whether or not the wallet exists, so it does not reveal which addresses exist.
- **Previous holder:** the nonce records the `sub` that held the wallet when it was issued. If that changes before the nonce is consumed, it is rejected: **of two attempts only one wins, even when one follows the other**. Moving the wallet again requires a new nonce.
- **Atomic:** in one transaction, which in Postgres locks both user rows in a fixed order: consumes the nonce, checks the wallet and the new `sub`, moves all sets, carries over `exported_at`, deletes the previous `sub`'s sessions and writes the audit trail.
- **Audit trail:** `wallet_relinks`, never deleted: Safe, owner, both `sub` values, issuer, vault origin, app origin, nonce, signature and date. The signature is not secret and is the proof. Failed attempts are not recorded: rate limits bound them per IP and per `sub`, but a row per failure would still let anyone with a session grow the table.
- **`manifest.userId` does not change:** it is part of the AAD of B and C and of the key derivation for A, and those envelopes cannot be re-encrypted. It is the `sub` used at encryption time, not the current owner, which is stored in `share_sets.user_id`. `GET /api/shares/a` uses the manifest's value, and `enroll` accepts a `source` from another `sub` only with `linkedOwner`, the owner of the wallet the server says this session holds. The next set is encrypted under the new `sub`. **That is why kits and the passkey keep working after a relink.**
- **One address, one account:** the address is declared by the client, so `POST /api/shares` rejects a new wallet whose owner is active in another account. If two existed anyway, the nonce is created without a previous holder and is rejected: the wrong set is never moved.
- **Accepted risk:** whoever has the kit and code, or the passkey and code, has the seed and can relink the wallet to an account of their own. Relinking adds nothing to what they could already do with the funds, but it does take app access away from the legitimate owner.

## Per-deployment branding

Each deployment runs the same image with its own brand, without rebuilding. Format, validation and mounting are described in [BRANDING.md](BRANDING.md); the visual system is in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

- **A mounted directory, not variables.** `VAULT_BRAND_DIR` points to a directory with `brand.json` and its files (logo, favicon, fonts). Variables are kept to a minimum: the directory and `VAULT_BRAND_NAME`, which overrides the `name` in `brand.json`. JSON in a variable cannot carry fonts or a logo, and many loose variables are harder to validate than a file.
- **Tokens only.** `brand.json` accepts a name, eight colors per scheme, a radius, a font family and font files, a logo, a favicon and three links. No CSS, markup or text: a CSS rule could hide a security warning or make it look like decoration, and warnings are the user's last line of defense. An unknown key is an error, not ignored, so that a `css` or `texts` key never looks accepted.
- **Fixed warning scale.** Caution, danger, success and info have their own colors and icons in `apps/vault/app/globals.css`, which the brand stylesheet does not touch. The brand accent never signals state: it is used for the primary button, the current step and tab, links and focus.
- **Accent kept away from warnings.** A saturated `accent` within 12° of the danger red or within 10° of the caution yellow (50°) is an error: the primary button would read as a warning. Caution is a true yellow, not amber, so that a typical orange brand accent (around 37°) stays clear of it. The success green is not protected: it is not a security warning, and many brands are green.
- **Contrast: an error, except for the ink.** The pairs the deployer picks for text and buttons (`text` and `muted` on background and surface, `accentText` on `accent`) must reach WCAG AA (4.5:1) in light and dark mode, or the vault does not start. Deriving them would silently change a color the deployer chose. The exception is `accentInk`, the accent used as text: a brand accent is often fine as a fill and unreadable as text (a bright orange can give about 2:1 on white), so if it is not given, it is derived from the same hue, darkened or lightened just enough. If it is given, it must also reach AA.
- **Served from memory, by content hash.** Everything is read and validated at startup, and served at `/brand/<sha256[:16]>.<ext>` from an in-memory map: a request never builds a filesystem path, so path traversal is impossible, and caching can be immutable. Paths in `brand.json` are checked when read: relative, no `..` or hidden files, `realpath` inside the directory, extensions per type, size limits per type and in total, and content signature (magic bytes).
- **Logo only as `<img>`.** An SVG in `<img>` does not run scripts or load anything. Opened directly, its response carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff`. In addition, an SVG with scripts, event handlers, `foreignObject`, entities or external references is rejected at startup. It is not rasterized: that would need a native dependency and adds nothing to the above.
- **CSP essentially unchanged.** The brand stylesheet is a same-origin file (`style-src 'self'`), not an inline `<style>`, so no nonce or `'unsafe-inline'` is needed. Only `font-src 'self'` was added; it previously fell under `default-src 'none'`. Trusted Types are untouched.
- **Read once.** Changing the brand requires restarting the container. In production, an invalid brand prevents startup, like an invalid variable; outside production the error is logged and the neutral brand is used.
- **Its own neutral brand.** By default the open-source vault ships a neutral brand: "Vault", grays and a slate accent. `brands/example/` (the fictional "Acme Wallet") is the example brand, used by the development environment, by the e2e vault and by the demo.
- **Unbranded offline tool.** `wl-embedded-wallet-recovery.html` is identical for every deployment: its fingerprint is published outside the vault and users compare it with what they download. With each deployer's brand, every deployment would have a different fingerprint and the comparison would no longer work.
- **Static page branded at build time.** `build-static-recovery.mjs --brand-dir` uses the same validation and the same header and footer components, bundled with esbuild for Node, and places the files next to the HTML. Its CSP uses `img-src 'self'` and `font-src 'self'` for those files; `connect-src` stays `'none'`.

## Smart account

The user's account is a Safe with 4337 modules v0.3.0 and EntryPoint v0.7. The Shamir-split key is its `owner`. `expectedAddress` in the manifest is still the owner, while `address` in the worker, popup and s2s responses is the Safe.

### States and gating

Not activated → activated but not deployed → deployed. Deployment is per network and is read on-chain by the vault server. The real gate is not the UI: the `/sign` screen and, independently, the worker query `/api/aa/status`, and if the Safe is not deployed on that network they respond `WALLET_NOT_DEPLOYED` before requesting A or using the seed.

### Invariant: the same address on every network

- The address depends only on the owner and fixed init parameters. Nothing that varies per network goes into the init data or the salt.
- `manifest.smartAccount` carries, signed, `type`, `safeModulesVersion`, `entryPoint`, `factory`, `singleton`, `singletonInitHash`, `safe4337Module`, `safeModuleSetup`, `multisend`, `saltNonce` and `address`. Everything is computed from there, not from constants: a future upgrade does not change the address of existing users, and a rotation keeps the parameters of the active wallet.
- The worker recomputes the Safe from the owner on every recovery and aborts with `ADDRESS_MISMATCH`. `POST /api/shares` requires the current parameters and the same address computed by WDK for a new wallet, and the active wallet's parameters for a rotation.
- Before declaring `deployable`, the server checks on that network that the factory, singleton, module, setup and EntryPoint have code, and performs an `eth_call` to `createProxyWithNonce` with the real `factoryData`, requiring exactly the predicted address (`apps/vault/server/safe-check.ts`). Otherwise `CHAIN_NOT_SUPPORTED`, and a different address is never shown.

### Dependencies: spike outcome

- `@tetherto/wdk-wallet-evm-erc-4337@1.0.0-beta.24` **cannot be bundled into the worker**: Turbopack cannot resolve `sodium-native`, which comes in through `@tetherto/wdk-wallet-evm`. It would also pull in `ethers`.
- The browser uses `abstractionkit@0.4.0` directly (`packages/core/src/safe.ts`), the exact version WDK pins, and without `ethers`. Tests check that it produces the same address as WDK.
- WDK is used only on the server (`serverExternalPackages`), as a check when the wallet is created.
- Worker size, measured at the time: 233 KB (86 KB gzip) before, 334 KB (114 KB gzip) after.

### Signing

- **Messages and EIP-712:** these are Safe signatures. The owner signs `SafeMessage(bytes message)` over the hash, with the domain `{ chainId, verifyingContract: safe }`. They are verified with `isValidSignature(bytes32,bytes)` on the contract. `Safe4337Module` inherits the compatibility fallback handler, so it supports this: verified against the real bytecode. A signature for one network reverts on another.
- **UserOperation:** `sender` is the Safe, it never carries a `factory`, and the EIP-712 hash of `SafeOp` is signed without submitting it. The key never leaves the worker: signing uses an external signer from `abstractionkit`.
- **Deployment:** `factory`, `factoryData` and an empty, zero-value call to the Safe itself. The worker rejects any other operation before using the seed. It is prepared before requesting the passkey, because some browsers require the passkey prompt inside the user gesture.

### Proxy

The bundler and paymaster are contacted only from the server, with `connect-src 'self'` left intact. `POST /api/aa/rpc` requires a session and admits three methods: `vault_prepareDeployment`, `eth_sendUserOperation` and `eth_getUserOperationReceipt`.

It is not a relay. **The server builds the deployment** of the session's own Safe, on the session's network, not yet deployed: fees from the node with the bundler's gas price quote as a floor, gas from the bundler's estimate and the paymaster fields from the paymaster, each within caps (`AA_MAX_*`, or `AA_CHAINS[chainId].limits` per chain). It records that operation and returns it unsigned. `eth_sendUserOperation` then accepts only that exact operation with the owner's signature, and forwards it once per Safe and chain; the same operation sent again gets the recorded hash back. Receipts are only for that hash. Anything else gets `OPERATION_NOT_ALLOWED` or `METHOD_NOT_ALLOWED`. The sponsorship context is set by the server. URLs never appear in logs or errors, because they may contain an API key. Calls are rate limited per IP and per `sub`.

Why the server builds it: when the browser built the operation and the server checked only `sender`, `factory`, `factoryData`, `callData` and `nonce`, a session could choose the gas limits, the fees and the paymaster fields of a sponsored operation, and so how much of the paymaster's budget it spent. Validating every field the browser sent would have meant re-deriving them all on the server anyway.

Paymaster via ERC-7677, called by the server: `pm_getPaymasterStubData` → estimation → `pm_getPaymasterData`, then the page signs. `abstractionkit@0.4.0` also uses this interface in `Erc7677Paymaster`; that class is not used. Without a `paymasterUrl`, the server builds the same operation without paymaster fields, the screen says so and the Safe must hold funds, or `INSUFFICIENT_FUNDS`.

## Multichain

Every operation that touches a chain specifies its network: `deploy`, `signMessage`, `signTypedData` and `signUserOperation` take `chain: { chainId, rpcUrl? }`. The Safe has the same address on all of them, and deployment and its status are per network.

### RPC provenance

A compromised app or an XSS must not be able to choose the RPC or make the vault server connect wherever it wants (SSRF).

1. The network and `rpcUrl` go into the token signed by the integrator's backend. `getToken` receives the network, and the popup only carries `chainId`. The demo's `POST /api/vault/token` accepts `{ chainId }` and resolves the RPC on its server from `DEMO_CHAINS`.
2. `POST /api/auth/handoff` rejects with `CHAIN_REQUEST_MISMATCH` if the popup's `chainId` is not the token's. The network is stored in the session, because the `jti` is single-use and later routes need it. A token without a network clears it.
3. Precedence in the vault: if `AA_CHAINS[chainId].rpcUrl` exists, it is used and the token's is ignored. This is what must be used with an API key, because the token passes through the browser. Otherwise the token's RPC is used, only over HTTPS (HTTP only for local hosts), without credentials and with its host in `RPC_ALLOWED_HOSTS`. 10 s timeout, 1 MB maximum, redirects are not followed. Without a valid RPC: `CHAIN_NOT_SUPPORTED`, with no connection made.
4. Before using an RPC, `eth_chainId` must match: otherwise `CHAIN_MISMATCH`.

### Configuration

`AA_CHAINS` is a JSON object keyed by `chainId` with `name?`, `rpcUrl?`, `bundlerUrl`, `bundlerHeaders?`, `paymasterUrl?`, `paymasterHeaders?` and `paymasterContext?`. Without a bundler for a network, deployment returns `CHAIN_NOT_SUPPORTED`, but signing still works if the Safe is already deployed.

### Testing with real contracts

`apps/vault/tests/aa-stack/` starts local networks with `anvil` and the real Safe, module and EntryPoint bytecode copied from Sepolia (`fetch-contracts.mjs`, read-only). It includes a small bundler and paymaster that speak JSON-RPC and really execute `EntryPoint.handleOps`, with a real paymaster contract and a deposit in the EntryPoint. The bundler does not estimate: it returns fixed limits. `pnpm test:aa` tests it without a browser, and `pnpm aa:stack` keeps it running (ports 21545-21547) for `pnpm dev`, with the values `pnpm setup:env` already writes. See [TESTING.md](TESTING.md).

## Deployment

The vault ships as a generic Docker image. Each deployer configures it through the environment, with one deployment per integrator. See [DEPLOYMENT.md](DEPLOYMENT.md).

- **Database:** `DATABASE_URL` with `postgres://` in production. `sqlite:` or unset is only accepted outside production. `apps/vault/server/store/` is an async interface (`VaultStore`) with a single SQL dialect and two drivers. Operations that depend on atomicity (single-use `jti`, set activation) must remain atomic with multiple replicas.
- **Migrations:** versioned, run at startup and protected by an advisory lock in Postgres.
- **Runtime configuration:** there are no `NEXT_PUBLIC_*` variables in the vault anymore. The server passes the RP ID and the manifest public key into the HTML. The main thread hands it to the worker. An API call is not used, because B+C must make none.
- **Trade-off versus the build-time version:** the public key is no longer pinned in the bundle, but this is not worse in practice: whoever controls the server already controls the JavaScript it serves. It still protects against a database-only compromise, because the key is not stored there.
- **Safe startup:** in production, if a required variable is missing or invalid, the process exits with a message that names the variable and never its value. No default values for keys. `ORIGIN` must be HTTPS, except for local hosts.
- **Integrator:** `HANDOFF_JWKS_URL` and `HANDOFF_ISSUER` identify the app, without the vault knowing anything about the demo.

### Concurrency

- **Set activation:** in a transaction that locks the user row, with a partial unique index allowing a single active set. Without the lock, a second concurrent activation would fail against the index instead of waiting. This also fixes an earlier bug: with two pending sets for different addresses, activating the second one replaced the wallet. Now it stays `pending` and the API responds `409 WALLET_ALREADY_EXISTS`.
- **`jti`:** a single `INSERT ... ON CONFLICT` statement, with exactly one winner.
- **`createSet`:** returns `null` if the `setId` already exists, and the API responds `409`.

### Migrations

They live in code (`apps/vault/server/store/migrations/`), not in `.sql` files, so they always make it into the `standalone` output. They are applied in a transaction with `pg_advisory_xact_lock`: a transaction-level lock also works behind a pooler, unlike a session-level one. An older vault version refuses to start on a newer schema.

### Vault environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MASTER_KEY` | Yes | 32 bytes in hex |
| `MANIFEST_SIGNING_KEY` | Yes | Ed25519 private key, 32 bytes in hex. The public key is derived from it |
| `HANDOFF_JWKS_URL` | Yes, or `HANDOFF_PUBLIC_KEY` | The integrator's JWKS |
| `HANDOFF_ISSUER` | Yes | Exact `iss` |
| `HANDOFF_AUDIENCE` | No | Exact `aud`. Defaults to `ORIGIN` |
| `HANDOFF_PUBLIC_KEY` | Alternative | Fixed Ed25519 key |
| `HANDOFF_JWKS_CACHE_SECONDS`, `HANDOFF_JWKS_COOLDOWN_SECONDS`, `HANDOFF_JWKS_MAX_STALE_SECONDS` | No | 300, 30 and 3600 |
| `VAULT_SERVICE_TOKEN` | Yes | At least 32 characters |
| `ORIGIN` | Yes | HTTPS, no path |
| `RP_ID` | Yes | Exactly the host of `ORIGIN`. A parent domain would allow requesting the passkey from any subdomain |
| `ALLOWED_APP_ORIGINS` | No | Additional restriction: comma-separated HTTPS origins |
| `DATABASE_URL` | Yes (production) | `postgres://`. SSL is controlled in the URL with `sslmode` |
| `DATABASE_POOL_SIZE` | No | Connections per replica, 10 by default (5 on Vercel) |
| `AA_CHAINS` | No | See "Multichain" |
| `RPC_ALLOWED_HOSTS` | No | See "Multichain" |
| `VAULT_BRAND_DIR` | No | Brand directory with `brand.json`. See "Per-deployment branding" |
| `VAULT_BRAND_NAME` | No | Name in the UI and on the passkey. Overrides the one in `brand.json`. "Vault" by default |
| `ALLOW_INSECURE_LOCAL` | No | `1`, for testing only: allows `http` on local hosts and SQLite |

### `standalone` output

`pnpm build` produces `.next/standalone/apps/vault/server.js`. Static assets are not included: `.next/static` must be copied to `.next/standalone/apps/vault/.next/static`, as `pnpm --filter ./apps/vault start` does (`apps/vault/scripts/start-standalone.mjs`). The only supported way to start it is `node server.js`, with `PORT` and `HOSTNAME`. It contains no `.env` file.

WDK loads the native `sodium-native` addon on import and Next's file tracing does not see it, so `outputFileTracingIncludes` adds its Linux and macOS binaries. Any other platform would fail when creating wallets.

### Image

- `apps/vault/Dockerfile` builds inside the image, and the final stage only carries the `standalone` output, its static assets and `scripts/generate-secrets.mjs`, without `pnpm` or any demo code. Built locally it is tagged `wl-embedded-wallet-vault:local`; the Compose project is `wl-embedded-wallet`.
- Base images pinned by digest. Runs as non-root, and `compose.yaml` adds a read-only filesystem, `cap_drop: ALL` and `no-new-privileges`.
- `generate-secrets.mjs` writes the handoff private key to stderr, so that `> .env` never stores it next to the vault.
- The e2e tests use the `rpc.localhost` alias, not `host.docker.internal`: validation only allows `http` on local hosts, and the alias resolves on the host and, through `extra_hosts`, inside the container. The token-supplied RPC cannot be tested with host networks from inside the container, so in that mode the networks use the `rpcUrl` from `AA_CHAINS`. The token path remains covered by `pnpm test:e2e`.
- `SERVER_KEY_MISMATCH` identifies a `MASTER_KEY` that does not decrypt the server's data, with a log warning for the operator that does not include the key.
