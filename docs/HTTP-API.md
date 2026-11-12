# Vault HTTP API

This is the reference for every HTTP route the vault (`apps/vault`) serves outside its HTML pages. It is written from the route handlers in `apps/vault/app/**/route.ts` and the helpers in `apps/vault/server/`. Where the code is the authority, the file is named.

- How the integrator obtains and hands over the token, and the `postMessage` protocol between the app and the popup: [PROTOCOL.md](PROTOCOL.md).
- What the shares, envelopes and manifests contain: [CRYPTO-SPEC.md](CRYPTO-SPEC.md).
- Where the vault sits in the system: [ARCHITECTURE.md](ARCHITECTURE.md). What each route is trusted with: [THREAT-MODEL.md](THREAT-MODEL.md).
- How to configure the variables this document refers to: [DEPLOYMENT.md](DEPLOYMENT.md#environment-variables).

The HTML pages (`/`, `/activate`, `/deploy`, `/export`, `/recover`, `/relink`, `/sign`, `/transaction`, `/unlock`) are not covered here. They render the popup UI and receive their public configuration in the page itself (`data-rp-id`, `data-manifest-pubkey` and `data-brand` on `#vault-config`; see `apps/vault/lib/runtime-config.ts`).

## Route index

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | [`/api/auth/handoff`](#post-apiauthhandoff) | Handoff JWT + `Origin` | Redeem a handoff token and open a session |
| `POST` | [`/api/webauthn/challenge`](#post-apiwebauthnchallenge) | Session | Challenge for registering the passkey |
| `POST` | [`/api/shares`](#post-apishares) | Session | Store a new share set (enrollment or rotation) |
| `GET` | [`/api/shares`](#get-apishares) | Session | Read the active set, or one set by id |
| `PATCH` | [`/api/shares`](#patch-apishares) | Session | Activate a pending set |
| `GET` | [`/api/shares/a`](#get-apisharesa) | Session | Release share A in plaintext |
| `POST` | [`/api/shares/exported`](#post-apisharesexported) | Session | Record that the user exported the seed |
| `GET` | [`/api/aa/status`](#get-apiaastatus) | Session | Status of the user's Safe on the session's chain |
| `POST` | [`/api/aa/rpc`](#post-apiaarpc) | Session | Server-built deployment and transactions: prepare, send, receipt |
| `POST` | [`/api/relink/nonce`](#post-apirelinknonce) | Session | Start moving an existing wallet to this account |
| `POST` | [`/api/relink`](#post-apirelink) | Session + owner signature | Move the wallet to this account |
| `POST` | [`/api/recovery/passkey/challenge`](#post-apirecoverypasskeychallenge) | `Origin` only | Challenge for kit-free recovery |
| `POST` | [`/api/recovery/passkey`](#post-apirecoverypasskey) | WebAuthn assertion + `Origin` | Kit-free recovery: returns `encB`, `encC`, manifest |
| `GET` | [`/api/s2s/accounts/{sub}`](#get-apis2saccountssub) | Service bearer token | Integrator backend: a user's wallet address and chain state |
| `GET` | [`/api/health`](#get-apihealth) | None | Liveness and database check |
| `GET` | [`/recovery-tool`](#get-recovery-tool) | None | Download the offline recovery tool |
| `GET` | [`/brand/{file}`](#get-brandfile) | None | Brand stylesheet, fonts, logo and favicon |

## Common conventions

### Base URL and runtime

All routes are relative to the vault origin, the value of `ORIGIN` (for example `https://vault.example.com`). Every route handler runs on the Node.js runtime (`export const runtime = 'nodejs'`). `/recovery-tool` and `/brand/{file}` are also `force-dynamic`. The routes that call upstream services (`/api/aa/rpc`, `/api/aa/status`, `/api/shares`, `/api/s2s/accounts/{sub}`, `/api/auth/handoff`) set `maxDuration = 60` seconds, which only matters on serverless hosts such as Vercel.

A method that a route does not export is answered by Next.js itself, not by vault code.

### Request bodies

- Bodies are JSON. `readJson` (`server/http.ts`) parses the body and accepts only a JSON object. An array, a scalar, invalid JSON or an empty body counts as "no body", which each route reports as its own validation error (usually `INVALID_BODY`).
- The `Content-Type` request header is not checked. The vault's own client always sends `application/json`.
- `readJson` caps the body at 128 KiB (`MAX_JSON_BODY_BYTES`). It rejects a larger `Content-Length` before reading, and also counts the bytes as they arrive, because the header can be missing or wrong; it stops reading at the cap. Over the cap: `413 PAYLOAD_TOO_LARGE`, on every route that reads a body. The largest legitimate body, `POST /api/shares` with every field at its limit, is about 102 KiB. Fields that matter also have their own length limits (listed per route).
- Each route reads the body only after its origin, session and rate-limit checks, so a `413` comes after those errors.

### Responses and the error shape

- Responses built with the `json()` helper carry `Cache-Control: no-store`. That covers every JSON response, success or error.
- An error the vault produces on purpose has the shape `{ "error": "<CODE>" }`, with a stable upper-case code and no other detail. The only exception is `UPSTREAM_ERROR` from `/api/aa/rpc`, which adds `rpcMessage`.
- Two codes can come from most routes and are not repeated in every table: `429 RATE_LIMITED` ([Rate limiting](#rate-limiting)) and `413 PAYLOAD_TOO_LARGE` ([Request bodies](#request-bodies)). Each route section says whether it has them.
- Several routes deliberately return one undifferentiated code for many failure causes (`INVALID_TOKEN`, `RECOVERY_FAILED`, `RELINK_REJECTED`) so the response does not reveal which check failed.
- An exception that a route does not catch (a database outage, for example) ends as a 500 generated by Next.js, without the JSON error shape.

### Origin checks (CSRF) and CORS

`originError(request, { write })` in `server/http.ts` runs first on every browser-facing `/api/*` route except `/api/health` and `/api/s2s/*`:

- **Writes** (`POST`, `PATCH`): the `Origin` request header must be present and exactly equal to `ORIGIN`. Otherwise: `403 FORBIDDEN_ORIGIN`.
- **Reads** (`GET`): a missing `Origin` header is accepted, because browsers omit it on same-origin `GET`. If it is present, it must equal `ORIGIN`. Otherwise: `403 FORBIDDEN_ORIGIN`.

The vault emits no CORS headers (`Access-Control-*`) and handles no `OPTIONS` preflight. The browser API is meant to be called only by the vault's own pages and worker, from the vault origin. The integrator app never calls it directly: it talks to the popup through `postMessage` ([PROTOCOL.md](PROTOCOL.md)).

### Authentication mechanisms

| Mechanism | Where | How it is checked |
|---|---|---|
| **Handoff JWT** | Body of `POST /api/auth/handoff` | Signature against `HANDOFF_JWKS_URL` (EdDSA, ES256 or RS256, `kid` required) or the fixed `HANDOFF_PUBLIC_KEY` (EdDSA only); `iss`, `aud`, lifetime, claim shapes, the app origin, and a single-use `jti`. See `server/handoff.ts` and [PROTOCOL.md](PROTOCOL.md). |
| **Session cookie** | `__Host-vault_session` | Opaque token (32 random bytes, base64url) looked up in the `sessions` table and not expired. Set by `POST /api/auth/handoff` with `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`. |
| **App-origin binding** | `X-Vault-App-Origin` request header | Must equal the app origin stored in the session when the token was redeemed. Checked together with the cookie by `requireSession`. |
| **Service bearer token** | `Authorization: Bearer <token>` | Compared with `VAULT_SERVICE_TOKEN` in constant time (both sides are SHA-256 hashed and compared with `timingSafeEqual`, so the length does not leak either). Only `/api/s2s/*`. |
| **WebAuthn assertion** | Body of `POST /api/recovery/passkey` | Verified with `@simplewebauthn/server` against the stored public key, `ORIGIN`, `RP_ID`, a single-use server challenge, user verification and the signature counter. |

**"Session" in this document** means `requireSession` passes:

1. The `__Host-vault_session` cookie is present and names a session that exists and has not expired. Otherwise: `401 UNAUTHORIZED`.
2. The session has an app origin and the `X-Vault-App-Origin` header equals it exactly. Otherwise: `403 ORIGIN_MISMATCH`.

The origin check above always runs before the session check, so a request can fail with `403 FORBIDDEN_ORIGIN` before the cookie is looked at.

A session lasts 15 minutes from its creation (`SESSION_TTL_MS`). It is not extended by use. Within that window it can be used for many requests, within the [rate limits](#rate-limiting) and the share A release budgets: the handoff token is single-use, the session is not. The session also stores the chain from the token (`chainId` and optional `rpcUrl`), which `/api/aa/*` uses.

### Security headers

Two places add response headers:

- **`next.config.mjs`**, on every path (`/:path*`), in development and production: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, and `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)`. Outside the development server, `/_next/static/*` also gets the worker CSP: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'none'` (a worker's CSP comes from its script response, not from the page).
- **`proxy.ts`** (Next.js middleware), **only when `NODE_ENV=production`**, on every path except `api/`, `_next/static`, `_next/image`, `favicon.ico` and `brand/`: a `Content-Security-Policy` with a fresh 16-byte nonce per request, and `Strict-Transport-Security: max-age=31536000` when `ORIGIN` is `https`:

  ```
  default-src 'none'; script-src 'self' 'nonce-<nonce>' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self';
  worker-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
  require-trusted-types-for 'script'; trusted-types default
  ```

  The nonce is passed to Next.js through the `x-nonce` request header for its inline scripts. In development the CSP is not applied, because Next.js needs `eval` and hot reload.

  The proxy does not run on `/api/`: Next.js buffers the body of every request the proxy sees (up to 10 MB) before the route runs, which would defeat the body cap of `readJson`. API responses therefore carry no `Content-Security-Policy` (they are JSON).
- **`json()`** in `server/http.ts`, on every JSON response, with `NODE_ENV=production` and an `https` `ORIGIN`: `Strict-Transport-Security: max-age=31536000`.

`/brand/{file}` sets its own CSP and headers (see [below](#get-brandfile)). HSTS has no `includeSubDomains` and no `preload`; add them at the TLS proxy if you want them ([DEPLOYMENT.md](DEPLOYMENT.md#domain-and-tls)).

### Rate limiting

`rateLimit` (`server/rate-limit.ts`) counts each request against its route's scope: one budget per client IP (`<scope>:ip:<ip>`) and, once the `sub` is known, one per `sub` (`<scope>:sub:<sub>`). Budgets are fixed windows, 60 seconds by default, counted with one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` in the `rate_limits` table, so they hold across replicas. The scopes, their routes and their defaults are in [DEPLOYMENT.md](DEPLOYMENT.md#rate-limits); `RATE_LIMITS` overrides them.

Over a budget, the response is:

```
HTTP/1.1 429
Retry-After: <seconds until the window ends, at least 1>
Cache-Control: no-store

{ "error": "RATE_LIMITED" }
```

- **Client IP:** chosen by `CLIENT_IP_SOURCE`. With `socket` (the default), the socket's peer address, which the `peer-address.cjs` preload writes into `x-vault-peer-address` (replacing any client copy); `X-Forwarded-For` is read only when the peer is in `TRUSTED_PROXIES`: the right-most entry that is not a trusted proxy (the peer if that entry is not an IP). Without the preload every client is `unknown` and shares one budget; production refuses to start without it. With `vercel`, only inside a Vercel function (`VERCEL=1` and `VERCEL_REGION`), the `x-real-ip` header, which the Vercel edge overwrites; `X-Forwarded-For` and the peer header are not read, and a missing or invalid value is `unknown`. `vercel` outside Vercel trusts no header: every client is `unknown`. IPv6 is keyed by its /64; IPv4-mapped IPv6 counts as IPv4 ([DEPLOYMENT.md](DEPLOYMENT.md#client-addresses-behind-a-proxy)).
- **Order:** the per-IP budget is counted after the `Origin` check and before anything costly (signature checks, the body, the bearer token); the per-`sub` budget once the `sub` is authenticated. The budgets depend only on the request, never on whether an account or set exists.
- **Other budgets** answer with the same `429`: share A releases per session and per user ([`GET /api/shares/a`](#get-apisharesa)) and the global cap on live recovery challenges ([`POST /api/recovery/passkey/challenge`](#post-apirecoverypasskeychallenge)).
- Not limited: `GET /api/shares`, `POST /api/shares/exported`, `/api/health`, `/recovery-tool` and `/brand/{file}`.

### Lifetimes of server-side state

| State | Table | Lifetime | Purged |
|---|---|---|---|
| Session | `sessions` | 15 minutes, fixed | Expired rows when a session is created |
| Used `jti` | `used_jti` | Until the token's `exp` | Expired rows when another `jti` is consumed |
| WebAuthn challenge, `register` | `webauthn_challenges` | 15 minutes, bound to the user | Expired rows when a challenge is created; the row is deleted when spent |
| WebAuthn challenge, `recover` | `webauthn_challenges` | 5 minutes, no user | Same |
| Relink nonce | `relink_nonces` | 5 minutes, bound to the new `sub` | Expired rows when a nonce is created; deleted when used by `POST /api/relink` |
| Rate-limit counter | `rate_limits` | Until its window ends | Expired rows, at most once a minute per process and 1000 at a time, when a request is counted |
| Sponsored deployment | `sponsored_deployments` | One row per Safe and chain: `prepared`, `submitting` (stale after 60 s), `sent` (blocks a new deployment for `AA_DEPLOYMENT_RETRY_SECONDS`) | Never; a new prepare replaces the row when allowed |
| Prepared transaction | `prepared_transactions` | One row per chain, Safe and operation hash: `prepared` (sendable for 10 minutes, `TRANSACTION_TTL_MS`), `submitting` (stale after 60 s), `sent` (keeps its `userOpHash` for receipts) | `prepared` rows past the TTL, of any Safe, when a transaction is prepared; `sent` rows never |
| Share A release | `share_a_releases` | Permanent audit trail | Never |
| Relink | `wallet_relinks` | Permanent audit trail | Never |

## Session routes

### `POST /api/auth/handoff`

Redeems a handoff token issued by the integrator's backend and opens a vault session for that user. The popup calls it with the token it received over `postMessage` (`exchangeHandoff` in `lib/vault-api.ts`).

**Auth:** `Origin` must equal `ORIGIN`; the handoff JWT in the body.

**Request body**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `token` | string | Yes | The handoff JWT. |
| `origin` | string | Yes | The app origin as the browser reported it (`MessageEvent.origin` of the `postMessage`). It must normalize to exactly the token's `origin` claim. |
| `chainId` | number | Only if the token has a `chain` claim | Must be strictly equal to the token's `chain.chainId`. Omitted (or `null`) when the token has no `chain`. |

Before anything else: the `Origin` check, then the per-IP `handoff` budget (before the body is read and the signature is checked, because forged tokens cost signature checks and JWKS refreshes), then the body.

**Token checks** (`checkHandoffRequest` and `spendHandoffToken` in `server/handoff.ts`), in order:

1. Signature, algorithm, `iss` = `HANDOFF_ISSUER`, `aud` = `HANDOFF_AUDIENCE` (or `ORIGIN` when unset), required claims `iss`, `aud`, `sub`, `jti`, `iat`, `exp`, and `exp` not in the past.
2. Claim shapes: `sub` and `jti` match `^[A-Za-z0-9_-]{1,64}$`; `label` is a string of at most 256 UTF-16 code units with no control characters (`\p{Cc}`; format characters such as bidirectional controls are accepted); `iat` and `exp` are integers; `origin` is an acceptable origin (HTTPS, or HTTP on a local host when insecure local mode is on; no path, query, fragment or credentials); the optional `chain` is `{ chainId: positive safe integer, rpcUrl?: string of at most 2048 characters }`.
3. Lifetime: `iat` at most 30 seconds in the future, `exp - iat` at most 120 seconds, and `exp - now` at most 120 seconds.
4. `origin` in the body, normalized, equals the `origin` claim.
5. If `ALLOWED_APP_ORIGINS` is set, the `origin` claim is in it.
6. `chainId` in the body equals the token's `chain.chainId` (both absent also matches).
7. The per-`sub` `handoff` budget.
8. The `jti` is consumed atomically (`INSERT ... ON CONFLICT`): only the first redemption succeeds, even with concurrent requests or several replicas.

A token rejected in steps 1 to 7, including by the per-`sub` limit, does not spend its `jti` and can still be redeemed by a correct request.

**Response `200`**

```json
{ "userId": "<sub>", "label": "<label>", "origin": "<app origin>" }
```

with `Set-Cookie: __Host-vault_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`. The client keeps `origin` and sends it back as `X-Vault-App-Origin` on every later call.

**Errors**

| Status | Code | When |
|---|---|---|
| 403 | `FORBIDDEN_ORIGIN` | `Origin` header missing or not `ORIGIN`. |
| 401 | `INVALID_TOKEN` | `token` is not a string, or any check in steps 1 to 3 or 8 fails: bad signature, unknown `kid`, disallowed algorithm, wrong issuer or audience, expired, malformed claims, replayed `jti`, or the JWKS is unavailable with no usable cache. The cause is not disclosed. |
| 403 | `ORIGIN_MISMATCH` | Step 4: the body `origin` does not match the signed `origin`. |
| 403 | `ORIGIN_NOT_ALLOWED` | Step 5: the signed `origin` is not in `ALLOWED_APP_ORIGINS`. |
| 400 | `CHAIN_REQUEST_MISMATCH` | Step 6: `chainId` in the body differs from the token's `chain.chainId` (including one present and the other absent). The token is not spent. |
| 429 | `RATE_LIMITED` | The per-IP budget (before the body), or step 7. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 128 KiB. |

**Side effects**

- The token's `jti` is recorded in `used_jti` until the token's `exp`.
- `users`: the row for `sub` is inserted, or its `label` is updated.
- If the request carries a previous `__Host-vault_session` cookie, that session is deleted. Each token opens its own session; a session never carries over to another `sub`.
- `sessions`: a new row with the user, the app origin, the 15-minute expiry, and the token's `chain` (or none).

**JWKS fetching** (`server/jwks.ts`), when `HANDOFF_JWKS_URL` is used: 5-second timeout, 64 KiB maximum document, redirects are rejected, and a document that contains private or symmetric key material (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`, or `kty: oct`) is rejected and also invalidates the cache. The last good document is reused while the JWKS is unreachable, for at most `HANDOFF_JWKS_MAX_STALE_SECONDS`. Refresh and cooldown intervals come from `HANDOFF_JWKS_CACHE_SECONDS` and `HANDOFF_JWKS_COOLDOWN_SECONDS`.

### `POST /api/webauthn/challenge`

Issues the challenge for creating the user's passkey during enrollment. `POST /api/shares` spends it when it stores the passkey's public key.

**Auth:** session.

**Request body:** none.

**Response `200`**

```json
{ "challenge": "<base64url, 32 random bytes>" }
```

**Errors:** `403 FORBIDDEN_ORIGIN`, `401 UNAUTHORIZED`, `403 ORIGIN_MISMATCH`, `429 RATE_LIMITED` (`enroll` scope, per IP and per `sub`, shared with `POST` and `PATCH /api/shares`).

**Side effects:** inserts a `webauthn_challenges` row with purpose `register`, bound to the session's user, valid for 15 minutes. Expired challenges are deleted first.

### `POST /api/shares`

Stores a new share set: on first enrollment, and on every rotation (re-enrollment). The signer worker calls it (`postShares` in `lib/signer.worker.ts`). The set is created as `pending`; [`PATCH /api/shares`](#patch-apishares) activates it.

**Auth:** session.

**Request body** (`CreateSharesBody` in `packages/core/src/types.ts`)

| Field | Type | Validation |
|---|---|---|
| `setId` | string | UUID (versions 1 to 8, lowercase hex). |
| `credentialId` | string | base64url, at most 1024 characters. |
| `shareA` | string | Share A in lowercase hex, an even number of digits, at most 256 characters. **Sent in plaintext**; the server seals it. |
| `encB` | object | Envelope with `v: 1`, `share: "B"`, `kdf: "prf-hkdf-sha256"`, string `userId`, string `setId` of at most 64 characters, object `kdfParams`, and base64url `salt`, `iv`, `ct` (at most 4096 characters each). |
| `encC` | object | Same, with `share: "C"` and `kdf: "argon2id"`. |
| `shareDigests` | object | `A`, `B`, `C`: SHA-256 digests in lowercase hex (64 characters). |
| `expectedAddress` | string | An EVM address (`viem` `isAddress`). This is the **owner** (the Shamir-protected key), not the Safe. |
| `smartAccount` | object | The Safe parameters and address (`SmartAccountInfo`). |
| `wdkUtilsVersion` | string | `^[0-9A-Za-z.+-]{1,64}$`. |
| `registration` | object | Optional. The `navigator.credentials.create` result as JSON (`RegistrationJson`). Without it, no public key is stored and the set cannot be used for [kit-free recovery](#post-apirecoverypasskey). |

A body that contains a `seedBackup` key is rejected: the seed backup lives only in the user's kit.

**Checks, in order**

1. Shape validation above. Then `encB.userId`, `encC.userId` must equal the session's user and `encB.setId`, `encC.setId` must equal `setId`.
2. `sha256(shareA)` must equal `shareDigests.A`.
3. No set with that `setId` exists for this user.
4. If the user already has an active set (a rotation), `expectedAddress` must be the same owner address, and `smartAccount` must canonicalize to exactly the active set's `smartAccount`.
5. If the user has no active set (a new wallet), no other user may have an active set with that owner, and `smartAccount` must equal the current default Safe parameters for that owner and the address that WDK's `predictSafeAddress` computes (`server/safe-check.ts`).
6. If `registration` is present: it is verified last, because verification spends the `register` challenge (an earlier failure can be retried without repeating the passkey ceremony). Checks: `type: "public-key"`, `rawId === id`, `id === credentialId`, field length limits, `credProps.rk` not `false`, the challenge was issued to this user for `register` and not expired, origin = `ORIGIN`, RP ID = `RP_ID`, user presence and user verification.

**Response `201`:** the signed manifest.

```json
{ "manifest": { "v": 1, "userId": "...", "setId": "...", "...": "..." }, "signature": "<base64url Ed25519 signature>" }
```

The manifest is built and signed by the server with `MANIFEST_SIGNING_KEY` (`buildManifest` and `signManifest` in `packages/core`). Its format is in [CRYPTO-SPEC.md](CRYPTO-SPEC.md).

**Errors**

| Status | Code | When |
|---|---|---|
| 403 | `FORBIDDEN_ORIGIN`, `ORIGIN_MISMATCH` | See [conventions](#origin-checks-csrf-and-cors). |
| 401 | `UNAUTHORIZED` | No valid session. |
| 400 | `INVALID_BODY` | Missing body, `seedBackup` present, or any shape check fails. |
| 400 | `ENVELOPE_MISMATCH` | Envelope `userId` or `setId` does not match. |
| 400 | `DIGEST_MISMATCH` | `shareA` does not hash to `shareDigests.A`. |
| 409 | `SET_EXISTS` | The `setId` already exists (for this user, or globally at insert time). |
| 409 | `WALLET_ALREADY_EXISTS` | Rotation with a different owner address, or a new wallet whose owner already belongs to another user (that case is handled by [relinking](#post-apirelinknonce)). |
| 400 | `SMART_ACCOUNT_MISMATCH` | `smartAccount` is not the active set's (rotation) or not the current default for that owner (new wallet). |
| 400 | `CREDENTIAL_INVALID` | `registration` fails verification. The reason is not disclosed. |
| 429 | `RATE_LIMITED` | `enroll` scope, per IP and per `sub`, counted before the body is read. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 128 KiB. |

**Side effects:** spends the `register` challenge when `registration` is present (even if verification then fails). Seals `shareA` with the KMS stub (`sealShareA` in `server/kms.ts`: AES key derived by HKDF from `MASTER_KEY` with info `wl-embedded-wallet/share-a/kms/v1|<userId>|<setId>`). Inserts a `share_sets` row with status `pending`, the manifest, the signature, `enc_a`, `enc_b`, `enc_c`, the owner address in lowercase, `created_session_hash` (the SHA-256 of this session's token, which decides who may fetch share A while the set is `pending`), and, when registered, the credential public key and counter.

### `GET /api/shares`

Returns the user's active set, or a specific set.

**Auth:** session.

**Query**

| Parameter | Type | Meaning |
|---|---|---|
| `setId` | UUID | Optional. Without it, the active set is returned. With it, that set (pending or active) if it belongs to the session's user. |

**Response `200`**

```json
{
  "setId": "...",
  "status": "pending | active",
  "encB": { "...": "envelope" },
  "encC": { "...": "envelope" },
  "credentialId": "...",
  "manifest": { "...": "..." },
  "signature": "...",
  "exportedAt": "<ISO 8601> | null"
}
```

Share A is never part of this response. `exportedAt` is the user's last recorded seed export.

**Errors:** `403 FORBIDDEN_ORIGIN`, `401 UNAUTHORIZED`, `403 ORIGIN_MISMATCH`, `400 INVALID_SET_ID` (`setId` present but not a UUID), `404 NOT_FOUND` (no active set, or no such set for this user), `410 REVOKED` (the set was replaced by a rotation).

**Side effects:** none.

### `PATCH /api/shares`

Activates a pending set. On a rotation, the previous active set is revoked in the same transaction and its encrypted shares are deleted.

**Auth:** session.

**Request body**

| Field | Type | Validation |
|---|---|---|
| `setId` | string | UUID. |

**Response `200`**

```json
{ "status": "active" }
```

Activating a set that is already active also returns `200`.

**Errors**

| Status | Code | When |
|---|---|---|
| 403 / 401 | `FORBIDDEN_ORIGIN`, `UNAUTHORIZED`, `ORIGIN_MISMATCH` | See conventions. |
| 400 | `INVALID_SET_ID` | Missing or not a UUID. |
| 404 | `NOT_FOUND` | No such set for this user. |
| 410 | `REVOKED` | The set is revoked. |
| 409 | `WALLET_ALREADY_EXISTS` | The user has an active set with a different owner address. The set stays `pending`: replacing it would leave the funds unreachable. |
| 429 | `RATE_LIMITED` | `enroll` scope, counted before the body is read. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 128 KiB. |

**Side effects** (`activateSet` in `server/store/sql-store.ts`, one transaction; on Postgres the user's row is locked with `FOR NO KEY UPDATE` to serialize concurrent activations): every other active set of the user becomes `revoked` with `enc_a`, `enc_b` and `enc_c` set to `NULL`, and this set becomes `active`. A partial unique index guarantees at most one active set per user.

### `GET /api/shares/a`

**Releases share A in plaintext** to the signer worker, which combines it with B or C in the browser. This is the most sensitive route of the API: anyone holding a live session and the app origin gets share A of the active set. Share A alone reconstructs nothing ([THREAT-MODEL.md](THREAT-MODEL.md)).

**Auth:** session.

**Query**

| Parameter | Type | Meaning |
|---|---|---|
| `setId` | UUID | Required. |

**Response `200`**

```json
{ "shareA": "<hex>" }
```

**Which sets release A:**

- An `active` set, to any session of its user.
- A `pending` set only to the session that created it (`share_sets.created_session_hash` equals the SHA-256 of this session's token), and only while the set is younger than a session (15 minutes). This is what the enrollment drill needs. Any other session gets `404 NOT_FOUND`, as if the set did not exist. Sets created before migration 006 have no creating session and never qualify while `pending`.

**Checks, in order:** session; the per-IP and per-`sub` `share-a` rate limit; `setId`; the release budgets, `SHARE_A_MAX_PER_SESSION` per session and `SHARE_A_MAX_PER_USER` per user in each `SHARE_A_WINDOW_SECONDS` window (defaults 5, 30 and one hour); then the lookup. The budgets are spent before the lookup, so refused and missing sets count too and the answer does not depend on whether the set exists.

The envelope is opened with the `userId` recorded in the set's manifest, not the session's `sub`: after a [relink](#post-apirelink) the set belongs to a new `sub`, but share A was sealed under the original one.

**Errors**

| Status | Code | When |
|---|---|---|
| 403 / 401 | `FORBIDDEN_ORIGIN`, `UNAUTHORIZED`, `ORIGIN_MISMATCH` | See conventions. |
| 400 | `INVALID_SET_ID` | Missing or not a UUID. |
| 404 | `NOT_FOUND` | No such set for this user, or a `pending` set this session did not create or that is older than 15 minutes. |
| 410 | `REVOKED` | The set is revoked or has no `enc_a`. |
| 429 | `RATE_LIMITED` | The `share-a` rate limit, or a release budget. |
| 500 | `SERVER_KEY_MISMATCH` | `MASTER_KEY` does not open the envelope: wrong key or corrupted data. The server logs an operator message without key or user data. |

**Side effects:** counts the rate limit and both budgets. Each release appends a `share_a_releases` row (user, set, its status, the session token's SHA-256, the session's app origin, ISO 8601 time) right before the response; if the row cannot be written, share A is not returned. Neither share A nor the token is stored there.

### `POST /api/shares/exported`

Records that the user downloaded their seed. Audit only: the request carries no seed data.

**Auth:** session.

**Request body:** none.

**Response `200`**

```json
{ "exportedAt": "<ISO 8601>" }
```

**Errors:** `403 FORBIDDEN_ORIGIN`, `401 UNAUTHORIZED`, `403 ORIGIN_MISMATCH`.

**Side effects:** sets `users.exported_at` to the current time.

## Account abstraction routes

Both routes act on the **session's chain**, the `chain` claim of the handoff token that opened the session, and on the **session user's active set**. The chain configuration comes from `AA_CHAINS` ([DEPLOYMENT.md](DEPLOYMENT.md#chain-configuration)).

**How the node RPC URL is chosen** (`resolveRpcUrl` in `server/chains.ts`):

1. `AA_CHAINS[chainId].rpcUrl`, if configured. It takes precedence because it may carry an API key.
2. Otherwise the token's `chain.rpcUrl`, only if it has no username or password, uses HTTPS (HTTP only on a local host, `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`, in insecure local mode), and its host is in `RPC_ALLOWED_HOSTS`.
3. Otherwise: `CHAIN_NOT_SUPPORTED`.

Before any use, the vault calls `eth_chainId` on that URL and requires it to equal the session's `chainId` (`CHAIN_MISMATCH` otherwise).

**Outbound JSON-RPC** (`jsonRpc`): `POST` with a 10-second timeout, redirects treated as errors, and at most 1 MiB read from the response. Upstream error messages are truncated to 300 characters with any `http(s)://` URL replaced by `[url]`. Transport failures and malformed responses become `CHAIN_UNAVAILABLE`.

### `GET /api/aa/status`

Status of the user's Safe on the session's chain, computed by the server against that chain.

**Auth:** session.

**Response `200`** (`ChainStatus`)

```json
{
  "chainId": 11155111,
  "chainName": "Sepolia",
  "nativeCurrency": "ETH",
  "rpcHost": "rpc.example.com",
  "sponsored": true,
  "transactionsSponsored": false,
  "bundler": true,
  "deployed": false,
  "deployable": true,
  "balance": "0"
}
```

| Field | Meaning |
|---|---|
| `chainName` | `AA_CHAINS[chainId].name`, else a built-in name for chains 1, 10, 137, 8453, 42161, 80002, 84532 and 11155111, else `"Unnamed network"`. |
| `nativeCurrency` | Symbol of the chain's native currency: `AA_CHAINS[chainId].nativeCurrency`, else the built-in symbol of those chains (`POL` on 137 and 80002, `ETH` on the others), else `"ETH"`. Display only. |
| `rpcHost` | Host (and port) of the RPC URL in use. |
| `sponsored` | `AA_CHAINS[chainId].paymasterUrl` is set: the deployment is sponsored. |
| `transactionsSponsored` | `paymasterUrl` is set **and** `AA_CHAINS[chainId].sponsorTransactions` is `true` (`transactionsSponsored` in `server/chains.ts`): transactions from the deployed Safe are sponsored too. Otherwise the Safe pays their fee. |
| `bundler` | `AA_CHAINS[chainId].bundlerUrl` is set. |
| `deployed` | The Safe address has code. |
| `deployable` | Not deployed, every required contract (factory, singleton, Safe 4337 module, module setup, EntryPoint) has code, simulating the factory call (`eth_call`) returns exactly the expected Safe address, and a bundler is configured. If the contracts are missing or the factory would return another address, the route fails with `CHAIN_NOT_SUPPORTED` instead. |
| `balance` | The Safe's native balance in wei, as a decimal string, when not deployed. `null` when deployed. |

**Errors**

| Status | Code | When |
|---|---|---|
| 403 / 401 | `FORBIDDEN_ORIGIN`, `UNAUTHORIZED`, `ORIGIN_MISMATCH` | See conventions. |
| 429 | `RATE_LIMITED` | `aa` scope, per IP and per `sub`, shared with `/api/aa/rpc`. |
| 409 | `CHAIN_NOT_SUPPORTED` | The session has no chain, no usable RPC URL, or the chain cannot produce the expected Safe address. |
| 404 | `NO_WALLET` | The user has no active set. |
| 409 | `CHAIN_MISMATCH` | The RPC reports another `chainId`. |
| 409 | `CHAIN_UNAVAILABLE` | The RPC failed, timed out, or answered with an error or too much data. |

**Side effects:** none in the database besides the rate-limit counters. Outbound RPC calls: `eth_chainId`, `eth_getCode` for the Safe and, when not deployed, for five contracts, one `eth_call`, and `eth_getBalance`.

### `POST /api/aa/rpc`

A restricted JSON-RPC proxy to the bundler, the paymaster and the node, so that their URLs and API keys never reach the browser. It is **not a relay**: the server builds the deployment of the session user's own Safe on the session's chain (`server/sponsorship.ts`), or one call from that Safe once deployed (`server/transactions.ts`), and then forwards only that exact operation, signed by its owner, once. Gas, fees, nonce and paymaster fields never come from the browser. The vault's client for both flows is `lib/aa-client.ts`.

**Auth:** session.

**Request body**

| Field | Type | Meaning |
|---|---|---|
| `method` | string | One of the four methods below. |
| `params` | array | Method parameters, with exactly the count listed. |

**Checks before any method**, in order: `Origin`, session, the `aa` rate limit (per IP and per `sub`, shared with `/api/aa/status`), the body, a known method, a chain in the session (`CHAIN_NOT_SUPPORTED`), a `bundlerUrl` for it (`CHAIN_NOT_SUPPORTED`), and an active set (`NO_WALLET`).

**Methods**

| Method | `params` | What it does |
|---|---|---|
| `vault_prepareDeployment` | `[]` | Builds, records and returns the unsigned deployment. Not forwarded as such. |
| `vault_prepareTransaction` | `[{ to, value, data? }]` | Builds, records and returns the unsigned operation for one call from the deployed Safe. Not forwarded as such. |
| `eth_sendUserOperation` | `[operation, entryPoint]` | Forwards the prepared deployment (with `factory`) or the prepared transaction (without `factory`) with the owner's signature to the bundler. |
| `eth_getUserOperationReceipt` | `[userOpHash]` | Forwards to the bundler, only for a hash recorded for this Safe and chain (a deployment, or a sent transaction). |

Any other method, including `eth_estimateUserOperationGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `pm_getPaymasterStubData` and `pm_getPaymasterData`: `403 METHOD_NOT_ALLOWED`. A different number of `params`: `400 INVALID_BODY`.

**`vault_prepareDeployment`**

1. A fresh [`chainStatus`](#get-apiaastatus): not deployed (`ALREADY_DEPLOYED` otherwise) and deployable (`CHAIN_NOT_SUPPORTED` otherwise).
2. The Safe's `sponsored_deployments` row: one `submitting` for less than 60 seconds gives `DEPLOYMENT_IN_PROGRESS`; one `sent` within `AA_DEPLOYMENT_RETRY_SECONDS` gives `ALREADY_SPONSORED`. Checked before any upstream call.
3. Fees from the node (`eth_gasPrice`, `eth_maxPriorityFeePerGas`) and the bundler's `pimlico_getUserOperationGasPrice` quote (`standard` tier), a floor that is skipped when the bundler does not answer it (method not found, an error or a malformed result). Any of these above the `maxFeePerGas` cap gives `FEES_TOO_HIGH`. Otherwise `maxPriorityFeePerGas = max(priority, quote tip) × priorityFeeMultiplierPercent / 100` and `maxFeePerGas = max(gasPrice × feeMultiplierPercent / 100 + maxPriorityFeePerGas, quote maxFeePerGas × priorityFeeMultiplierPercent / 100)`, clamped to the cap, with the tip never above `maxFeePerGas` ([DEPLOYMENT.md](DEPLOYMENT.md#sponsorship-limits)).
4. The deployment operation (`buildDeploymentOperation` in `packages/core/src/safe.ts`), then, with a `paymasterUrl`, `pm_getPaymasterStubData`.
5. `eth_estimateUserOperationGas` from the bundler. Each limit (and the paymaster limits, when the estimate has them) gets a 20 % margin, clamped to its cap; an estimate already above its cap gives `GAS_LIMIT_EXCEEDED`.
6. With a `paymasterUrl`, `pm_getPaymasterData`. Both paymaster gas limits must then be known.
7. The operation and its hash (`userOperationHash`, which excludes the signature) are stored as `prepared`, in one statement that replaces only a `prepared` row, a stale `submitting` row or a `sent` row older than the retry window (otherwise the code of step 2).

Paymaster calls always carry `[operation, entryPoint, chainId in hex, AA_CHAINS[chainId].paymasterContext ?? {}]`. Every paymaster result must have `paymaster` (an address) and `paymasterData` (even-length hex, at most 4096 bytes), and any gas limit it gives must be a hex quantity within its cap (`GAS_LIMIT_EXCEEDED` otherwise). A malformed paymaster or estimate result is `502 UPSTREAM_INVALID`; a failed or malformed node answer is `CHAIN_UNAVAILABLE`. The caps and their configuration are in [DEPLOYMENT.md](DEPLOYMENT.md#sponsorship-limits).

Without a `paymasterUrl` the same steps run without the paymaster calls and fields; the page then checks that the Safe's balance covers the prefund.

Response `200`: `{ "result": <UserOperationJson> }`, unsigned (`signature: "0x"`), with decimal quantities.

**`vault_prepareTransaction`** (`server/transactions.ts`)

`params[0]` is the call, validated with `parseVaultCall` (`packages/core/src/sign-request.ts`): only the keys `to`, `value` and `data`; `to` an address; `value` the amount in wei as a decimal string within uint256; `data`, if present, even-length hex of at most 128000 characters (`INVALID_BODY` otherwise). Then:

1. The `transaction` rate limit (per IP and per `sub`), on top of `aa`: each prepared transaction may be sponsored and costs paymaster and bundler calls.
2. The RPC's `eth_chainId` (`CHAIN_MISMATCH`).
3. A call to the Safe itself with non-empty `data` is refused (`403 CALL_NOT_ALLOWED`): it could change the Safe's owners, modules or guard. A value-only transfer to the Safe itself is allowed.
4. `eth_getCode` for the Safe: no code is `409 NOT_DEPLOYED`.
5. In parallel: `eth_gasPrice`, `eth_maxPriorityFeePerGas`, the bundler's `pimlico_getUserOperationGasPrice` quote, the Safe's `eth_getBalance` and its nonce from the EntryPoint (`getNonce(safe, 0)`, through `eth_call`). A balance below `value` is `409 INSUFFICIENT_FUNDS`, checked before any paymaster or bundler call.
6. Fees exactly as for a deployment (step 3 above, with the same caps). The operation (`buildTransactionOperation`): `callData` is the Safe 4337 module's `executeUserOpWithErrorString(to, value, data, 0)`, operation `0` being a CALL. A delegatecall or a batch cannot be produced.
7. Only when the chain has a `paymasterUrl` and `"sponsorTransactions": true`: `pm_getPaymasterStubData`, with the same parameters and context as the deployment.
8. `eth_estimateUserOperationGas`, with the 20 % margin and the same caps as the deployment (`GAS_LIMIT_EXCEEDED`).
9. Sponsored: `pm_getPaymasterData`, and both paymaster gas limits must be known (`UPSTREAM_INVALID`). Not sponsored: the balance must cover `value` plus the prefund, `(callGasLimit + verificationGasLimit + preVerificationGas) × maxFeePerGas` (`409 INSUFFICIENT_FUNDS`).
10. The operation, the call and whether it is sponsored are stored as `prepared` in `prepared_transactions`, keyed by chain, Safe and operation hash (`userOperationHash`, which excludes the signature). Just before, `prepared` rows of any Safe older than 10 minutes are deleted. If the same operation was already prepared (same nonce, fees and gas), it is returned again while still `prepared`; once `submitting` or `sent` it is `409 TRANSACTION_IN_PROGRESS`.

Response `200`: `{ "result": <UserOperationJson> }`, unsigned (`signature: "0x"`, `factory: null`), with decimal quantities.

**`eth_sendUserOperation`**

1. `params[0]` is an object and `params[1]` equals the manifest's `smartAccount.entryPoint`, case-insensitively (`INVALID_BODY`).
2. If `factory` is missing or `null`, the operation can only be a transaction: see **Transactions** below. Otherwise it continues as a deployment.
3. `isDeploymentOperation(operation, owner, smartAccount)` (`OPERATION_NOT_ALLOWED`).
4. A prepared row exists for this Safe and chain (`DEPLOYMENT_NOT_PREPARED`).
5. Every field except `signature` equals the prepared operation: quantities in decimal or hex, addresses and bytes in any case, a field the prepared operation lacks must be missing or `null`, and any other key is refused. A mismatch is `ALREADY_SPONSORED` if the row is `sent`, `OPERATION_NOT_ALLOWED` otherwise.
6. `signature` is a 77-byte Safe signature (`validAfter`, `validUntil`, one 65-byte ECDSA signature) that recovers to the owner (`OPERATION_NOT_ALLOWED`).
7. If the row is already `sent`, the stored `userOpHash` is returned without forwarding anything.
8. A fresh `chainStatus` (`ALREADY_DEPLOYED`), then an atomic claim of the row (`prepared` to `submitting`). A request that loses the claim gets the winner's hash if it has finished, `DEPLOYMENT_IN_PROGRESS` otherwise.
9. The **stored** operation, with only the request's signature, is forwarded. A 32-byte hash marks the row `sent` and is returned. An upstream error (`502 UPSTREAM_ERROR`), a transport failure (`CHAIN_UNAVAILABLE`) or a malformed hash (`502 UPSTREAM_INVALID`) puts the row back to `prepared`, so the same signed operation can be sent again.

Response `200`: `{ "result": "<userOpHash>" }`.

**Transactions: `eth_sendUserOperation` without `factory`** (`submitTransaction`)

1. The candidate is normalized (hex or decimal quantities, empty fields missing or `null`); a malformed field is `OPERATION_NOT_ALLOWED`.
2. Its `userOperationHash` is computed and the `prepared_transactions` row for this chain, Safe and hash is looked up. The hash covers every field except the signature, so a candidate with any field changed finds nothing (`403 OPERATION_NOT_ALLOWED`).
3. Defensive re-checks against the record: the recorded call is still allowed, the prepared operation executes exactly that call from this Safe, and the candidate matches the prepared operation field by field, with the same rules as step 5 of the deployment (`OPERATION_NOT_ALLOWED`).
4. The signature is a 77-byte Safe signature that recovers to the owner (`OPERATION_NOT_ALLOWED`).
5. If the row is already `sent`, its `userOpHash` is returned without forwarding anything.
6. Prepared 10 minutes ago or more (`TRANSACTION_TTL_MS`): `409 TRANSACTION_EXPIRED`. The fees and paymaster data may be stale; the popup returns the error, and the app requests the transaction again.
7. An atomic claim (`prepared`, or `submitting` older than 60 seconds, to `submitting`). A request that loses it gets the winner's hash if it has finished, `409 TRANSACTION_IN_PROGRESS` otherwise.
8. The **stored** operation, with only the request's signature, is forwarded once. A 32-byte hash marks the row `sent` and is returned. An upstream error, a transport failure or a malformed hash puts the row back to `prepared`, so the same signed operation can be sent again (within the TTL).

Response `200`: `{ "result": "<userOpHash>" }`.

**`eth_getUserOperationReceipt`:** `params[0]` must match `^0x[0-9a-fA-F]{64}$` (`INVALID_BODY`) and equal the hash recorded as `sent` for this session's Safe and chain, either its deployment or one of its sent transactions (`OPERATION_NOT_ALLOWED`). Response `200`: `{ "result": <bundler result> }`, `null` while pending.

`bundlerHeaders` and `paymasterHeaders` from `AA_CHAINS` are added to the corresponding upstream request.

**Errors**

| Status | Code | When |
|---|---|---|
| 403 / 401 | `FORBIDDEN_ORIGIN`, `UNAUTHORIZED`, `ORIGIN_MISMATCH` | See conventions. |
| 429 | `RATE_LIMITED` | `aa` scope, per IP and per `sub`; for `vault_prepareTransaction`, also the `transaction` scope. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 128 KiB. |
| 400 | `INVALID_BODY` | `method` not a string or `params` not an array; wrong number of `params`; bad hash; invalid call; operation not an object or wrong `entryPoint`. |
| 403 | `METHOD_NOT_ALLOWED` | Not one of the four methods. |
| 409 | `CHAIN_NOT_SUPPORTED` | No chain in the session, no bundler, no usable RPC URL, or the chain cannot produce the expected Safe address. |
| 404 | `NO_WALLET` | No active set. |
| 403 | `OPERATION_NOT_ALLOWED` | Not the deployment of this user's Safe, not a prepared operation (any field changed), not signed by the owner, or a receipt for another hash. |
| 403 | `CALL_NOT_ALLOWED` | `vault_prepareTransaction` for a call to the Safe itself with data. |
| 409 | `ALREADY_DEPLOYED` | The Safe already has code. |
| 409 | `NOT_DEPLOYED` | `vault_prepareTransaction` for a Safe without code on this chain. |
| 409 | `INSUFFICIENT_FUNDS` | `vault_prepareTransaction`: the Safe's balance is below `value`, or, not sponsored, below `value` plus the prefund. |
| 409 | `TRANSACTION_EXPIRED` | A transaction sent 10 minutes or more after it was prepared. |
| 409 | `TRANSACTION_IN_PROGRESS` | Another request is submitting this transaction, or the same operation is prepared again after it was sent. |
| 409 | `ALREADY_SPONSORED` | A deployment for this Safe was sent within `AA_DEPLOYMENT_RETRY_SECONDS`, or a different operation is sent after one was. |
| 409 | `DEPLOYMENT_IN_PROGRESS` | Another request is submitting this Safe's deployment. |
| 409 | `DEPLOYMENT_NOT_PREPARED` | `eth_sendUserOperation` with no prepared deployment. |
| 409 | `FEES_TOO_HIGH` | The node's gas price or priority fee, or the bundler's quoted fees, are above the `maxFeePerGas` cap. |
| 409 | `GAS_LIMIT_EXCEEDED` | An estimate or a paymaster gas limit is above its cap. |
| 409 | `CHAIN_MISMATCH` | The RPC reports another chain. |
| 409 | `CHAIN_UNAVAILABLE` | Transport failure, timeout, oversized or malformed node response. |
| 502 | `UPSTREAM_ERROR` | Bundler or paymaster answered with a JSON-RPC `error`; adds the sanitized `rpcMessage`, which the client maps to a code (below). |
| 502 | `UPSTREAM_INVALID` | The paymaster or bundler answered with a result of the wrong shape. |

What the vault client (`lib/aa-client.ts`) passes to the integrator as the `code` of the `deploy` or `transaction` action:

- `FEES_TOO_HIGH`, `GAS_LIMIT_EXCEEDED`, `ALREADY_SPONSORED`, `DEPLOYMENT_IN_PROGRESS`, `TRANSACTION_EXPIRED`, `TRANSACTION_IN_PROGRESS`, `RATE_LIMITED`, `INSUFFICIENT_FUNDS`, `CALL_NOT_ALLOWED` and `CHAIN_*` codes as they are; `NOT_DEPLOYED` as `WALLET_NOT_DEPLOYED`.
- `UPSTREAM_ERROR`, by its `rpcMessage` (`upstreamErrorCode`), for both flows: `AA21` is `INSUFFICIENT_FUNDS`; `AA25` or "invalid nonce" is `NONCE_CONFLICT`; another `AA3x`, or a message mentioning the paymaster, sponsorship or a policy (for example Pimlico's "sponsorship policy ... is not active"), is `SPONSORSHIP_REJECTED`; any other `AAxx` is `DEPLOY_FAILED` or `TRANSACTION_FAILED`; for a transaction, a message mentioning a revert or execution is `CALL_REVERTED`.
- Anything else: `DEPLOY_FAILED` or `TRANSACTION_FAILED`.

**Side effects:** `vault_prepareDeployment` writes or replaces the `prepared` row; `eth_sendUserOperation` moves it from `prepared` to `submitting` to `sent`, or back to `prepared` on failure. `vault_prepareTransaction` inserts a `prepared_transactions` row (and deletes expired `prepared` ones), and `eth_sendUserOperation` moves it through the same states. Outbound calls: a prepare runs a full `chainStatus` (up to nine node calls), two node fee calls, one bundler gas price call, the paymaster stub, the estimate and the final paymaster data; a send runs `chainStatus` and one bundler call; an idempotent resend makes none, and a prepare blocked by the row makes only the `chainStatus` calls. A transaction prepare makes `eth_chainId`, `eth_getCode`, two node fee calls, `eth_getBalance`, one `eth_call` for the nonce, one bundler gas price call, the estimate and, when sponsored, the paymaster stub and final data; a transaction send makes one bundler call and no node calls.

## Relinking a wallet to another account

Relinking moves an existing wallet to a new integrator account (`sub`) when the user has lost their app login. A valid handoff token only says who the new `sub` is; what moves the wallet is an EIP-712 signature by the wallet's **owner** key over a message the server rebuilds from its own values. The protocol is described in [PROTOCOL.md](PROTOCOL.md) and its risks in [THREAT-MODEL.md](THREAT-MODEL.md).

### `POST /api/relink/nonce`

**Auth:** session (of the new account).

**Request body**

| Field | Type | Validation |
|---|---|---|
| `safe` | string | EVM address of the Safe. |
| `owner` | string | EVM address of the owner. |

**Response `200`** (`RelinkChallenge`)

```json
{
  "safe": "0x... (checksummed)",
  "owner": "0x... (checksummed)",
  "newSub": "<session sub>",
  "issuer": "<HANDOFF_ISSUER>",
  "vaultOrigin": "<ORIGIN>",
  "nonce": "<base64url, 32 random bytes>",
  "expiresAt": 1730000000
}
```

`expiresAt` is in Unix seconds, 5 minutes from now. The browser asks the owner key to sign `relinkTypedData(challenge)` (`packages/core/src/relink.ts`): domain `{ name: "wl-embedded-wallet/relink-wallet", version: "1" }` with no `chainId` or verifying contract, primary type `WalletRelink` with `purpose: "wl-embedded-wallet/relink-wallet/v1"` plus the fields above.

The response is the same whether or not a wallet with that owner and Safe exists, so the route does not reveal which addresses the vault holds. If there is not **exactly one** active set with that owner and that Safe address, the nonce is stored with no source user and any later use of it is rejected.

**Errors:** `403 FORBIDDEN_ORIGIN`, `401 UNAUTHORIZED`, `403 ORIGIN_MISMATCH`, `429 RATE_LIMITED` (`relink-nonce` scope, per IP and per `sub`, right after the session check), `413 PAYLOAD_TOO_LARGE`, `400 INVALID_BODY` (missing or invalid addresses), `409 WALLET_ALREADY_EXISTS` (the session's user already has an active set).

**Side effects:** inserts a `relink_nonces` row (`nonce`, new `sub`, checksummed `safe` and `owner`, the source user or `NULL`, expiry). Expired nonces are deleted first.

### `POST /api/relink`

**Auth:** session (the same new account that requested the nonce) and the owner's signature.

**Request body**

| Field | Type | Validation |
|---|---|---|
| `nonce` | string | A nonce issued to this session's `sub` and not expired. |
| `signature` | string | Hex (`viem` `isHex`). The owner's EIP-712 signature. |

**Checks:** the nonce exists for this `sub` and is not expired; the server rebuilds the typed data from the stored `safe`, `owner` and expiry, the session's `sub`, `HANDOFF_ISSUER` and `ORIGIN`, recovers the signer and requires it to be the stored owner. Then, in one transaction (`relinkWallet`): the nonce is deleted; it must have a source user different from the new `sub`; that source user must still hold an active set with exactly that owner and Safe; and the new `sub` must not have an active set. On Postgres both users' rows are locked in a fixed order.

**Response `200`**

```json
{ "address": "<Safe address>", "owner": "<owner address>" }
```

**Errors**

| Status | Code | When |
|---|---|---|
| 403 / 401 | `FORBIDDEN_ORIGIN`, `UNAUTHORIZED`, `ORIGIN_MISMATCH` | See conventions. |
| 400 | `INVALID_BODY` | `nonce` not a string or `signature` not hex. |
| 403 | `RELINK_REJECTED` | Nonce unknown, expired or issued to another `sub`; signature invalid or not by the owner; no unique source wallet; or the wallet moved since the nonce was issued. The reason is not disclosed. |
| 409 | `WALLET_ALREADY_EXISTS` | The new `sub` gained an active set in the meantime. |
| 429 | `RATE_LIMITED` | `relink` scope, per IP and per `sub`, right after the session check. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 128 KiB. |

A bad signature does not spend the nonce (it is only read). Once the transaction starts, the nonce is spent even if a later check fails.

**Side effects** on success: every `share_sets` row of the source user (active, pending and revoked) moves to the new `sub`; the new user's `exported_at` is copied from the source user; **all sessions of the source user are deleted**; and a row is appended to `wallet_relinks` (Safe, owner, old and new `sub`, issuer, vault origin, the session's app origin, nonce, signature, timestamp). That table is an audit trail and is never pruned. The user's previous account receives no notification.

## Kit-free recovery

These two routes let a user who has lost their app login, and their kit, recover with their passkey and recovery code. They need **no handoff token and open no session**. They return only the encrypted shares B and C and the signed manifest, **never share A**; without the recovery code none of it reconstructs the seed. Only sets whose passkey public key was registered at enrollment (`registration` in `POST /api/shares`) can be found this way. See [RECOVERY.md](RECOVERY.md).

### `POST /api/recovery/passkey/challenge`

**Auth:** `Origin` must equal `ORIGIN`. Nothing else.

**Request body:** none.

**Response `200`**

```json
{ "challenge": "<base64url, 32 random bytes>" }
```

**Errors:** `403 FORBIDDEN_ORIGIN`; `429 RATE_LIMITED`, from the per-IP `recovery-challenge` limit or when `RECOVERY_CHALLENGE_MAX_LIVE` (default 1000) unexpired `recover` challenges already exist, across all clients (then with `Retry-After: 60`).

**Side effects:** inserts a `webauthn_challenges` row with purpose `recover`, no user, valid for 5 minutes, unless the cap is reached. Expired challenges are deleted first.

### `POST /api/recovery/passkey`

**Auth:** `Origin` must equal `ORIGIN`, and a WebAuthn assertion from a discoverable credential.

**Request body**

| Field | Type | Validation |
|---|---|---|
| `assertion` | object | `navigator.credentials.get` result as JSON (`AssertionJson`): `type: "public-key"`, `id` base64url of at most 1024 characters, `rawId === id`, `response.clientDataJSON`, `response.authenticatorData` and `response.signature` base64url of at most 8192 characters each, optional `response.userHandle`. The client sends no extension results, so the PRF output stays in the browser; the server does not inspect `clientExtensionResults`. |

**Checks:** the challenge in `clientDataJSON` is spent first (purpose `recover`, no user, not expired), even if a later check fails. Then the active set whose `credential_id` is `assertion.id` and that has a registered public key is looked up. The assertion is verified against that public key, `ORIGIN` and `RP_ID`, with user verification required. Finally the stored signature counter is advanced with a compare-and-set, so two concurrent uses of the same assertion cannot both pass.

**Response `200`**

```json
{
  "setId": "...",
  "credentialId": "...",
  "encB": { "...": "envelope" },
  "encC": { "...": "envelope" },
  "manifest": { "...": "..." },
  "signature": "..."
}
```

**Errors:** `403 FORBIDDEN_ORIGIN`; `429 RATE_LIMITED` (per-IP `recovery-assertion` limit, before the body is read); `413 PAYLOAD_TOO_LARGE`; `401 RECOVERY_FAILED` for every other failure (invalid shape, unknown or spent challenge, unknown credential, no registered public key, bad signature, user verification missing, counter regression or race). The cause is not disclosed.

**Side effects:** deletes the challenge; updates `share_sets.credential_counter`.

## Integrator backend route

### `GET /api/s2s/accounts/{sub}`

Server-to-server lookup for the integrator's backend: a user's wallet address and, optionally, its deployment state on a chain. Returns public data only. The SDK client is `createVaultServiceClient` in `packages/sdk/src/server/service-client.ts` ([INTEGRATION.md](INTEGRATION.md)).

**Auth:** `Authorization: Bearer <VAULT_SERVICE_TOKEN>`. No `Origin` check and no session. **Never expose this token to a browser.**

**Path parameter:** `sub`, the integrator's user id (URL-encoded). It must match the handoff `sub` pattern, `^[A-Za-z0-9_-]{1,64}$` (`400 INVALID_SUB`): no account can have any other.

**Checks, in order:** the per-IP `s2s` rate limit (before the bearer check, so guessing the token is throttled too); the bearer token; `sub`; `chainId`; the per-`sub` `s2s` rate limit (only after the bearer check, so an anonymous caller cannot spend a user's budget); then the lookup. Invalid input touches neither the store nor the chain, and the answers and budgets are the same whether or not the account exists.

**Query**

| Parameter | Type | Meaning |
|---|---|---|
| `chainId` | string | Optional. `^[1-9][0-9]{0,15}$` and at most 9007199254740991 (a positive safe integer). Adds the chain state to the response. |
| `rpcUrl` | string | Optional. Used only when `AA_CHAINS[chainId].rpcUrl` is not configured, and only if allowed by `RPC_ALLOWED_HOSTS` (same rules as [above](#account-abstraction-routes)). |

**Responses `200`**

No active set for `sub` (a valid `chainId` is then ignored):

```json
{ "exists": false, "address": null, "owner": null }
```

Active set, without `chainId`:

```json
{ "exists": true, "address": "<Safe address>", "owner": "<owner address>" }
```

Active set, with `chainId`:

```json
{ "exists": true, "address": "0x...", "owner": "0x...", "chainId": 11155111, "deployed": false, "deployable": true, "sponsored": true, "transactionsSponsored": false }
```

If the chain check fails, the status is still `200`:

```json
{ "exists": true, "address": "0x...", "owner": "0x...", "chainId": 11155111, "deployed": null, "deployable": false, "chainError": "CHAIN_NOT_SUPPORTED | CHAIN_MISMATCH | CHAIN_UNAVAILABLE" }
```

`address` is the Safe, the user's account. `owner` is the Shamir-protected key that controls it. `sponsored` and `transactionsSponsored` mean the same as in [`GET /api/aa/status`](#get-apiaastatus).

**Errors:** `401 UNAUTHORIZED` (missing, malformed or wrong bearer token, or `VAULT_SERVICE_TOKEN` unset); `400 INVALID_SUB` (`sub` does not match the pattern); `400 INVALID_CHAIN_ID` (`chainId` present and not a positive safe integer, whether or not the account exists); `429 RATE_LIMITED` (per IP, or per `sub`). The SDK's `createVaultServiceClient` throws `VaultUnavailableError` for all of them.

**Side effects:** none in the database. With `chainId`, the same outbound RPC calls as [`GET /api/aa/status`](#get-apiaastatus).

## Public routes

### `GET /api/health`

For the container orchestrator. It reveals neither version nor configuration. No authentication and no `Origin` check.

| Status | Body | When |
|---|---|---|
| 200 | `{ "status": "ok" }` | `SELECT 1` against the database succeeds. |
| 503 | `{ "status": "unavailable" }` | The database cannot be opened or does not respond. |

The image's `HEALTHCHECK` calls this route ([DEPLOYMENT.md](DEPLOYMENT.md#health-checks)).

### `GET /recovery-tool`

Downloads the offline recovery tool, `wl-embedded-wallet-recovery.html`. Public: it is open source and carries no user data. The vault UI requires this download before it hands the user a kit (`fetchRecoveryTool` in `lib/recovery-tool.ts` accepts only a `200` whose body starts with `<!doctype html`), so **a deployment that does not serve this route cannot complete any enrollment or rotation**.

**Response `200`:** the file bytes, with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="wl-embedded-wallet-recovery.html"` and `Cache-Control: no-store`. It is always served as a download: the tool is meant to be opened from `file://`, not from the vault origin.

**Response `404`:** `Tool not available in this deployment.` (`text/plain`), when the file is missing from the build. The file is read from `packages/recovery-tool/dist/` relative to the vault's working directory; `pnpm build` generates it and `outputFileTracingIncludes` copies it into the standalone output.

The tool's bytes are reproducible; its published SHA-256 and how to verify what a vault serves are in [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md).

### `GET /brand/{file}`

Serves the deployment brand's generated stylesheet, fonts, logo and favicon ([BRANDING.md](BRANDING.md)). Files are looked up in memory by name among what was validated at startup; no request reaches the file system.

**Path parameter:** `file` must match `^[0-9a-f]{16}\.(svg|png|webp|ico|woff2|woff|ttf|otf|css)$`, where the 16 hex digits are the start of the SHA-256 of the content. Any other name, or a name that is not a file of the current brand, is a 404. The neutral brand has no files, so every request is a 404.

**Response `200` headers**

| Header | Value |
|---|---|
| `Content-Type` | By extension: `image/svg+xml`, `image/png`, `image/webp`, `image/x-icon`, `font/woff2`, `font/woff`, `font/ttf`, `font/otf`, `text/css; charset=utf-8`. |
| `Content-Length` | Size in bytes. |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; style-src 'unsafe-inline'; sandbox` for SVG, `default-src 'none'; sandbox` for everything else. |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `public, max-age=31536000, immutable` (the name is the content hash). |

**Response `404`:** `Not found.` (`text/plain; charset=utf-8`) with `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

## Error code index

| Code | Status | Routes |
|---|---|---|
| `FORBIDDEN_ORIGIN` | 403 | Every browser-facing `/api/*` route |
| `UNAUTHORIZED` | 401 | Session routes; `/api/s2s/accounts/{sub}` |
| `ORIGIN_MISMATCH` | 403 | Session routes (header binding); `/api/auth/handoff` (body `origin` vs signed `origin`) |
| `ORIGIN_NOT_ALLOWED` | 403 | `/api/auth/handoff` |
| `INVALID_TOKEN` | 401 | `/api/auth/handoff` |
| `CHAIN_REQUEST_MISMATCH` | 400 | `/api/auth/handoff` |
| `INVALID_BODY` | 400 | `POST /api/shares`, `/api/aa/rpc`, `/api/relink/nonce`, `/api/relink` |
| `PAYLOAD_TOO_LARGE` | 413 | Every route that reads a body: `/api/auth/handoff`, `POST` and `PATCH /api/shares`, `/api/aa/rpc`, `/api/relink/nonce`, `/api/relink`, `/api/recovery/passkey` |
| `RATE_LIMITED` | 429 | `/api/auth/handoff`, `/api/webauthn/challenge`, `POST` and `PATCH /api/shares`, `/api/shares/a`, `/api/aa/status`, `/api/aa/rpc`, `/api/relink/nonce`, `/api/relink`, `/api/recovery/passkey/challenge`, `/api/recovery/passkey`, `/api/s2s/accounts/{sub}` |
| `INVALID_SET_ID` | 400 | `GET` and `PATCH /api/shares`, `/api/shares/a` |
| `ENVELOPE_MISMATCH` | 400 | `POST /api/shares` |
| `DIGEST_MISMATCH` | 400 | `POST /api/shares` |
| `SMART_ACCOUNT_MISMATCH` | 400 | `POST /api/shares` |
| `CREDENTIAL_INVALID` | 400 | `POST /api/shares` |
| `SET_EXISTS` | 409 | `POST /api/shares` |
| `WALLET_ALREADY_EXISTS` | 409 | `POST` and `PATCH /api/shares`, `/api/relink/nonce`, `/api/relink` |
| `NOT_FOUND` | 404 | `GET` and `PATCH /api/shares`, `/api/shares/a` |
| `REVOKED` | 410 | `GET` and `PATCH /api/shares`, `/api/shares/a` |
| `SERVER_KEY_MISMATCH` | 500 | `/api/shares/a` |
| `NO_WALLET` | 404 | `/api/aa/status`, `/api/aa/rpc` |
| `METHOD_NOT_ALLOWED` | 403 | `/api/aa/rpc` |
| `OPERATION_NOT_ALLOWED` | 403 | `/api/aa/rpc` |
| `CALL_NOT_ALLOWED` | 403 | `/api/aa/rpc` |
| `ALREADY_DEPLOYED` | 409 | `/api/aa/rpc` |
| `NOT_DEPLOYED` | 409 | `/api/aa/rpc` |
| `INSUFFICIENT_FUNDS` | 409 | `/api/aa/rpc` |
| `TRANSACTION_EXPIRED` | 409 | `/api/aa/rpc` |
| `TRANSACTION_IN_PROGRESS` | 409 | `/api/aa/rpc` |
| `ALREADY_SPONSORED` | 409 | `/api/aa/rpc` |
| `DEPLOYMENT_IN_PROGRESS` | 409 | `/api/aa/rpc` |
| `DEPLOYMENT_NOT_PREPARED` | 409 | `/api/aa/rpc` |
| `FEES_TOO_HIGH` | 409 | `/api/aa/rpc` |
| `GAS_LIMIT_EXCEEDED` | 409 | `/api/aa/rpc` |
| `CHAIN_NOT_SUPPORTED` | 409 | `/api/aa/status`, `/api/aa/rpc`; as `chainError` in `/api/s2s/accounts/{sub}` |
| `CHAIN_MISMATCH` | 409 | `/api/aa/status`, `/api/aa/rpc`; as `chainError` in `/api/s2s/accounts/{sub}` |
| `CHAIN_UNAVAILABLE` | 409 | `/api/aa/status`, `/api/aa/rpc`; as `chainError` in `/api/s2s/accounts/{sub}` |
| `UPSTREAM_ERROR` | 502 | `/api/aa/rpc` |
| `UPSTREAM_INVALID` | 502 | `/api/aa/rpc` |
| `RELINK_REJECTED` | 403 | `/api/relink` |
| `RECOVERY_FAILED` | 401 | `/api/recovery/passkey` |
| `INVALID_CHAIN_ID` | 400 | `/api/s2s/accounts/{sub}` |
| `INVALID_SUB` | 400 | `/api/s2s/accounts/{sub}` |
