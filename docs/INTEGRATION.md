# Integration guide

How an application (the "integrator") adds the embedded wallet to its product, using a vault that is already deployed ([docs/DEPLOYMENT.md](DEPLOYMENT.md)). This guide covers the SDK, the configuration the vault needs from you, how to verify what the vault returns, and the complete public API of `@wl-embedded-wallet/sdk`.

`examples/demo` is a complete integrator that uses only the public SDK. Every snippet in this guide that is not marked otherwise is taken from it or from `packages/sdk/examples/`.

Related documents: [README.md](../README.md), [docs/PROTOCOL.md](PROTOCOL.md) (the wire protocol between your page and the vault popup, and the handoff token validation rules), [docs/HTTP-API.md](HTTP-API.md) (every vault HTTP route), [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/CRYPTO-SPEC.md](CRYPTO-SPEC.md), [docs/THREAT-MODEL.md](THREAT-MODEL.md), [docs/RECOVERY.md](RECOVERY.md), [docs/BRANDING.md](BRANDING.md), [SECURITY.md](../SECURITY.md).

## Contents

1. [Overview](#1-overview)
2. [Packages and how to consume them](#2-packages-and-how-to-consume-them)
3. [What the vault needs from you](#3-what-the-vault-needs-from-you)
4. [Your backend: the handoff token](#4-your-backend-the-handoff-token)
5. [Your frontend: the vault client](#5-your-frontend-the-vault-client)
6. [Verifying results on your backend](#6-verifying-results-on-your-backend)
7. [Server-to-server API](#7-server-to-server-api)
8. [Several apps, one wallet](#8-several-apps-one-wallet)
9. [Linking a wallet to another account](#9-linking-a-wallet-to-another-account)
10. [Recovery: what to tell your users](#10-recovery-what-to-tell-your-users)
11. [Networks, deployment and paymaster](#11-networks-deployment-and-paymaster)
12. [API reference](#12-api-reference)

## 1. Overview

```
Browser (your page) -- SDK -- popup -->  Vault (separate origin)   The seed only exists inside the popup's worker
        |                                   ^
        v                                   | server-to-server, with VAULT_SERVICE_TOKEN
Your backend -------------------------------+
   Authenticates the user, mints the handoff token, publishes its JWKS
```

- The seed of each wallet is split with Shamir 2-of-3. Share A is stored by the vault server, share B is encrypted under a key derived from the user's passkey (WebAuthn PRF), share C is encrypted under a key derived from a recovery code. See [docs/CRYPTO-SPEC.md](CRYPTO-SPEC.md).
- The user's account is a Safe 4337 smart account. Its owner is the Shamir-protected key. The Safe has the same address on every supported EVM network.
- Your page never sees a share or the seed. It opens the vault in a popup and exchanges `postMessage` messages with it. The vault popup asks your backend, through the SDK, for a short-lived **handoff token** that tells it who the user is and which app is asking.
- **Nothing signs on the server.** The seed is reconstructed only in the user's browser, inside the vault origin, for one operation. Every signature needs the popup and the user's passkey, so your backend cannot sign on the user's behalf.

## 2. Packages and how to consume them

| Package | Entry point | Runs in | Purpose |
|---|---|---|---|
| `@wl-embedded-wallet/sdk` | `@wl-embedded-wallet/sdk/client` | Browser | `createVaultClient`, `VaultError`, protocol types |
| | `@wl-embedded-wallet/sdk/server` | Node.js (your backend) | Handoff tokens, JWKS publication, server-to-server client, Safe verification helpers |
| | `@wl-embedded-wallet/sdk/protocol` | Both | Protocol constants and message types only |
| `@wl-embedded-wallet/core` | several subpaths | Both | Shared primitives. A dependency of the SDK; you do not import it directly |

All packages in this repository are marked `"private": true` and are **not published to npm**. Version 0.1.0 is consumed as a pnpm workspace dependency, which is how `examples/demo` does it:

```json
{ "dependencies": { "@wl-embedded-wallet/sdk": "workspace:*" } }
```

The `exports` of the SDK point at TypeScript sources (`./src/client/index.ts`, `./src/server/index.ts`, `./src/protocol.ts`); there is no build step. Your bundler must compile them. With Next.js, the demo lists both packages in `transpilePackages`:

```js
transpilePackages: ['@wl-embedded-wallet/core', '@wl-embedded-wallet/sdk'],
```

The repository declares Node.js `>=22.13`. `/server` imports `node:crypto` (for `createHandoffSigner`), so it is meant for Node.js; it never reads environment variables itself: every key is passed as an argument, so importing it never pulls a secret into a bundle.

Do not import `@wl-embedded-wallet/sdk/server` from browser code.

## 3. What the vault needs from you

The vault operator configures these variables (validated at startup by `apps/vault/server/config.ts`; see [docs/DEPLOYMENT.md](DEPLOYMENT.md) for the full list). The ones that concern you:

| Vault variable | Value you provide | Notes |
|---|---|---|
| `HANDOFF_ISSUER` | The exact `iss` of your tokens | Required. One issuer per vault |
| `HANDOFF_JWKS_URL` | URL of your JWKS document, for example `https://login.example.com/.well-known/jwks.json` | `https` (plain `http` only for local hosts outside production, or with `ALLOW_INSECURE_LOCAL=1`). Set exactly one of `HANDOFF_JWKS_URL` and `HANDOFF_PUBLIC_KEY` |
| `HANDOFF_PUBLIC_KEY` | Alternative to the JWKS: one Ed25519 public key, 32 bytes in hex | Only `EdDSA` tokens are accepted in this mode, and `kid` is not used |
| `HANDOFF_AUDIENCE` | The `aud` you put in tokens | Optional. Defaults to the vault's `ORIGIN` |
| `HANDOFF_JWKS_CACHE_SECONDS`, `HANDOFF_JWKS_COOLDOWN_SECONDS`, `HANDOFF_JWKS_MAX_STALE_SECONDS` | | Optional. Defaults 300, 30 and 3600 seconds. See [docs/PROTOCOL.md](PROTOCOL.md#jwks-fetching-and-caching) |
| `ALLOWED_APP_ORIGINS` | Comma-separated exact origins of your apps | Optional. When set, a validly signed token whose `origin` is not listed is rejected with `ORIGIN_NOT_ALLOWED` |
| `VAULT_SERVICE_TOKEN` | Shared secret for the server-to-server API | At least 32 characters. Your backend sends it as a bearer token. Never send it to a browser |
| `AA_CHAINS` | Per-chain RPC, bundler and paymaster, and whether transactions are sponsored | Needed for `deploy()`, `sendTransaction()` and to use an RPC that carries an API key. See [section 11](#11-networks-deployment-and-paymaster) |
| `RPC_ALLOWED_HOSTS` | Hosts allowed for an `rpcUrl` carried in your token | Only used when the chain has no `rpcUrl` in `AA_CHAINS` |

You, in turn, need:

| Your variable (names used by the examples) | Value |
|---|---|
| `VAULT_ORIGIN` | The vault's `ORIGIN`, for example `https://vault.example.com`. It is the SDK's `vaultOrigin` and, by default, the token's `aud` |
| `VAULT_SERVICE_TOKEN` | The same value as the vault's |
| The handoff signing key and its `kid` | Ed25519 in hex for `createHandoffToken`, or any EdDSA, ES256 or RS256 key for `createHandoffSigner` or another JWT library |

`node scripts/generate-secrets.mjs` prints the vault's secrets to stdout and, on stderr, a `VAULT_HANDOFF_PRIVATE_KEY` (Ed25519, hex), a `VAULT_HANDOFF_KID` and the same `VAULT_SERVICE_TOKEN` for your backend. The handoff key goes to stderr so that redirecting stdout into the vault's environment never leaves it next to the vault. Using it is optional.

## 4. Your backend: the handoff token

Your backend authenticates the user and issues a JWT for the vault. The vault verifies it with the public keys you publish in a JWKS endpoint (or with a single configured Ed25519 key).

**This is not your session JWT.** It is a dedicated token, with the vault as `aud`, a lifetime of 60 seconds when minted by the SDK (the vault accepts at most 120 seconds), and a single-use `jti`. This way the vault never receives a token that is valid against your own API.

**The second factor is your responsibility.** The vault cannot check that the user passed 2FA: it trusts your signature. Mint this token only from a session with a complete login, and rate-limit your login. Anyone who can obtain a valid token for a user can open a vault session as that user, which gives access to that user's share A (see [What to protect](#what-to-protect)).

### Claims

| Claim | Value | Checked by the vault |
|---|---|---|
| `iss` | Your issuer | Must equal `HANDOFF_ISSUER` exactly |
| `aud` | The vault | Must equal `HANDOFF_AUDIENCE` (default: the vault's `ORIGIN`) |
| `sub` | Stable user id | `^[A-Za-z0-9_-]{1,64}$`. It identifies the wallet and must never change. Use a UUID or similar, not an email |
| `label` | Display label, for example the email | Must be a string. Stored as the user's label: put nothing sensitive in it |
| `origin` | Exact origin of the app that will open the popup, for example `https://app.example.com` | `https` (plain `http` only for local hosts outside production, or with `ALLOW_INSECURE_LOCAL=1`), no path, query, fragment or credentials. Must equal the browser-reported origin of the page that sends the request. **This claim is what authorizes that app to use the wallet** |
| `jti` | Unique id | `^[A-Za-z0-9_-]{1,64}$`. Single use: a second redemption is rejected |
| `iat`, `exp` | Integer seconds | `exp - iat <= 120`, `exp - now <= 120`, `iat <= now + 30`, and not expired |
| `chain` | Optional `{ chainId, rpcUrl? }` | `chainId` a positive safe integer; `rpcUrl` a string of at most 2048 characters. Must be present, with the same `chainId`, exactly when the operation targets a chain |

The JOSE header carries `alg` (`EdDSA`, `ES256` or `RS256` with a JWKS; `EdDSA` only with `HANDOFF_PUBLIC_KEY`) and `kid`. **`kid` is mandatory with a JWKS**, even if it holds a single key. The complete validation rules are in [docs/PROTOCOL.md](PROTOCOL.md#handoff-token).

About `chain`:

- Pick the network and its RPC **on your server**. Never accept an `rpcUrl` from the browser, or a compromised page could choose the node the vault talks to. The demo's token endpoint accepts only a `chainId` and looks the RPC up in its own configuration.
- The browser carries the token and can read it. An RPC URL with an API key belongs in the vault's `AA_CHAINS`, not in the token. An `rpcUrl` in `AA_CHAINS` takes precedence over the token's, and a token `rpcUrl` is only used when its host is listed in `RPC_ALLOWED_HOSTS`.
- `activate()`, `unlock()`, `recover()`, `export()` and `relink()` call `getToken()` without a chain: mint those tokens **without** `chain`. A token with a `chain` for an operation without one (or the reverse) is rejected with `CHAIN_REQUEST_MISMATCH`.

### Option 1: the SDK, with an Ed25519 key in hex

`createHandoffToken` signs a compact EdDSA JWT with a 32-byte Ed25519 private key in hex (for example the one from `scripts/generate-secrets.mjs`), and `handoffPublicJwk` derives the JWK to publish. This is `packages/sdk/examples/mint-token.ts`:

```ts
import { createHandoffToken, handoffPublicJwk, type HandoffClaims } from '@wl-embedded-wallet/sdk/server';

function config() {
  const { VAULT_HANDOFF_PRIVATE_KEY: privateKey, VAULT_HANDOFF_KID: kid, LOGIN_ISSUER: iss, VAULT_ORIGIN: aud, APP_ORIGIN: origin } = process.env;
  if (!privateKey || !kid || !iss || !aud || !origin) throw new Error('Missing handoff token configuration');
  return { privateKey, kid, iss, aud, origin };
}

// `origin` comes from your configuration, never from what the client sends: it authorizes that app to use the wallet.
// The user is already authenticated by your backend, with 2FA. `id` is stable and matches ^[A-Za-z0-9_-]{1,64}$.
export function mintVaultToken(user: { id: string; email: string }, chain?: HandoffClaims['chain']): string {
  const { privateKey, kid, iss, aud, origin } = config();
  return createHandoffToken({ sub: user.id, label: user.email, iss, aud, origin, kid, ...(chain ? { chain } : {}) }, privateKey);
}

// GET /.well-known/jwks.json. Public: public keys only.
export function jwksResponse(): Response {
  const { privateKey, kid } = config();
  return Response.json({ keys: [handoffPublicJwk(privateKey, kid)] }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
```

### Option 2: any JWT library, with EdDSA, ES256 or RS256

The vault verifies with `jose`, so any JWT library that supports one of the three algorithms can mint the token. This is `packages/sdk/examples/mint-token-jose.ts`, which does not use the SDK:

```ts
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

// Without the SDK, with any supported algorithm: EdDSA, ES256 or RS256.
export async function createSigner(alg: 'EdDSA' | 'ES256' | 'RS256', kid: string) {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return { alg, kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

// GET /.well-known/jwks.json. `jwk` only holds the public part.
export function jwksResponse(signers: { jwk: object }[]): Response {
  return Response.json({ keys: signers.map(({ jwk }) => jwk) }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}

export function mintVaultToken(
  signer: { alg: string; kid: string; privateKey: CryptoKey },
  user: { id: string; email: string },
  config: { iss: string; aud: string; origin: string },
): Promise<string> {
  return new SignJWT({ label: user.email, origin: config.origin })
    .setProtectedHeader({ alg: signer.alg, kid: signer.kid, typ: 'JWT' })
    .setIssuer(config.iss)
    .setAudience(config.aud)
    .setSubject(user.id)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(signer.privateKey);
}
```

Both examples are compiled and executed by `packages/sdk/tests/docs-example.test.ts`, which also checks that this document contains them verbatim. The vault verifies tokens produced the second way in `apps/vault/tests/unit/handoff.test.ts`.

If you use another library, make sure your `jti` matches `^[A-Za-z0-9_-]{1,64}$` (a UUID does) and that the header carries `kid`.

### Option 3: the SDK signers, with EdDSA, ES256 or RS256

`createHandoffSigner` loads an existing private key (PEM or a private JWK) and returns a signer whose `mint()` issues the same claims as `createHandoffToken`, with a 60-second lifetime and a random `jti`. Its `publicJwk` is ready for your JWKS. This snippet is illustrative (it is not part of the test suite); the functions it uses are covered by `packages/sdk/tests/server.test.ts`:

```ts
import { createHandoffSigner, jwksHandler } from '@wl-embedded-wallet/sdk/server';

// A P-256 private key in PKCS#8 PEM, for example from `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`.
const signer = createHandoffSigner({ alg: 'ES256', kid: 'handoff-1', privateKey: process.env.VAULT_HANDOFF_PRIVATE_KEY_PEM ?? '' });

export function mintVaultToken(user: { id: string; email: string }, chain?: { chainId: number; rpcUrl?: string }): Promise<string> {
  return signer.mint({
    sub: user.id,
    label: user.email,
    iss: 'https://login.example.com',
    aud: 'https://vault.example.com',
    origin: 'https://app.example.com',
    ...(chain ? { chain } : {}),
  });
}

// GET /.well-known/jwks.json
export const GET = jwksHandler(() => [signer.publicJwk]);
```

The key type must match `alg`: Ed25519 for `EdDSA`, P-256 for `ES256`, RSA of at least 2048 bits for `RS256`. Otherwise, or with an empty `kid`, `createHandoffSigner` throws `HandoffError('MALFORMED')`. `generateHandoffSigner(alg, kid)` creates a fresh, non-extractable key pair; it is meant for development and tests, because the private key cannot be exported and is lost when the process exits.

### The token endpoint

Expose an endpoint that requires a complete session, for example `POST /api/vault/token`, and protect it against CSRF. The demo's endpoint (`examples/demo/app/api/vault/token/route.ts`):

1. rejects any request whose `Origin` header is not exactly the demo's own origin (`FORBIDDEN_ORIGIN`, 403);
2. requires a session that has completed the second factor (`UNAUTHORIZED`, 401);
3. accepts an optional `{ chainId }` body and resolves it against its own chain list (`CHAIN_NOT_SUPPORTED`, 400, if unknown), adding the RPC from server configuration;
4. answers `{ "token": "<jwt>" }`.

Take `origin` from your server configuration, never from the request. If one login backend serves several apps, see [section 8](#8-several-apps-one-wallet).

### The JWKS endpoint

The JWKS endpoint is public and holds public keys only. The demo serves it with `jwksHandler` (`examples/demo/app/.well-known/jwks.json/route.ts`):

```ts
import { jwksHandler } from '@wl-embedded-wallet/sdk/server';
import { publishedJwks } from '@/server/handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public: only public keys. The vault verifies the tokens this backend issues with them. */
export const GET = jwksHandler(() => publishedJwks()?.keys ?? null);
```

`jwks()`, `jwksResponse()` and `jwksHandler()` refuse to publish a key that has any private member (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`). On the vault side, a JWKS document that contains private or symmetric keys is rejected and the vault also stops using its cached copy until a clean document is served.

The vault downloads the JWKS with a 5-second timeout, a 64 KiB size limit, and without following redirects: serve it with a direct `200`.

### Rotating the key

Without restarting the vault:

1. Publish the new public key next to the current one, and wait at least `HANDOFF_JWKS_CACHE_SECONDS` (300 seconds by default) so that every vault replica has fetched it.
2. Start signing with the new key. A token with an unknown `kid` also forces a refresh, but at most once per `HANDOFF_JWKS_COOLDOWN_SECONDS` (30 seconds by default); during the cooldown such tokens are rejected.
3. Remove the old key once its last tokens have expired. The vault stops accepting it after its next refresh.

The demo supports this with `DEMO_HANDOFF_PUBLISHED_KEYS`, a JSON list of `{ "kid", "publicKey" }` (hex) that stays published next to the signing key.

### What to protect

- **Compromising your JWKS endpoint is equivalent to compromising your signing key.** Whoever can change what it serves can add a key and mint valid tokens. Protect it like the key itself: same deployment, no third-party CDN that could alter it.
- **Whoever compromises your backend, your signing key or a live token obtains that user's share A**, because a token opens a vault session for its `sub`. This is an accepted risk. Share A alone does not rebuild the seed: the passkey (bound to the vault's domain) or the recovery code is also needed. With A and the code, it does. That is why the recovery code has 128 bits and must not be shortened. See [docs/THREAT-MODEL.md](THREAT-MODEL.md).
- **A token alone does not move a wallet to another account:** `relink()` requires a signature by the owner key over a message that names the token's `sub`. See [section 9](#9-linking-a-wallet-to-another-account).
- **If you publish a private key by mistake,** the vault rejects the document and fails closed until it is clean again. Consider that key compromised and rotate it.

## 5. Your frontend: the vault client

```ts
import { createVaultClient, VaultError, type VaultChain } from '@wl-embedded-wallet/sdk/client';

// Only the chain id is sent: the server resolves the RPC, never the browser.
async function requestToken(chain?: VaultChain): Promise<string> {
  const response = await fetch('/api/vault/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chain ? { chainId: chain.chainId } : {}),
  });
  if (!response.ok) throw new Error('TOKEN');
  const { token } = (await response.json()) as { token: string };
  return token;
}

const vault = createVaultClient({ vaultOrigin: 'https://vault.example.com', getToken: requestToken });
```

(Adapted from `examples/demo/app/wallet/wallet-panel.tsx`.)

### `createVaultClient(options)`

| Option | Type | Description |
|---|---|---|
| `vaultOrigin` | `string` | The vault's origin. It is normalized with `new URL(vaultOrigin).origin`, so a path is ignored. The SDK opens routes on this origin, posts requests only to it, and accepts messages only from it |
| `getToken` | `(chain?: VaultChain) => Promise<string>` | Fetches a fresh handoff token from your backend. Called **every time the popup signals `ready`**, because tokens are single-use. It receives the `chain` passed to the method (including any `rpcUrl` you put in it); the popup itself only ever receives `chainId`. If it throws, rejects or resolves with anything other than a non-empty string, the operation fails with `TOKEN_UNAVAILABLE` |
| `timeoutMs` | `number` (optional) | Rejects a pending operation with `TIMEOUT` this many milliseconds after the popup was opened, and closes the popup. Default: no timeout. It must be a positive finite number of at most 2147483647 (the largest timer delay browsers support); otherwise `createVaultClient` throws `RangeError('INVALID_TIMEOUT')` |
| `host` | `VaultHost` (optional) | The parts of `window` the SDK uses (`open`, `addEventListener`, `removeEventListener`, `setInterval`, `clearInterval`). Defaults to `globalThis.window`. Meant for tests |

`createVaultClient` itself does not touch the window; it can be created during rendering (the demo creates it in a `useMemo`).

### Popup and user-gesture rules

- **Call every method directly from a user gesture** (a click handler), with nothing asynchronous before it. Each method opens the popup synchronously, before returning its promise, so that browsers treat it as user-initiated. An `await` before the call (for example, fetching the token first) can get the popup blocked. The SDK fetches the token itself, after the popup has opened.
- The popup is opened with `window.open('<vaultOrigin>/<route>', 'wl-embedded-wallet-vault', 'popup,width=480,height=760')` and then focused. If `window.open` returns `null`, the method rejects with `POPUP_BLOCKED`.
- **One popup, one operation at a time.** The window name is fixed, so every operation reuses the same window. Starting a new operation while another is pending (from the same or another client on the same page) navigates the popup to the new route and rejects the pending one with `SUPERSEDED`.
- **Closing the popup** before the vault has answered rejects with `POPUP_CLOSED`, at any stage: before the vault page has loaded, while `getToken` is still pending (the token it returns afterwards is never sent) or after the request was sent. The SDK checks every 500 ms.
- **Timeout.** Without `timeoutMs`, a pending operation lasts until the vault answers, the popup is closed, or another operation supersedes it. With `timeoutMs`, it also ends with `TIMEOUT` once that time has passed since the popup was opened, whatever stage the operation is at. Leave enough time for the user to read a review screen and use a passkey. Inside the vault, a passkey prompt times out after 60 seconds; a passkey cancellation during signing, deployment or a transaction is not final (the user can retry or reject in the popup).
- **The SDK closes the popup only on `TIMEOUT`**, because nothing listens to it any more. Otherwise, after answering, the vault shows a final screen with a "Back to the app" button that focuses your page and closes the popup.
- **Results are validated.** A result for the operation that does not have the shape its method expects (see [Errors](#errors)) rejects at once with `PROTOCOL_ERROR`; the operation does not wait for the popup to be closed.
- When an operation ends, whatever the reason, the SDK removes its `message` listener and clears its timers.
- The vault page must keep its `window.opener`. Opened from anywhere else, it only shows "Open this window from the app". Do not open it with `noopener`, and do not serve your page with `Cross-Origin-Opener-Policy: same-origin`, which severs the opener of a cross-origin popup (`same-origin-allow-popups` keeps it).
- The vault cannot be embedded in an iframe (`frame-ancestors 'none'` and `X-Frame-Options: DENY`).
- Outside a browser (no `window` and no `host`), every method rejects with `NOT_IN_BROWSER`.

### Methods

Every method resolves with at least `{ address, owner }`: `address` is the Safe (the user's account) and `owner` is the Shamir-protected key that controls it. `chain` is a `VaultChain`, `{ chainId: number; rpcUrl?: string }`; only `chainId` is sent to the popup, and `getToken(chain)` receives the whole object.

| Method | Popup route | Resolves with | What it does |
|---|---|---|---|
| `activate()` | `/activate` | `VaultAccount` | Creates the user's wallet (passkey, recovery code, emergency kit). If the user already has one, returns it without creating another |
| `deploy(chain)` | `/deploy` | `VaultDeployment` | Deploys the Safe on that chain through the vault's bundler (and paymaster, if configured). Without `userOpHash`/`transactionHash`, the Safe was already deployed and nothing was signed |
| `signMessage(chain, message)` | `/sign` | `VaultSignature` | Safe signature (ERC-1271) of an EIP-191 message, valid on that chain. Requires the Safe to be deployed there |
| `signTypedData(chain, typedData)` | `/sign` | `VaultSignature` | Same, for EIP-712 typed data |
| `signUserOperation(chain, userOperation)` | `/sign` | `VaultUserOperationSignature` | Signs a v0.7 UserOperation for the deployed Safe. **It does not submit it** |
| `sendTransaction({ chain, to, value?, data? })` | `/transaction` | `VaultTransactionResult` | Sends one call from the deployed Safe on that chain. The vault server builds the UserOperation and the vault submits it and waits for the receipt. See [Sending a transaction](#sending-a-transaction) |
| `unlock()` | `/unlock` | `VaultAccount` | Checks that shares A and B rebuild the seed (a recovery drill) |
| `recover()` | `/recover` | `VaultAccount` | Lost passkey: rebuilds with A and C (or with the kit) and creates a new passkey and code, for the same Safe |
| `export()` | `/export` | `VaultAccount` | Opens the seed export flow in the vault. The seed never reaches the SDK |
| `relink()` | `/relink` | `VaultAccount` | For an account without a wallet: the user proves control of an existing wallet in the vault and it is linked to this account. The previous account loses access |

Result types:

```ts
type VaultAccount = { address: `0x${string}`; owner: `0x${string}` };
type VaultSignature = VaultAccount & { signature: `0x${string}` };
type VaultUserOperationSignature = VaultSignature & { userOperation: UserOperationJson };
type VaultDeployment = VaultAccount & { userOpHash?: `0x${string}`; transactionHash?: `0x${string}` };
// Included on-chain, and its call succeeded.
type VaultTransactionResult = VaultAccount & { chainId: number; userOpHash: `0x${string}`; transactionHash: `0x${string}` };
```

Request types (from `@wl-embedded-wallet/core/operations`, re-exported by all three SDK entry points):

```ts
type TypedDataRequest = {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Amounts in wei as decimal strings, so they are JSON-serializable.
type VaultCall = { to: `0x${string}`; value: string; data?: `0x${string}` };

// For an already deployed Safe: never carries `factory`. It is signed, not sent.
type UserOperationRequest = {
  calls: VaultCall[];
  nonce: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

// `sendTransaction`'s argument (`@wl-embedded-wallet/sdk/client`). `value` in wei, default 0.
interface VaultTransactionRequest {
  chain: VaultChain;
  to: `0x${string}`;
  value?: bigint | string;
  data?: `0x${string}`;
}
```

The vault validates every signing request before showing it; anything that does not pass is answered with `INVALID_REQUEST` and nothing is signed. The limits, from `packages/core/src/sign-request.ts`:

- `message`: a non-empty string of at most 10,000 characters.
- `typedData`: only the keys `domain`, `types`, `primaryType`, `message`; at most 64,000 characters as JSON; `primaryType` must be a key of `types`; it must hash with viem's `hashTypedData`.
- `userOperation`: only the keys listed above; 1 to 16 calls; every quantity a decimal string (no leading zeros, at most 2^256 - 1); `callGasLimit`, `verificationGasLimit` and `maxFeePerGas` greater than zero; `maxPriorityFeePerGas <= maxFeePerGas`. Each call has only `to` (an address), `value` (decimal) and optional `data` (even-length hex, at most 128,000 characters).
- `sendTransaction`: the same rules as one call. The SDK checks them before opening the popup (`to` a 20-byte hex address; `value` a `bigint` or a decimal string between 0 and 2^256 - 1; `data` even-length hex) and rejects with `INVALID_REQUEST` without opening it. It sends `value` as a decimal string and drops an empty `data` (`0x`).

The vault's review screen shows the requesting origin (already verified against the token), the network and the decoded request. A compromised app can still request any signature: the last barrier is the user reading the review screen.

### A typical flow

```ts
// Your backend asks the vault (server-to-server) and answers with the account.
const account = await fetch('/api/wallet').then((response) => response.json());

// Each of these lines runs in its own click handler.
if (!account.exists) await vault.activate();
const chain = { chainId: 11155111 };
await vault.deploy(chain);
const { signature } = await vault.signMessage(chain, 'Sign in to Example App');
```

Then send the signature to your backend and verify it there ([section 6](#6-verifying-results-on-your-backend)).

### Sending a transaction

`sendTransaction` sends one call (`to`, `value`, `data`) from the user's Safe, always as a CALL: a delegatecall or a batch cannot be requested. Your app chooses only the call. The vault server builds the UserOperation (nonce from the EntryPoint, fees and gas within its caps, paymaster fields only where the chain sponsors transactions); the popup shows it, the user approves it with the passkey, and the vault submits it and waits up to 3 minutes for the receipt.

```ts
import { encodeFunctionData, erc20Abi, parseEther } from 'viem';

const chain = { chainId: 11155111 };

// A native transfer: 0.01 ETH, paid from the Safe's balance.
const { userOpHash, transactionHash } = await vault.sendTransaction({ chain, to: '0xRecipient...', value: parseEther('0.01') });

// A contract call: an ERC-20 transfer of 5 tokens with 6 decimals. `value` defaults to 0.
const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: ['0xRecipient...', 5_000_000n] });
await vault.sendTransaction({ chain, to: '0xToken...', data });
```

(Not taken from the demo. The demo's wallet page groups its signing panels in tabs, Message (EIP-191), Typed data (EIP-712) and Transaction; its Transaction tab, in `examples/demo/app/wallet/sign-forms.tsx`, converts an amount in native units with `parseEther` and calls `client.sendTransaction({ chain, ...call })`.)

Requirements:

- **The Safe must be deployed on that chain** (`deploy(chain)` first). Otherwise the popup answers `WALLET_NOT_DEPLOYED`. The chain needs a `bundlerUrl` in `AA_CHAINS` (`CHAIN_NOT_SUPPORTED` otherwise).
- **Who pays the fee.** Only if the vault operator set `"sponsorTransactions": true` for that chain (with a `paymasterUrl`) does the paymaster pay it. Otherwise the Safe pays it in the native currency: its balance must cover `value` plus the maximum fee, `(callGasLimit + verificationGasLimit + preVerificationGas) × maxFeePerGas`, or the vault refuses with `INSUFFICIENT_FUNDS` before anything is sent. `value` is always paid by the Safe. Whether a chain sponsors transactions is `transactionsSponsored` in the [server-to-server API](#7-server-to-server-api).
- **No calls to the Safe itself with data** (`CALL_NOT_ALLOWED`): they could change its owners, modules or guard. A value-only transfer to the Safe itself is allowed.

What the user reviews in the popup: your verified origin, the network and its RPC host, the Safe, the recipient, the amount with the chain's native currency symbol, the data in hex and, when it matches, the decoded ERC-20 `transfer` or `approve` (with a caution for `approve`, and a caution for data it cannot decode), and either "Sponsored" or the maximum network fee.

The promise resolves only once the operation was included on-chain and its call succeeded, with `{ address, owner, chainId, userOpHash, transactionHash }`. Otherwise it rejects; the codes specific to this method:

| Code | Meaning |
|---|---|
| `TRANSACTION_REVERTED` | Included on-chain, but the call failed. The fee was paid. The popup shows the hashes; the app does not receive them |
| `TRANSACTION_TIMEOUT` | Sent, but no receipt within 3 minutes. It may still be included: check before sending again. The popup shows the UserOperation hash |
| `CALL_REVERTED` | The bundler's simulation says the call would fail. Nothing was sent |
| `INSUFFICIENT_FUNDS` | The Safe cannot pay `value` (and, when not sponsored, the fee). Nothing was sent |
| `SPONSORSHIP_REJECTED` | The paymaster refused (for example, its policy is inactive or out of funds). Nothing was sent |
| `NONCE_CONFLICT` | Another operation from the Safe went through first. Nothing was sent; retry |
| `TRANSACTION_EXPIRED` | The user took more than 10 minutes to approve; the prepared fees are no longer accepted. Nothing was sent; retry |
| `TRANSACTION_IN_PROGRESS` | This exact operation is already being sent |
| `TRANSACTION_FAILED` | The bundler did not accept the operation, or the vault refused it for a reason not listed here |

`USER_REJECTED`, `WALLET_NOT_DEPLOYED`, `CALL_NOT_ALLOWED`, `FEES_TOO_HIGH`, `GAS_LIMIT_EXCEEDED`, `RATE_LIMITED`, the `CHAIN_*` codes, `INVALID_REQUEST` and `UNAUTHORIZED` can also come back ([Errors](#errors)). `TRANSACTION_REVERTED` and `TRANSACTION_TIMEOUT` mean the operation was sent. So may `POPUP_CLOSED`, `TIMEOUT` or `NETWORK` once the user has approved, since the vault may have submitted it before: check the Safe's activity before asking the user to send it again.

`signUserOperation` is unchanged: it signs an operation you build and submit yourself ([section 6](#signuseroperation)), and the vault never submits it.

### Errors

Every method rejects with `VaultError`. Its `code` is a string, and its `message` is the same code (it never includes the token or other data).

```ts
try {
  await vault.signMessage(chain, message);
} catch (error) {
  const code = error instanceof VaultError ? error.code : 'INTERNAL';
}
```

Codes produced by the SDK itself (`VaultErrorCode`):

| Code | Meaning |
|---|---|
| `POPUP_BLOCKED` | `window.open` returned `null`. Call the method directly from a user gesture |
| `POPUP_CLOSED` | The popup was closed before the vault answered |
| `TOKEN_UNAVAILABLE` | `getToken` threw, rejected or did not return a non-empty string. Nothing was sent to the popup |
| `SUPERSEDED` | Another operation was started on the same page and replaced this one |
| `NOT_IN_BROWSER` | No `window` and no `host` |
| `TIMEOUT` | `timeoutMs` passed before the vault answered. The SDK closed the popup |
| `PROTOCOL_ERROR` | The vault's result for this operation was malformed (see below) |
| `INVALID_REQUEST` | `sendTransaction` with a malformed call or chain. The popup was not opened |
| `INTERNAL` | `window.open` threw, or the request could not be posted to the popup (for example, a `typedData` that cannot be cloned) |

What the SDK validates in a result for its own operation (same `protocol`, `type: 'result'` and `id`; other messages are ignored). Anything else is `PROTOCOL_ERROR`:

- `ok` must be `true` or `false`. `ok: false` must carry a non-empty string `code`, which becomes the error's `code`.
- Every `ok: true` result: `address` and `owner` are 20-byte hex addresses (`0x` and 40 hex digits, any case).
- `deploy`: either both `userOpHash` and `transactionHash`, each 32-byte hex (`0x` and 64 hex digits), or neither.
- `sendTransaction`: both `userOpHash` and `transactionHash` as 32-byte hex, and `chainId` equal to the requested chain's.
- `signMessage`, `signTypedData`: `signature` is non-empty, even-length hex with `0x`.
- `signUserOperation`: the same `signature`, and a `userOperation` with every `UserOperationJson` field: `sender` an address equal (ignoring case) to `address`; `nonce`, `callGasLimit`, `verificationGasLimit`, `preVerificationGas`, `maxFeePerGas`, `maxPriorityFeePerGas` decimal strings without leading zeros; `callData` even-length hex; `factory` and `paymaster` an address or `null`; `factoryData` and `paymasterData` even-length hex or `null`; `paymasterVerificationGasLimit` and `paymasterPostOpGasLimit` a decimal string or `null`; `signature` equal to the result's `signature`.
- Fields a method does not define are dropped (for example, a seed in an `export` result, or extra keys in `userOperation`).

Any other code is the one the vault returned, passed through unchanged. The codes the vault can return, from the vault's sources (`packages/core/src/errors.ts`, `apps/vault/lib/prf.ts`, `apps/vault/lib/error-text.ts`, `apps/vault/lib/aa-client.ts` and the flow pages under `apps/vault/app/`):

| Code | Meaning |
|---|---|
| `USER_REJECTED` | The user rejected the operation. Nothing was signed |
| `INVALID_REQUEST` | Malformed request, a signing request that failed validation, or a request whose action does not match the popup route |
| `UNAUTHORIZED` | The token was invalid, expired, already used, signed by an unknown key, or the JWKS was unavailable (the vault does not tell these apart), or the vault session expired |
| `ORIGIN_MISMATCH` | The token's `origin` is not the origin of the page that sent the request |
| `ORIGIN_NOT_ALLOWED` | The token's `origin` is not in the vault's `ALLOWED_APP_ORIGINS` |
| `CHAIN_REQUEST_MISMATCH` | The operation's chain differs from the token's `chain` (or one has a chain and the other does not) |
| `NO_WALLET` | The user has no wallet yet |
| `WALLET_ALREADY_EXISTS` | `relink()` on an account that already has a wallet |
| `RELINK_REJECTED` | The owner's signature or the relink challenge was invalid or expired. Nothing changed. The popup shows it and posts it to the app; to retry, call `relink()` again |
| `WALLET_NOT_DEPLOYED` | Deploy the Safe on that chain before signing or sending a transaction |
| `CHAIN_NOT_SUPPORTED` | No usable RPC for the chain, missing contracts, a different predicted address, or (for `deploy` and `sendTransaction`) no bundler configured |
| `CHAIN_MISMATCH` | The RPC reports another chain id |
| `CHAIN_UNAVAILABLE` | The chain could not be queried |
| `INSUFFICIENT_FUNDS` | The Safe cannot pay for the operation: its deployment on a chain without a paymaster, or a transaction's `value` (plus its fee, when not sponsored). Also the bundler's `AA21`. Nothing was sent |
| `DEPLOY_FAILED` | The deployment UserOperation failed, no receipt arrived, or the vault or the bundler refused it for a reason not listed here (a paymaster rejection is `SPONSORSHIP_REJECTED`, a nonce conflict `NONCE_CONFLICT`) |
| `CALL_NOT_ALLOWED`, `CALL_REVERTED`, `SPONSORSHIP_REJECTED`, `NONCE_CONFLICT`, `TRANSACTION_*` | See [Sending a transaction](#sending-a-transaction). `SPONSORSHIP_REJECTED` and `NONCE_CONFLICT` can also come from `deploy` |
| `FEES_TOO_HIGH` | `deploy`, `sendTransaction`: the network's fees are above the vault's cap. Nothing was sent; retry later |
| `GAS_LIMIT_EXCEEDED` | `deploy`, `sendTransaction`: the operation would need more gas than the vault's caps allow. Nothing was sent; tell the vault operator |
| `ALREADY_SPONSORED` | `deploy`: a deployment of this Safe on this chain was already sent recently (`AA_DEPLOYMENT_RETRY_SECONDS`, 15 minutes by default). Wait for it, then check the status |
| `DEPLOYMENT_IN_PROGRESS` | `deploy`: another request is submitting this Safe's deployment. Retry in a moment |
| `RATE_LIMITED` | Any action: one of the vault's rate limits or budgets was exceeded (HTTP 429 on token redemption, share A, enrollment, kit-free recovery, relink, the chain status, the deployment and transaction proxy, or preparing transactions). Retry later |
| `MANIFEST_INVALID`, `SHARE_TAMPERED`, `ADDRESS_MISMATCH`, `FORMAT_UNSUPPORTED`, `KDF_PARAMS_INVALID`, `COMBINE_FAILED` | Stored data failed an integrity check. The operation stops before the seed is used |
| `DECRYPT_FAILED` | Wrong passkey or recovery code, or tampered data |
| `BAD_RECOVERY_CODE`, `INVALID_KIT`, `NO_SEED_BACKUP`, `RECOVERY_FAILED` | Recovery-flow failures (see [docs/RECOVERY.md](RECOVERY.md)) |
| `CANCELLED`, `WEBAUTHN_FAILED`, `PRF_NOT_RETURNED`, `PRF_UNSUPPORTED` | Passkey failures. `PRF_UNSUPPORTED` means the authenticator lacks the PRF extension, which the vault requires |
| `SERVER_KEY_MISMATCH` | The vault's `MASTER_KEY` does not decrypt its data. Notify the vault operator |
| `NETWORK` | The popup could not reach the vault server |
| `INTERNAL` | Any other failure. Never carries sensitive data |

Not every code can come from every method, and this list is derived from reading the code rather than from a formal contract: treat any unknown code as a generic failure.

## 6. Verifying results on your backend

**Never trust an address or a signature only because the browser sent it.** The SDK only checks the shape of a result ([Errors](#errors)), not that a signature is valid or that the address is the user's. On your backend:

1. Get the user's `address` and `owner` from the vault, server-to-server (`createVaultServiceClient().getAccount(sub)`), never from the browser.
2. Take the chain (and its RPC) from your own configuration, never from the browser.
3. Verify the signature against those values.

`examples/demo/server/verify.ts` implements all of the following.

### `signMessage` and `signTypedData`

The returned `signature` is the owner's ECDSA signature over Safe's `SafeMessage` EIP-712 structure, whose domain is `{ chainId, verifyingContract: <Safe> }` and whose message is the EIP-191 hash of the message (or the EIP-712 hash of the typed data). It is therefore bound to that Safe and that chain: it does not validate on another chain. The vault only signs on a chain where the Safe is already deployed (`WALLET_NOT_DEPLOYED` otherwise), so the signatures are plain ERC-1271 signatures, not ERC-6492 wrapped ones.

There are two complementary checks:

- **ERC-1271, on-chain (what any third party will do):** call `isValidSignature(bytes32 hash, bytes signature)` on the Safe, with `hash = requestHash(request)`, and expect `ERC1271_MAGIC_VALUE` (`0x1626ba7e`). This reflects the Safe's current on-chain owners. A Safe that is not deployed on that chain has no code and cannot validate anything.
- **Owner recovery, off-chain:** `recoverSafeMessageSigner(safe, chainId, requestHash(request), signature)` returns the address that signed, which must equal the `owner` reported by the vault. It needs no RPC, but it does not prove that this key still owns the Safe on-chain.

The demo requires both:

```ts
import { ERC1271_MAGIC_VALUE, recoverSafeMessageSigner, requestHash, type VaultSignRequest } from '@wl-embedded-wallet/sdk/server';
import { createPublicClient, http, isAddressEqual, type Hex } from 'viem';

const ERC1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

// `account` comes from the vault (server-to-server) and `chain` from your configuration.
async function verifySafeSignature(
  request: Extract<VaultSignRequest, { kind: 'message' | 'typedData' }>,
  signature: Hex,
  account: { address: `0x${string}`; owner: `0x${string}` },
  chain: { chainId: number; rpcUrl: string },
): Promise<boolean> {
  const hash = requestHash(request);
  const recovered = await recoverSafeMessageSigner(account.address, chain.chainId, hash, signature);
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  if ((await client.getChainId()) !== chain.chainId) return false;
  const value = await client.readContract({ address: account.address, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hash, signature] });
  return isAddressEqual(recovered, account.owner) && value.toLowerCase() === ERC1271_MAGIC_VALUE;
}
```

(Condensed from `examples/demo/server/verify.ts`, which also treats a reverted call as invalid: the Safe reverts on a signature made for another chain.) viem's `publicClient.verifyMessage` and `verifyTypedData` with `address: <Safe>` perform an equivalent ERC-1271 check.

**Replay across apps:** a message signature made in one app is valid wherever that Safe and chain are, including in another app that shares the wallet. Use messages that name their domain (SIWE, or EIP-712 with a domain).

### `sendTransaction`

The result reports what the vault saw: the operation was included and its call succeeded. If your backend acts on it (for example, it credits a payment), confirm it with your own RPC: the receipt of `transactionHash` must contain the EntryPoint v0.7 `UserOperationEvent` with that `userOpHash`, `sender` equal to the user's Safe (from the vault, server-to-server) and `success` true.

### `signUserOperation`

The vault builds the UserOperation from your `UserOperationRequest` (`buildUserOperation`: `sender` is the Safe, `factory` and `paymaster` fields are `null`, `callData` encodes your calls with Safe's single-call or MultiSend encoding) and signs the Safe operation hash with the owner. `signature` in the result equals `userOperation.signature`: 12 bytes of `validAfter`/`validUntil` followed by the owner's 65-byte ECDSA signature.

Before submitting it:

1. Check that the returned operation is what you asked for: `userOperationMatches(userOperation, request, safe)` compares `sender`, `callData`, the nonce and every gas field, and requires `factory`, `factoryData` and `paymaster` to be `null`.
2. Check that the owner signed it: `recoverSafeOperationSigner(userOperation, chainId)` must equal the vault-reported `owner`.

```ts
import { recoverSafeOperationSigner, userOperationMatches, type UserOperationJson, type UserOperationRequest } from '@wl-embedded-wallet/sdk/server';
import { isAddressEqual } from 'viem';

async function verifyUserOperation(
  request: UserOperationRequest,
  operation: UserOperationJson,
  account: { address: `0x${string}`; owner: `0x${string}` },
  chainId: number,
): Promise<boolean> {
  const recovered = await recoverSafeOperationSigner(operation, chainId);
  return isAddressEqual(recovered, account.owner) && userOperationMatches(operation, request, account.address);
}
```

(Condensed from `examples/demo/server/verify.ts`; the demo also wraps both calls in `try`/`catch` and treats a throw as invalid.)

3. Submit it yourself. The vault never submits a UserOperation it did not build: its bundler proxy only accepts the deployment of the session's Safe and the transactions it prepared itself for `sendTransaction`. Convert it with `toRpcUserOperation(userOperation)` (hex quantities, empty fields omitted, the ERC-7769 JSON-RPC shape) and send it with `eth_sendUserOperation` to your bundler, with `DEFAULT_SAFE_PARAMS.entryPoint` (EntryPoint v0.7) as the second parameter. `userOperationHash(userOperation, chainId)` computes the hash the bundler will return.

Because the signature covers the paymaster fields, which the vault leaves empty, a paymaster cannot be attached after signing: the Safe must pay for the operation itself. You choose the nonce and gas values in the request; the vault does not estimate them. To have the vault build, sponsor (where configured) and submit the operation instead, use `sendTransaction`.

## 7. Server-to-server API

Only from your backend. Never expose `VAULT_SERVICE_TOKEN` to the browser. The vault is the single source of truth for a user's wallet address and its state on each chain. Full details in [docs/HTTP-API.md](HTTP-API.md).

```bash
curl -H "Authorization: Bearer $VAULT_SERVICE_TOKEN" "$VAULT_ORIGIN/api/s2s/accounts/$SUB"
```

```json
{ "exists": true, "address": "0xSafe...", "owner": "0xOwner..." }
```

Without a wallet: `{ "exists": false, "address": null, "owner": null }`. With a missing or wrong token: `401 { "error": "UNAUTHORIZED" }`.

With the state on one chain:

```bash
curl -H "Authorization: Bearer $VAULT_SERVICE_TOKEN" "$VAULT_ORIGIN/api/s2s/accounts/$SUB?chainId=11155111"
```

```json
{ "exists": true, "address": "0xSafe...", "owner": "0xOwner...", "chainId": 11155111, "deployed": false, "deployable": true, "sponsored": true, "transactionsSponsored": false }
```

- `deployed`: whether the Safe has code on that chain. `deployable`: whether the vault can deploy it there (it is not deployed and the chain has a `bundlerUrl` in `AA_CHAINS`). `sponsored`: whether the chain has a `paymasterUrl` (the deployment is sponsored). `transactionsSponsored`: whether `sendTransaction` is sponsored too (a `paymasterUrl` and `"sponsorTransactions": true`); when `false`, the Safe pays the fee of its transactions.
- If the chain cannot be used: `{ ..., "deployed": null, "deployable": false, "chainError": "CHAIN_NOT_SUPPORTED" }` (or `CHAIN_MISMATCH`, `CHAIN_UNAVAILABLE`).
- If the chain has no `rpcUrl` in `AA_CHAINS`, add `&rpcUrl=` with a URL whose host is in the vault's `RPC_ALLOWED_HOSTS`.
- A `chainId` that is not a positive safe integer: `400 { "error": "INVALID_CHAIN_ID" }`, whether or not the user has a wallet. A valid `chainId` is ignored for a user without a wallet.
- A `sub` that does not match `^[A-Za-z0-9_-]{1,64}$`, the pattern of the token's `sub`: `400 { "error": "INVALID_SUB" }`. No account can have another `sub`.
- Over the rate limit (`s2s` scope: 600 per minute per IP, which your backend's requests share, and 60 per minute per `sub`, by default): `429 { "error": "RATE_LIMITED" }` with `Retry-After`. The per-IP limit is counted before the bearer token is checked; raise it with the vault's `RATE_LIMITS` if your backend makes many calls ([docs/DEPLOYMENT.md](DEPLOYMENT.md#rate-limits)).
- Invalid input is rejected before anything is looked up, so the answer does not reveal whether the account exists.

`GET /api/health` needs no token: `200 { "status": "ok" }`, or `503` if the database does not respond.

The SDK wraps the account route:

```ts
import { createVaultServiceClient, VaultUnavailableError } from '@wl-embedded-wallet/sdk/server';

const client = createVaultServiceClient({ vaultOrigin: process.env.VAULT_ORIGIN ?? '', serviceToken: process.env.VAULT_SERVICE_TOKEN ?? '' });

try {
  const account = await client.getAccount(user.id, { chainId: 11155111 });
  if (account.exists) console.log(account.address, account.deployed);
} catch (error) {
  if (error instanceof VaultUnavailableError) {
    // Network error, timeout, any non-2xx status (including 401, 400 INVALID_SUB and 429) or an unexpected body.
  }
}
```

`getAccount(sub, chain?)` sends `GET {vaultOrigin}/api/s2s/accounts/{encodeURIComponent(sub)}`, with `chainId` and, if given, `rpcUrl` as query parameters, the bearer token, `cache: 'no-store'` and a 15-second timeout (`timeoutMs`). Trailing slashes in `vaultOrigin` are removed; nothing else is rewritten, so pass the origin itself, without a path. It returns `VaultServiceAccount` only if `exists` is `false`, or if it is `true` and `address` and `owner` are 20-byte hex addresses; anything else throws `VaultUnavailableError`.

The remaining vault routes are internal to the popup and may change.

## 8. Several apps, one wallet

Several apps, on any domains, can share your login and your JWKS, and therefore the same wallet:

- **Identity:** a wallet belongs to a `sub` under the vault's single `HANDOFF_ISSUER`. Two apps with the same login and the same `sub` see the same Safe. A vault does not support several issuers.
- **Passkey:** works from any app, because its relying party is the vault's own host (`RP_ID`), not the app's.
- **Domain:** nothing has to be registered in the vault. Each app is authorized by the `origin` claim of its tokens. The popup redeems the token together with the `event.origin` set by the browser for the request message; if it differs from the signed `origin`, the vault answers `ORIGIN_MISMATCH`. The review screen shows that verified origin, and results are posted only to it.
- **Optional restriction:** with `ALLOWED_APP_ORIGINS` set, a valid token for any other origin is rejected with `ORIGIN_NOT_ALLOWED`.

**If your login backend is shared by several apps, validate the request's `Origin` against your own list and never reflect it into the claim unchecked.** Reflecting it would let any website obtain a token for its own origin and use the wallet of a signed-in user. If each app has its own backend, take `origin` from its configuration, as `examples/demo` does (its `DEMO_HANDOFF_ISSUER` is the shared issuer, its `ORIGIN` the app-specific origin).

Other consequences:

- A compromise of any of the apps affects the shared wallet.
- A message signature made in one app can be replayed in another if the message does not name its domain. Use SIWE or EIP-712 with a domain.

## 9. Linking a wallet to another account

For a user who lost access to their login: they sign in to your app with a new account, which has no wallet, and prove in the vault that they control an existing one (with their emergency kit and recovery code, or with their passkey and recovery code). Offer it on the account screen when there is no wallet, as `examples/demo` does:

```ts
const { address, owner } = await vault.relink();
```

- **Your backend does not change:** it mints the usual token for the new `sub`. From then on, `GET /api/s2s/accounts/{sub}` returns the wallet for the new `sub`, and `{ "exists": false, ... }` for the previous one.
- **If your backend stores the user's address, fetch it again** after `relink()` and update whatever you linked to the previous `sub`. The vault does not notify your backend.
- **The previous `sub` loses access immediately**, and its vault sessions are deleted. If it signs in again, it has no wallet and may activate a new one.
- **A valid token is not enough.** The owner key must sign an EIP-712 message (`WalletRelink`) that the vault server rebuilds from its own values: the Safe, the owner, the new `sub`, `HANDOFF_ISSUER`, the vault origin, a single-use nonce and its expiry. Without that signature the vault server refuses with `RELINK_REJECTED`, which the popup shows to the user (it is not posted to your app; the promise stays pending until the user succeeds or closes the popup). On an account that already has a wallet, `relink()` rejects with `WALLET_ALREADY_EXISTS`.
- **Anyone with the kit and the code, or the passkey and the code, can link the wallet to their account.** If your app grants more than the wallet, do not assume the account belongs to the original owner only because it now has the wallet.

## 10. Recovery: what to tell your users

What your app should tell its users: **whoever has their emergency kit and their recovery code obtains their seed, without the passkey or the server. They must keep them apart.** The vault says so when it shows the code and when the kit is downloaded.

Every time the vault hands out a kit (at activation, on rotation, or when a new one is generated), the user first downloads the offline recovery tool: the kit download is only enabled after that, because without the tool the kit cannot be opened if the service disappears. If your app walks the user through activation, expect two downloads: first the recovery tool, then the kit.

| The user lost | How they continue | Where |
|---|---|---|
| The passkey | A+C, then a new passkey and code | `recover()`, tab "I lost my passkey" |
| The server (or its `MASTER_KEY`) | Signs or downloads the seed with kit, passkey and code | `/recover`, tab "Without the server" |
| The server and the vault domain | Gets the seed with kit and code | The offline recovery tool |
| The kit | Signs, downloads the seed or links with passkey and code | `/recover`, tab "Without a kit" |
| The login | Links the wallet to a new account | `relink()` |

Signatures made from the recovery tabs (B+C) are not submitted and do not check whether the Safe is deployed; they are shown to the user in the vault and never reach your app. The details, and the static and offline recovery tools, are in [docs/RECOVERY.md](RECOVERY.md).

## 11. Networks, deployment and paymaster

The Safe has the **same address on every EVM network**, because it depends only on the owner and on fixed parameters signed into the user's manifest (`DEFAULT_SAFE_PARAMS`). Deployment is per network.

Before using a network, the vault checks that:

1. the RPC's `eth_chainId` matches the requested chain;
2. the Safe factory and the Safe 4337 module have code;
3. simulating the factory returns exactly the predicted Safe address.

If anything fails, it refuses the network (`CHAIN_MISMATCH` or `CHAIN_NOT_SUPPORTED`) and never shows another address. zkSync, for example, computes CREATE2 differently.

**Risk:** changing the owner on one network does not propagate, and on networks where the Safe is not deployed yet it is always created with the original owner. If the owner key is stolen, changing the owner on one network is not enough elsewhere.

`AA_CHAINS` (vault side) is a JSON object keyed by chain id: `{ name?, rpcUrl?, bundlerUrl, bundlerHeaders?, paymasterUrl?, paymasterHeaders?, paymasterContext?, sponsorTransactions?, limits? }`. `deploy()` and `sendTransaction()` need a `bundlerUrl`; `paymasterUrl` requires `bundlerUrl`. `sponsorTransactions` (default `false`; `true` requires `paymasterUrl`) makes the paymaster pay for transactions too, not only deployments. `limits` overrides the sponsorship caps for that chain; set it on every L2 ([docs/DEPLOYMENT.md](DEPLOYMENT.md#sponsorship-limits)).

The vault speaks [ERC-7677](https://eips.ethereum.org/EIPS/eip-7677) to the chain's `paymasterUrl`, so you can use a provider or your own service, which is where your gas policy lives:

| Method | Parameters |
|---|---|
| `pm_getPaymasterStubData` | `[userOperation, entryPoint, chainIdHex, paymasterContext]` |
| `pm_getPaymasterData` | The same |

The answer is the ERC-7677 one: `paymaster`, `paymasterData` and optionally `paymasterVerificationGasLimit` and `paymasterPostOpGasLimit`. Your policy should:

- **Cap spending** per user, chain and day. Every deployment spends your balance, and so does every transaction on a chain with `sponsorTransactions`: a sponsored transaction can be any call the user approves, and the vault limits how many there are only through its rate limits. The vault bounds each operation with its own gas and fee caps ([docs/DEPLOYMENT.md](DEPLOYMENT.md#sponsorship-limits)), sends at most one deployment per Safe and chain within `AA_DEPLOYMENT_RETRY_SECONDS`, and rate-limits requests (the `transaction` scope for preparing transactions), but it does not know your budget. With Pimlico, set per-user and global spending limits on the sponsorship policy.
- **Authenticate the vault** with `paymasterHeaders`. The URL must not be public.
- **Identify the policy** with `paymasterContext`, which the vault server sets; the browser does not choose it.

The vault's server **builds the deployment of the session's Safe itself**, on the session's chain, calling `pm_getPaymasterStubData` and then `pm_getPaymasterData` for each prepared deployment, and forwards only that operation, signed by the owner. It does the same for each `sendTransaction`, with the paymaster calls only where `sponsorTransactions` is on. Operations from `signUserOperation` are signed but not sent: receive the signed UserOperation on your backend and submit it ([section 6](#signuseroperation)).

This path, deployments and transactions, has been tested with a real paymaster contract on `anvil`, not with real providers. See [docs/TEST-STATUS.md](TEST-STATUS.md).

## 12. API reference

### `@wl-embedded-wallet/sdk/client`

Browser only. Re-exports everything in `/protocol`.

| Export | Kind | Description |
|---|---|---|
| `createVaultClient(options: VaultClientOptions): VaultClient` | function | See [section 5](#createvaultclientoptions) |
| `VaultError` | class | `extends Error`, `name = 'VaultError'`, `readonly code: string`, `message === code` |
| `VaultErrorCode` | type | `'INVALID_REQUEST' \| 'POPUP_BLOCKED' \| 'POPUP_CLOSED' \| 'TOKEN_UNAVAILABLE' \| 'SUPERSEDED' \| 'NOT_IN_BROWSER' \| 'TIMEOUT' \| 'PROTOCOL_ERROR' \| 'INTERNAL'` |
| `VaultClientOptions` | type | `{ vaultOrigin: string; getToken: (chain?: VaultChain) => Promise<string>; timeoutMs?: number; host?: VaultHost }` |
| `VaultClient` | type | The ten methods in [section 5](#methods) |
| `VaultAccount`, `VaultSignature`, `VaultUserOperationSignature`, `VaultDeployment`, `VaultTransactionResult` | types | Method results |
| `VaultTransactionRequest` | type | `sendTransaction`'s argument: `{ chain: VaultChain; to; value?: bigint \| string; data? }` |
| `VaultHost`, `VaultPopup` | types | The window surface the SDK uses, for injection in tests |

```ts
interface VaultClient {
  activate(): Promise<VaultAccount>;
  deploy(chain: VaultChain): Promise<VaultDeployment>;
  signMessage(chain: VaultChain, message: string): Promise<VaultSignature>;
  signTypedData(chain: VaultChain, typedData: TypedDataRequest): Promise<VaultSignature>;
  signUserOperation(chain: VaultChain, userOperation: UserOperationRequest): Promise<VaultUserOperationSignature>;
  sendTransaction(request: VaultTransactionRequest): Promise<VaultTransactionResult>;
  unlock(): Promise<VaultAccount>;
  recover(): Promise<VaultAccount>;
  export(): Promise<VaultAccount>;
  relink(): Promise<VaultAccount>;
}

interface VaultHost {
  open(url: string, target: string, features: string): VaultPopup | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}

interface VaultPopup {
  closed: boolean;
  postMessage(message: unknown, targetOrigin: string): void;
  focus?(): void;
  // Only called on TIMEOUT.
  close?(): void;
}
```

### `@wl-embedded-wallet/sdk/protocol`

| Export | Kind | Value or shape |
|---|---|---|
| `VAULT_PROTOCOL` | constant | `'wl-embedded-wallet/protocol/v1'` |
| `VAULT_WINDOW_NAME` | constant | `'wl-embedded-wallet-vault'` |
| `VaultChain` | type | `{ chainId: number; rpcUrl?: string }` |
| `VaultAction` | type | The action union, see [docs/PROTOCOL.md](PROTOCOL.md#actions) |
| `VaultReady`, `VaultRequest`, `VaultResult` | types | The three messages, see [docs/PROTOCOL.md](PROTOCOL.md#messages) |
| `TypedDataRequest`, `UserOperationJson`, `UserOperationRequest`, `VaultCall`, `VaultSignRequest` | types | Request and UserOperation shapes |

```ts
// Full v0.7 UserOperation. Quantities are decimal strings.
type UserOperationJson = {
  sender: `0x${string}`;
  nonce: string;
  factory: string | null;
  factoryData: string | null;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster: string | null;
  paymasterVerificationGasLimit: string | null;
  paymasterPostOpGasLimit: string | null;
  paymasterData: string | null;
  signature: string;
};

type VaultSignRequest =
  | { kind: 'message'; message: string }
  | { kind: 'typedData'; typedData: TypedDataRequest }
  | { kind: 'userOperation'; userOperation: UserOperationRequest };
```

### `@wl-embedded-wallet/sdk/server`

Node.js only. Nothing in it reads the environment.

**Handoff tokens (Ed25519 in hex)**

| Export | Signature | Notes |
|---|---|---|
| `createHandoffToken` | `(input: { sub; label; iss; aud; origin; kid?; jti?; nowSeconds?; chain? }, privateKeyHex: string) => string` | Compact EdDSA JWT, header `{ alg: 'EdDSA', typ: 'JWT', kid? }`, `exp = iat + 60`, random 128-bit base64url `jti` unless given. Throws `HandoffError('MALFORMED')` if `sub` does not match `^[A-Za-z0-9_-]{1,64}$`, if `iss`, `aud` or `origin` is empty, or if the key is not hex. `kid` is optional here but required by a vault that uses a JWKS. `jti` and `nowSeconds` exist for tests; a custom `jti` is not validated here, but the vault requires `^[A-Za-z0-9_-]{1,64}$` |
| `handoffPublicJwk` | `(privateKeyHex: string, kid: string) => HandoffPublicJwk` | The public JWK of a hex private key |
| `ed25519PublicJwk` | `(publicKeyHex: string, kid: string) => HandoffPublicJwk` | The JWK of a 32-byte hex public key (for keys kept published during a rotation). Throws `HandoffError('MALFORMED')` on an empty `kid` or a key that is not 32 bytes of hex |
| `HANDOFF_TTL_SECONDS` | `60` | Lifetime of tokens minted by the SDK |
| `HandoffError` | class | `readonly reason: 'MALFORMED'`; `message === reason` |
| `HandoffClaims` | type | `{ iss; aud; sub; label; origin; jti; iat; exp; chain?: { chainId: number; rpcUrl?: string } }` |
| `HandoffPublicJwk` | type | `{ kty: 'OKP'; crv: 'Ed25519'; x; kid; use: 'sig'; alg: 'EdDSA' }` |

**Handoff signers (EdDSA, ES256, RS256)**

| Export | Signature | Notes |
|---|---|---|
| `createHandoffSigner` | `(options: { alg: HandoffAlgorithm; kid: string; privateKey: string \| JWK }) => HandoffSigner` | `privateKey` is a PEM string (PKCS#8 is the documented format) or a private JWK. Throws `HandoffError('MALFORMED')` on an empty `kid`, an unreadable key, a public key, or a key type that does not match `alg` (Ed25519, P-256, RSA >= 2048 bits) |
| `generateHandoffSigner` | `(alg: HandoffAlgorithm, kid: string) => Promise<HandoffSigner>` | Fresh non-extractable key pair (RSA: 2048 bits). For development and tests |
| `HandoffSigner` | type | `{ alg; kid; publicJwk: PublicHandoffJwk; mint(input: HandoffTokenInput): Promise<string> }`. `mint` sets header `{ alg, kid, typ: 'JWT' }`, `exp = iat + 60` and a random `jti`, and applies the same `sub`/`iss`/`aud`/`origin` checks as `createHandoffToken` |
| `HandoffTokenInput` | type | `{ sub; label; iss; aud; origin; chain?; jti?; nowSeconds? }` (`jti` and `nowSeconds` only for tests) |
| `HandoffAlgorithm` | type | `'EdDSA' \| 'ES256' \| 'RS256'` |
| `PublicHandoffJwk` | type | `JWK & { kid: string; alg: HandoffAlgorithm; use: 'sig' }`, with only the public members `kty`, `crv`, `x`, `y`, `n`, `e` |

**JWKS publication**

| Export | Signature | Notes |
|---|---|---|
| `jwks` | `(keys: readonly object[]) => Jwks` | Builds `{ keys }`. Throws `Error('JWKS_PRIVATE_KEY')` if any key has `d`, `p`, `q`, `dp`, `dq`, `qi`, `oth` or `k` |
| `jwksResponse` | `(keys: readonly object[], options?: { maxAgeSeconds?: number }) => Response` | JSON response with `Cache-Control: public, max-age=<maxAgeSeconds>` (default 300) |
| `jwksHandler` | `(getKeys: () => readonly object[] \| null, options?: { maxAgeSeconds?: number }) => () => Response` | A route handler. If `getKeys` returns `null` or throws, or the list contains a key with private material, it answers `500 { "error": "INTERNAL" }` with `Cache-Control: no-store` and publishes nothing |
| `JWKS_MAX_AGE_SECONDS` | `300` | Default `max-age` |
| `Jwks` | type | `{ keys: Record<string, unknown>[] }` |

**Server-to-server client**

| Export | Signature | Notes |
|---|---|---|
| `createVaultServiceClient` | `(options: VaultServiceClientOptions) => VaultServiceClient` | See [section 7](#7-server-to-server-api) |
| `VaultServiceClientOptions` | type | `{ vaultOrigin: string; serviceToken: string; fetch?: typeof fetch; timeoutMs?: number }` (`fetch` for tests; `timeoutMs` default 15000) |
| `VaultServiceClient` | type | `{ getAccount(sub: string, chain?: { chainId: number; rpcUrl?: string }): Promise<VaultServiceAccount> }` |
| `VaultServiceAccount` | type | `{ exists: false; address: null; owner: null }` or `{ exists: true; address; owner; chainId?; deployed?: boolean \| null; deployable?; sponsored?; transactionsSponsored?; chainError? }` |
| `VaultUnavailableError` | class | `name = 'VaultUnavailableError'`, `message = 'VAULT_UNAVAILABLE'` |

**Safe helpers** (re-exported from `@wl-embedded-wallet/core/safe`; Safe 4337 with modules 0.3.0 and EntryPoint v0.7; no network access, no keys). `params` always defaults to `DEFAULT_SAFE_PARAMS`.

| Export | Signature | Use |
|---|---|---|
| `requestHash` | `(request: SafeMessageRequest) => Hex` | The hash `isValidSignature` receives: EIP-191 for `message`, EIP-712 for `typedData` |
| `recoverSafeMessageSigner` | `(safe, chainId, hash, signature) => Promise<Address>` | Recovers the owner from a `signMessage`/`signTypedData` signature |
| `safeMessageTypedData` | `(safe, chainId, hash) => typed data` | The `SafeMessage` structure the owner signs |
| `ERC1271_MAGIC_VALUE` | `'0x1626ba7e'` | Expected return of `isValidSignature` |
| `recoverSafeOperationSigner` | `(operation: UserOperationJson, chainId, params?) => Promise<Address>` | Recovers the owner from a signed UserOperation |
| `userOperationMatches` | `(operation, request: UserOperationRequest, safe, params?) => boolean` | Whether a signed operation is exactly the requested one |
| `safeOperationHash` | `(operation, chainId, params?) => Hex` | The Safe 4337 EIP-712 operation hash the owner signs |
| `userOperationHash` | `(operation, chainId, params?) => Hex` | The EntryPoint v0.7 UserOperation hash |
| `toRpcUserOperation` | `(operation) => Record<string, string>` | ERC-7769 JSON-RPC shape for `eth_sendUserOperation` |
| `toUserOperationV7` | `(operation) => UserOperationV7` | `abstractionkit` shape, with `bigint` quantities |
| `buildUserOperation` | `(safe, request, params?) => UserOperationJson` | The unsigned operation the vault signs for a `UserOperationRequest` |
| `encodeSafeCalls` | `(calls: readonly VaultCall[], params?) => string` | Safe `callData` (single call, or MultiSend for several) |
| `predictSafeAddress` | `(owner: string, params?) => Address` | The Safe address of an owner |
| `smartAccountFor` | `(owner, params?) => SmartAccountInfo` | The parameters plus the predicted address |
| `deploymentFactory` | `(owner, params?) => { factory; factoryData }` | Factory and init data for the deployment |
| `deploymentCalls` | `(safe) => VaultCall[]` | The empty self-call executed by the sponsored deployment |
| `buildDeploymentOperation` | `(owner, fees: { maxFeePerGas; maxPriorityFeePerGas }, params?) => UserOperationJson` | The deployment operation, with a dummy signature and zero gas limits |
| `isDeploymentOperation` | `(operation, owner, params?) => boolean` | Whether an operation is exactly the deployment of that owner's Safe |
| `buildTransactionOperation` | `(safe, call: VaultCall, nonce, fees, params?) => UserOperationJson` | The unsigned operation for one call from a deployed Safe (`executeUserOpWithErrorString`, a CALL), with a dummy signature and zero gas limits |
| `isTransactionOperation` | `(operation, call, safe, params?) => boolean` | Whether an operation executes exactly that call from that Safe, with no `factory` |
| `isAllowedTransactionCall` | `(safe, call) => boolean` | `false` for a call to the Safe itself with data |
| `dummySafeSignature` | `() => string` | A placeholder signature for gas estimation |
| `signSafeOperation` | `(operation, chainId, params, signer: { address; signHash(hash) }) => Promise<string>` | Signs with an external signer. The vault uses it; integrators normally do not |
| `DEFAULT_SAFE_PARAMS` | `SafeParams` | EntryPoint, factory, singleton, Safe 4337 module, module setup, MultiSend, salt nonce |
| `SAFE_ACCOUNT_TYPE`, `SAFE_MODULES_VERSION` | `'safe-4337'`, `'0.3.0'` | |
| `SafeParams`, `SmartAccountInfo`, `SafeMessageRequest` | types | |

`/server` also re-exports the types `TypedDataRequest`, `UserOperationJson`, `UserOperationRequest`, `VaultCall` and `VaultSignRequest`.

**Not exported:** there is no server-side signing function for user wallets, no server-side function to submit UserOperations, and no client-side verification helper. Verification is meant to run on your backend.
