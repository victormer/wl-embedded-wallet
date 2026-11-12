# Threat model

This document states what WL Embedded Wallet protects, against whom, how, and which risks are knowingly accepted. It is written for the security audit; read it together with [ARCHITECTURE.md](ARCHITECTURE.md) (components and trust boundaries), [CRYPTO-SPEC.md](CRYPTO-SPEC.md) (formats), [PROTOCOL.md](PROTOCOL.md) and [HTTP-API.md](HTTP-API.md) (interfaces), and [TEST-STATUS.md](TEST-STATUS.md) (what is and is not tested). The proposed audit scope is in [AUDIT-SCOPE.md](AUDIT-SCOPE.md).

**Status:** it describes 0.1.0 plus the unreleased pre-audit fixes in [CHANGELOG.md](../CHANGELOG.md#unreleased). Neither has been audited, and neither is ready to hold real funds; see [Accepted risks](#accepted-risks) and the [production checklist](DEPLOYMENT.md#production-checklist).

## Contents

- [Security goals](#security-goals)
- [Assets](#assets)
- [Actors and attacker capabilities](#actors-and-attacker-capabilities)
- [Trust assumptions](#trust-assumptions)
- [Trust boundaries](#trust-boundaries)
- [Threats and mitigations](#threats-and-mitigations)
- [What each factor combination yields](#what-each-factor-combination-yields)
- [Accepted risks](#accepted-risks)
- [Known weaknesses noted for the audit](#known-weaknesses-noted-for-the-audit)
- [Out of scope](#out-of-scope)

## Security goals

1. **Non-custodial:** no single party other than the user can obtain the seed. In particular, the vault operator (database plus `MASTER_KEY`) and the integrator app (its frontend, and its backend acting alone) cannot.
2. **Two factors to the seed:** reconstructing the seed requires two of the three shares, each held under a different factor: the vault session (A), the passkey (B), the recovery code (C). The Emergency Kit's seed backup is an explicit exception: kit plus code is enough ([accepted risk 1](#accepted-risks)).
3. **Integrity before use:** tampered server data, kits or envelopes are detected before the seed is used: signed manifest, per-share digests, AAD binding, expected owner and Safe address.
4. **Origin isolation:** code running on the integrator's origin (including an XSS there) cannot read shares, the PRF output, the recovery code, the seed, or the vault's DOM, cookies or API.
5. **Informed approval:** the user sees what they sign (requesting origin, chain, Safe, decoded data) before the passkey is used.
6. **Survivability:** the user keeps control of their funds if the vault service disappears permanently (kit plus code, offline tool).
7. **Bounded sponsorship:** the gas sponsorship configured by the operator can be spent only on deploying users' own Safes and, on chains where the operator opts in (`sponsorTransactions`), on calls from users' own deployed Safes that the user approved, within per-operation caps and rate limits.

## Assets

| Asset | Why it matters | Where it is |
|---|---|---|
| Seed (BIP-39 mnemonic) | Full, irrevocable control of the owner key, on every chain | Worker memory during one operation; kit (encrypted backup); exported seed files (plaintext, user-chosen) |
| Owner private key | Signs for the Safe | Derived in the worker from the seed |
| Share A | One factor of three | Vault DB (sealed), worker during an operation, enrollment request body |
| Share B, share C (encrypted) | One factor each, combined with the PRF output or the code | Vault DB and kit |
| Passkey and its PRF output | Unlocks B | Authenticator; PRF output briefly in the vault page and worker |
| Recovery code | Unlocks C and the seed backup | User's own storage; vault page input |
| Emergency Kit | encB, encC, manifest, seed backup | User's storage |
| `MASTER_KEY` | Unseals share A of every user | Vault server environment |
| `MANIFEST_SIGNING_KEY` | Vouches for manifests (digests, owner, Safe) | Vault server environment |
| Integrator handoff signing key / JWKS | Authorizes sessions that receive share A | Integrator backend |
| `VAULT_SERVICE_TOKEN` | Reads which `sub` owns which address | Vault and integrator backend |
| Session cookie | 15 minutes of share A access for that user, within the release budgets | Browser (HttpOnly), vault DB (`sessions`; its SHA-256 in `share_sets.created_session_hash` and `share_a_releases`) |
| Paymaster sponsorship budget | Operator money | Paymaster account and its sponsorship policy, `AA_CHAINS` and its caps, `sponsored_deployments`, `prepared_transactions` |
| Wallet-to-account link | Which app account controls the wallet in the app | Vault DB (`share_sets.user_id`) |

## Actors and attacker capabilities

| Actor | Capabilities considered |
|---|---|
| Remote attacker | Sends arbitrary HTTP requests to the vault and the app; obtains no secrets by default |
| Malicious or compromised integrator frontend (XSS on the app origin) | Runs arbitrary JavaScript on the app origin, opens the vault popup, posts messages, calls the app's token endpoint as the logged-in user |
| Compromised integrator backend | Mints valid handoff tokens for any `sub` and any signed origin; controls the JWKS |
| Network attacker | Observes and modifies traffic not protected by TLS (development only) |
| Database thief | Reads (and possibly writes) the vault database, backups included |
| Vault operator or compromised vault server | Controls the server, its keys and the JavaScript the vault origin serves |
| Malicious RPC, bundler or paymaster | Returns arbitrary JSON-RPC results |
| Thief of user material | Obtains some of: kit, recovery code, passkey (device), exported seed file, a live handoff token |
| Malicious browser extension or malware on the user's device | Reads page memory or the screen |
| Attacker with someone else's seed | Can sign as the owner |

## Trust assumptions

- The user's browser and operating system are not compromised, and the browser correctly enforces the same-origin policy, CSP, Trusted Types and WebAuthn.
- The passkey authenticator implements PRF correctly and keeps its per-credential secret private, and requires user verification.
- The **integrator backend is trusted for user identity**: a handoff token it signs is taken as proof that `sub` is logged in (with whatever 2FA the integrator applies). The vault cannot verify that 2FA.
- The **vault origin is trusted to serve honest code**. A compromised vault server can serve JavaScript that asks for the passkey and code and exfiltrates the seed; no client-side mechanism in this release prevents that.
- TLS protects all production traffic. The Caddy example terminates TLS in front of the vault.
- The reverse proxy in front of the vault appends the client address to `X-Forwarded-For`, and `TRUSTED_PROXIES` lists exactly that proxy. Per-IP rate limits key on the address this yields ([DEPLOYMENT.md](DEPLOYMENT.md#client-addresses-behind-a-proxy)).
- On Vercel (`CLIENT_IP_SOURCE=vercel`), the Vercel edge overwrites `x-real-ip` with the client address it saw, whatever the client sent, and requests reach the function only through that edge. The vault (and the demo) read that header only when `VERCEL=1` and the runtime-only `VERCEL_REGION` are both set; anywhere else no header is trusted, every client shares the `unknown` bucket, and the vault refuses to start in production.
- On Vercel, the platform and anyone with admin rights on the Vercel project are trusted with the environment, which holds `MASTER_KEY`, `MANIFEST_SIGNING_KEY` and the bundler and paymaster keys (marked Sensitive, but replaceable by a project admin). That is demo-grade, like any key in a process environment ([accepted risk 5](#accepted-risks)).
- The cryptographic libraries (`@noble/curves`, `@scure/bip39`, `hash-wasm`, `viem`, `@tetherto/wdk-utils` and its `shamir-secret-sharing`, WebCrypto) are correct.
- The Safe, Safe 4337 module and EntryPoint contracts at the configured addresses are the genuine audited deployments.

## Trust boundaries

See [ARCHITECTURE.md](ARCHITECTURE.md#trust-boundaries) for the diagram. In short: (1) integrator app origin, (2) vault page, (3) signer worker, (4) vault server, (5) integrator backend, (6) chain infrastructure, (7) offline device. Boundaries 2, 3 and 4 are one trust domain against a malicious vault operator; they are separated to reduce exposure (no plaintext shares on the vault's main thread, no B, C or seed on the server).

## Threats and mitigations

### Server-side compromise

| Threat | Mitigation | Residual |
|---|---|---|
| Database stolen | Share A is sealed under `MASTER_KEY`; B and C are encrypted under factors the server never sees | With the DB alone, nothing; see the next row |
| Database and `MASTER_KEY` stolen | Yields share A of every user, which reconstructs nothing alone | Plus a user's recovery code (A+C) yields that user's seed; the 128-bit code makes offline brute force of `encC` infeasible |
| Database tampered (shares, envelopes, manifest, owner, Safe) | Manifest Ed25519 signature checked in the worker; per-share SHA-256 digests; envelope AAD built from the manifest's slot; owner and Safe recomputed and compared before the seed is used or returned; tampered `kdfParams` bounded | An attacker who also has `MANIFEST_SIGNING_KEY` can sign forged manifests (see [accepted risk 10](#accepted-risks)) |
| `MASTER_KEY` lost | Users still have B+C and kit+code | Share A of every user is unusable; users must re-enroll with B+C (kit) or kit+code while the vault runs |
| Compromised vault server serving malicious JavaScript | CSP and Trusted Types limit injected script, not code the server itself serves | Total compromise for users who use the vault while it is compromised ([accepted risk 9](#accepted-risks)) |
| Share A observed in transit at enrollment | TLS | Share A is sent to the server in plaintext inside TLS; a real KMS should receive it encrypted client-side ([accepted risk 5](#accepted-risks)) |

### Integrator compromise

| Threat | Mitigation | Residual |
|---|---|---|
| XSS on the integrator origin | Separate origin; SDK and vault origin checks; the popup never posts data before the token's signed origin is verified; HttpOnly, SameSite=Strict `__Host-` cookie; no CORS on the vault API; the app receives only addresses and signatures | The XSS can ask for signatures and transactions with arbitrary content; the user's reading of the review screen is the last barrier ([accepted risk 12](#accepted-risks)) |
| Compromised integrator backend, signing key or JWKS | Tokens are short-lived (max 120 s) and single-use; `ALLOWED_APP_ORIGINS` can restrict which origins are accepted; share A of a `pending` set goes only to the session that created it; releases are budgeted per session and per user and each one is recorded in `share_a_releases` | Any valid token yields that user's share A (active set) for the 15-minute session ([accepted risk 2](#accepted-risks)) |
| Token replay | `jti` consumed atomically (`INSERT ... ON CONFLICT`), across replicas, after every other check, so no rejection spends it | None within the model |
| Token used by another app | Signed `origin` claim must equal the browser's `event.origin`; session bound to that origin via `X-Vault-App-Origin` | Someone holding a live token outside a browser can claim the signed origin ([accepted risk 3](#accepted-risks)) |
| JWKS endpoint attacks (huge document, redirects, private keys published, outage) | 5 s timeout, 64 KiB cap, no redirects, documents with private or symmetric material rejected and cache invalidated, bounded stale cache, refresh cooldown | During an outage longer than `HANDOFF_JWKS_MAX_STALE_SECONDS`, the vault fails closed |
| Algorithm confusion | Only EdDSA, ES256, RS256 accepted; `kid` required with a JWKS; the key is never taken from the token | None within the model |

### Client-side threats

| Threat | Mitigation | Residual |
|---|---|---|
| Seed or shares leaking to the vault page's DOM, console, logs or network | Shares are decrypted only in the worker; the worker returns only results; error responses carry only a code; secret buffers are transferred and zeroed; e2e tests scan DOM, traffic, `result` messages, console and server logs for the real values | JavaScript strings (mnemonic, hex shares) cannot be wiped ([accepted risk 11](#accepted-risks)) |
| XSS in the vault | Nonce-based CSP with `default-src 'none'`, `connect-src 'self'`, `frame-ancestors 'none'`, Trusted Types with a single restrictive `default` policy, no third-party scripts, worker CSP on its script response | Production builds only; mitigates rather than prevents ([accepted risk 13](#accepted-risks)) |
| Clickjacking of the vault | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | None within the model |
| Malicious brand assets | `brand.json` is validated at startup (tokens only, SVG restrictions, sizes, contrast and hue rules); files served from memory with a sandbox CSP and content-hash names; brands cannot change flows or warnings ([BRANDING.md](BRANDING.md)) | The operator controls the brand anyway |
| Malicious extension or malware | None | Can read the seed while it exists in memory or on screen ([accepted risk 11](#accepted-risks)) |

### Request abuse

| Threat | Mitigation | Residual |
|---|---|---|
| Flooding token redemption, challenges, nonces, share A, the AA proxy or the s2s endpoint | Per-IP and per-`sub` fixed-window limits per scope, counted in the database and shared by replicas (`429 RATE_LIMITED` with `Retry-After`); the client IP is the socket peer, set by the `peer-address.cjs` preload, and `X-Forwarded-For` is read only from `TRUSTED_PROXIES`; on Vercel (`CLIENT_IP_SOURCE=vercel`) it is `x-real-ip`, read only inside a Vercel function; ambiguous combinations stop startup in production; IPv6 is keyed by its /64 | Bursts at window edges, dependence on `TRUSTED_PROXIES` or on the Vercel edge, untuned defaults ([accepted risk 4](#accepted-risks)) |
| Growing the kit-free recovery challenge table without a session | Per-IP limit, plus a global cap of `RECOVERY_CHALLENGE_MAX_LIVE` unexpired challenges (`429` at the cap) | At the cap, kit-free recovery is unavailable to everyone for up to the 5-minute challenge lifetime |
| Oversized request bodies | `readJson` caps every JSON body at 128 KiB (`413 PAYLOAD_TOO_LARGE`), from `Content-Length` and by counting the stream; the Next.js proxy does not run on `/api/`, so no body is buffered before the route | None within the model |
| Repeated share A fetches with a live session | Per-session and per-user release budgets per window; an audit row is written before each release | The budgets also count refused requests ([known weakness](#known-weaknesses-noted-for-the-audit)) |
| TLS stripping | `Strict-Transport-Security: max-age=31536000` on pages and API responses, in production with an `https` `ORIGIN`; TLS terminated at the proxy | No `includeSubDomains`, no preload: the first visit is not protected |

### Kit, code and offline tool

| Threat | Mitigation | Residual |
|---|---|---|
| Kit stolen alone | Seed backup and C need the 128-bit code (Argon2id 64 MiB, t=3); B needs the passkey | None within the model |
| Kit and code stolen together | None | Equivalent to the wallet ([accepted risk 1](#accepted-risks)) |
| Tampered kit (ciphertext, IV, salt, digest, signature, foreign kit, Argon2id parameters) | Strict parse rules; AES-GCM authentication; AAD binding to the manifest's slot and owner; manifest signature (vault and static page); owner and Safe recomputation; Argon2id bounds | The offline tool does not check the manifest signature ([accepted risk 15](#accepted-risks)) |
| Tampered offline tool | Reproducible build with a published SHA-256; strict CSP with hashes; no network (`connect-src 'none'` plus a `fetch` stub); the vault refuses to hand out a kit until the tool has been downloaded | Users must actually compare the hash, against a copy published outside the vault's domain ([accepted risk 16](#accepted-risks)) |

### Chain and sponsorship

| Threat | Mitigation | Residual |
|---|---|---|
| Third party spending the paymaster budget | `/api/aa/rpc` admits four methods. For deployments, the server builds the deployment of the session user's own Safe on the session's chain (fees from the node, gas from the bundler, paymaster fields from the paymaster, each within the caps of `AA_MAX_*` or `AA_CHAINS[chainId].limits`), only when not yet deployed and deployable, and records it in `sponsored_deployments`; it then forwards only that exact operation with the owner's signature, once per Safe and chain, and allows a new one only after `AA_DEPLOYMENT_RETRY_SECONDS`; the paymaster context is set server-side; bundler and paymaster URLs and keys never reach the browser; calls are rate limited per IP and per `sub`. Transactions: next row | Each deployment can cost up to the caps, whose defaults are not tuned for L2s ([accepted risk 27](#accepted-risks)) |
| Sponsored transactions draining the paymaster | Off by default: transactions are sponsored only where `AA_CHAINS[chainId].sponsorTransactions` is `true` (which requires a `paymasterUrl`); elsewhere the Safe pays its own fee. Each `vault_prepareTransaction` counts against the `transaction` rate-limit scope (10 per `sub` and 30 per IP per 60 s by default) on top of `aa`; gas and fees of every operation are within the same caps as deployments; the call's `value` is always paid by the Safe, and the balance is checked before any paymaster or bundler call (`INSUFFICIENT_FUNDS`); only operations the server prepared are forwarded, once each, within 10 minutes; each one needs the owner's signature, so the user's passkey approval | A user (or whoever controls many accounts in the integrator) can spend up to the caps on every approved call, within the rate limits, which bound frequency but not total spend. The sponsorship policy at the paymaster provider (per-user and global spend limits, for example Pimlico's sponsorship policies) is the outer bound and should be configured ([accepted risk 29](#accepted-risks)) |
| Malicious app requesting a harmful transaction | The popup shows the requesting origin, chain and RPC host, the Safe, the recipient, the amount in the native currency, the raw data, the decoded ERC-20 `transfer` or `approve` when the data decodes as one, and the sponsorship or the maximum network fee; an `approve` and any undecoded data carry a caution; calls to the Safe itself with data (owner, module or guard changes) are refused by the popup, the server and the worker (`CALL_NOT_ALLOWED`); only a single CALL can be built, never a delegatecall or a batch | The user must read the review: a malicious contract call, or an ERC-20 transfer to the attacker, looks like any other ([accepted risk 12](#accepted-risks)) |
| Vault server building a different transaction | The worker checks, before reconstructing the seed, that the operation executes exactly the reviewed call from this Safe (`isTransactionOperation`, `INTERNAL` otherwise) with no factory, and refuses a call to the Safe with data | The server chooses the nonce, gas limits, fees and paymaster fields, which the signature covers. The review shows whether the operation is sponsored and, when it is not, its maximum network fee, within the caps; it does not show the nonce or the paymaster address. A server that also serves the vault's JavaScript is a total compromise anyway ([accepted risk 9](#accepted-risks)) |
| Replaying or altering a prepared transaction | `eth_sendUserOperation` without `factory` looks the operation up by its `userOpHash` among this Safe's prepared operations on this chain, so any changed field finds nothing (`403 OPERATION_NOT_ALLOWED`); it compares it again with the prepared operation and its recorded call and requires the owner's signature; a single-flight claim (`TRANSACTION_IN_PROGRESS`) forwards it once, and a resend returns the same hash; an operation prepared more than 10 minutes earlier is refused (`TRANSACTION_EXPIRED`); receipts are only for hashes this Safe sent; the EntryPoint nonce makes the same operation includable once | See [known weaknesses](#known-weaknesses-noted-for-the-audit) |
| Malicious RPC from the token | Operator `AA_CHAINS[chainId].rpcUrl` takes precedence; a token `rpcUrl` must be HTTPS (HTTP only on a local host in insecure local mode) and its host in `RPC_ALLOWED_HOSTS`; `eth_chainId` must match; responses capped at 1 MiB and 10 s; upstream errors sanitized | A lying RPC can make the vault believe a Safe is or is not deployed (affects gating, not key material) |
| Malicious or faulty bundler or paymaster | Fee, gas and paymaster results are validated (hex quantities, an address, `paymasterData` of at most 4096 bytes) and checked against the caps; an invalid answer is `502 UPSTREAM_INVALID` and nothing is signed or sent; the bundler's hash must be 32 bytes. The bundler's `pimlico_getUserOperationGasPrice` quote is only a floor, still bounded by the server's `maxFeePerGas` cap: a quote above the cap is refused (`FEES_TOO_HIGH`), and a missing or malformed quote leaves the node's values | A bundler can lie about acceptance or receipts (affects the deploy flow's outcome, not key material). A malicious or compromised bundler can push the fees of each deployment up to the cap, which the gas and fee caps already allowed before the quote was used |
| Factory returning a different address | Server simulates the factory call and requires the predicted address | None within the model |
| Signature replay across chains or Safes | SafeMessage and SafeOp signatures are bound to the chain id and the Safe (and the module) | A message signed without a domain can be replayed in another app that uses the same wallet ([accepted risk 6](#accepted-risks)) |

### Account linking

| Threat | Mitigation | Residual |
|---|---|---|
| Moving someone's wallet with only a valid token | Relink requires an EIP-712 signature by the owner key over a server-rebuilt message bound to the new `sub`, issuer, vault origin, nonce and 5-minute expiry; the nonce response does not reveal whether the wallet exists; a transaction rechecks that the source still holds exactly that wallet and the target has none | Anyone with the seed (kit+code, passkey+code, or an exported file) can do it, silently ([accepted risk 8](#accepted-risks)) |
| Enumerating which addresses the vault holds | Relink nonce responses are identical either way; kit-free recovery returns one undifferentiated `RECOVERY_FAILED` | Timing differences ([accepted risk 18](#accepted-risks)) |

## What each factor combination yields

| Attacker holds | Result |
|---|---|
| Share A only (DB + `MASTER_KEY`, or a live token or session) | Nothing |
| Passkey only | With kit-free recovery: encB, encC and the manifest, which yield nothing without the code |
| Recovery code only | Nothing |
| Kit only | Nothing |
| Share A + recovery code | Seed (A+C) |
| Share A + passkey | Seed (A+B) |
| Passkey + recovery code | Seed (kit-free recovery: B+C) |
| Kit + passkey | Seed only with the code; B+C needs C, which needs the code |
| **Kit + recovery code** | **Seed**, offline, with no passkey and no server (seed backup) |
| Exported seed file | Seed |

## Accepted risks

These are known, deliberate limitations of 0.1.0. Most come from the design rationale in [DECISIONS.md](DECISIONS.md) and the open items in [ROADMAP.md](ROADMAP.md).

1. **Kit + code is equivalent to the wallet.** The seed backup in the kit (on by default, no opt-out) gives the seed with no passkey and no server. If both are stolen together there is nothing to revoke: the user must move the funds to a new wallet. The only mitigation is storing them separately, which the UI repeats at every step.
2. **A stolen live handoff token (or a compromised integrator backend, signing key or JWKS) yields share A** for that user, for the 15-minute session it opens. The vault has no second factor of its own and cannot verify the app's 2FA. Share A alone reconstructs nothing; with the user's recovery code it yields the seed. Releases are capped per session and per user (`SHARE_A_MAX_PER_SESSION`, `SHARE_A_MAX_PER_USER`) and recorded in `share_a_releases`, which detects but does not prevent this. The code therefore must stay at 128 bits. An e2e test demonstrates this behavior.
3. **`X-Vault-App-Origin` is not a security boundary against a token holder.** It prevents accidental use of another app's session; whoever holds a live token outside a browser can redeem it with the signed origin.
4. **Rate limits are coarse.** Every limit is a fixed-window counter in the database (60 s by default), so up to twice a limit can pass around a window edge, and each counted request costs a database write. Per-IP limits are only as good as the client address: behind a proxy that is not in `TRUSTED_PROXIES`, every client shares the proxy's bucket; a `TRUSTED_PROXIES` range that also covers clients lets them choose their address through `X-Forwarded-For`; and through Docker's published port the peer may be the bridge gateway. On Vercel the address is only as good as the edge's `x-real-ip`. The defaults are not tuned for production traffic, have not been tested under real load or behind a real proxy, and the s2s per-IP limit is shared by every request from the integrator backend's address (on Vercel, the demo's shared egress addresses). The demo's register, login and TOTP routes have per-IP limits (and per-user ones on TOTP) in its own database, but off Vercel every demo client shares one bucket, and login has no per-email limit, so credential stuffing spread over many addresses is not stopped.
5. **No real KMS.** `MASTER_KEY` is a 32-byte key in the server environment (on Vercel, a project environment variable), used by a stub (`apps/vault/server/kms.ts`). Share A is sent to the server in plaintext (inside TLS) at enrollment and released in plaintext to sessions. A pluggable KMS or HSM is on the roadmap.
6. **One wallet, many apps, one issuer.** Wallets are bound to `sub` under a single `HANDOFF_ISSUER`. A compromise of any app that can mint tokens for that issuer affects the shared wallet. A message signed without a domain in one app can be replayed in another: apps must use SIWE or EIP-712 with a domain. A shared login backend must validate `Origin` against its own allowlist and never reflect it, because the signed `origin` authorizes an app.
7. **Rotation does not change the seed and revokes nothing held offline.** Re-enrollment creates new shares, passkey, code and kit for the same seed and Safe. Old kits (`v: 2`) keep opening with their old code forever and yield the same seed; exported seed files stay valid. After a leak of the seed, kit+code or an exported file, the only remedy is a new wallet and moving the funds. The server cannot revoke offline material.
8. **Whoever holds the seed can relink the wallet to their own account** (with kit+code, passkey+code, or the seed), locking the owner out of the wallet in the app, with no notification to the owner. The relink is recorded in the server's audit table. Users also receive no notification when share A is released (each release is only recorded in `share_a_releases`). Failed relink attempts are not logged.
9. **A compromised vault is a total failure.** Malicious JavaScript served from the vault origin can request the passkey and the code and exfiltrate the seed. The manifest public key is delivered in the vault's own HTML at runtime, not pinned in the bundle; it protects against a database-only compromise, not a server compromise.
10. **The manifest signing key lives on the server.** It detects database tampering, not a compromised server.
11. **The seed exists in client memory.** It is complete in the worker during every operation, and in the vault page during exports. JavaScript strings cannot be reliably wiped; only byte buffers are zeroed. A malicious extension or malware can steal it. The alternative (MPC or threshold signing) is out of scope for this design.
12. **A compromised integrator app can request signatures and transactions with arbitrary content.** The review screen (origin, chain, Safe, decoded data; for transactions also recipient, amount and fee) is the last barrier and depends on the user reading it. Only ERC-20 `transfer` and `approve` are decoded; any other data is shown raw, with a caution.
13. **Vault XSS is mitigated, not prevented.** CSP and Trusted Types are enforced only in production builds (`pnpm dev` does not apply them), and were tested only in Chromium.
14. **The RP ID is effectively irreversible.** Changing the vault's domain or losing it makes share B unusable for every user, permanently. Without the domain, B+C does not work either (not even from the static page, which must be hosted on an origin valid for the RP ID), and only kit+code remains. Changing the RP ID forces every user to re-enroll with A+C. A vault on a `*.vercel.app` host has that host as its RP ID: moving it to a custom domain later is such a change, so that deployment is a testnet demo whose wallets may be lost.
15. **The offline tool does not verify the manifest signature.** Authenticity rests on AES-GCM under the code and the owner-bound AAD, plus the owner and Safe recomputation. A forged kit could only contain data encrypted under a code the forger knows.
16. **The tool hash must be published outside the vault's domain** for the integrity check to mean anything; this release publishes it only in this repository ([REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md)).
17. **The owner address is declared by the client.** At enrollment the server cannot check that `expectedAddress` corresponds to the shares; it relies on the worker's checks, the uniqueness of owners across users, and the Safe parameter checks.
18. **Timing-based enumeration in passkey recovery.** `POST /api/recovery/passkey` returns the same error for every failure, but responds measurably faster when the credential id is unknown (no signature verification). Credential ids are random, so this reveals little, but it is a side channel.
19. **Passkey availability and behavior.** Enrollment requires an authenticator with the WebAuthn PRF extension; there is no fallback. Real platform authenticators, Safari and Firefox are untested ([TEST-STATUS.md](TEST-STATUS.md)). `credProps.rk` is reported by the browser and unsigned; the real guarantee is `residentKey: "required"`. Because `user.id` is per set, passkeys accumulate in the user's provider after rotations. Wallets enrolled without a registered public key cannot use kit-free recovery until they re-enroll.
20. **The `__Host-` Secure cookie over plain HTTP** works in Chromium on `*.localhost` for development; it is untested in Safari and Firefox.
21. **Owner changes do not propagate across chains.** The Safe has the same address everywhere and is deployed per chain with the original owner. A compromised owner key must be treated as compromised on every chain, because an attacker can deploy the Safe on a new chain with the original owner. Chains where `CREATE2` differs (for example zkSync) are unsupported; a Safe module upgrade would be a migration inside the same Safe.
22. **Recovered-mode signatures are not checked against the chain.** Signatures made with B+C or kit+code (no server) cannot check whether the Safe is deployed on the chain the user typed; they are only valid where it is.
23. **Single region, single database.** The vault is one service with one database (Postgres; SQLite for development). Replicas share the database. There is no multi-region design, no high availability guidance beyond replicas, and backup restore is untested.
24. **One vault session per browser.** Redeeming a new token deletes that browser's previous session, so two concurrent operations from the same browser interfere.
25. **Beta and experimental dependencies.** WDK packages are beta (`1.0.0-beta.*`) with no compatibility guarantee between versions; the share format is pinned to wdk-utils `1.0.0-beta.16`. `node:sqlite` (development and tests) is experimental. The native `sodium-native` dependency (pulled in by the WDK EVM wallet package) ships binaries for Linux and macOS only.
26. **No per-origin user consent and no per-app key revocation.** An app authorized by the issuer's signed `origin` (and `ALLOWED_APP_ORIGINS`, if set) can open the wallet without a separate consent step; revoking one app's `kid` is not supported beyond removing it from the JWKS.
27. **Sponsorship is bounded, not tuned.** A deployment can cost up to the gas caps times the fee cap. The defaults (`AA_MAX_*`, 500 gwei) were chosen for L1-like chains and have not been tested with real bundlers, paymasters or L2s: on OP-stack chains and Arbitrum, `preVerificationGas` includes the L1 data cost and can exceed the default cap, and 500 gwei is loose there ([DEPLOYMENT.md](DEPLOYMENT.md#chain-configuration)). Each `vault_prepareDeployment` spends two paymaster calls (stub and final data; the stub's `isFinal` is not used), two node calls, one bundler gas price call and one estimate, bounded only by the `aa` rate limit. A Safe whose sponsored deployment was sent but is still not deployed after `AA_DEPLOYMENT_RETRY_SECONDS` can be sponsored again.
28. **Handoff labels may contain invisible characters.** The `label` claim is limited to 256 UTF-16 code units and control characters (`\p{Cc}`) are rejected, but format characters (`\p{Cf}`: zero-width and bidirectional controls) are accepted and shown in the popup. The label comes from the integrator's signed token.
29. **Sponsored transactions are bounded per operation and per window, not in total.** With `sponsorTransactions: true`, every approved call can cost the paymaster up to the gas caps times the fee cap, and every `vault_prepareTransaction` (which needs no passkey) spends a paymaster stub call, a gas estimate and a final paymaster call, bounded only by the `transaction` and `aa` rate limits. The vault has no spend budget of its own: the operator must set per-user and global limits in the paymaster's sponsorship policy. Sponsored transactions have not been tested with a real paymaster ([TEST-STATUS.md](TEST-STATUS.md)).
30. **No external audit yet.** This document and [AUDIT-SCOPE.md](AUDIT-SCOPE.md) prepare one.

## Known weaknesses noted for the audit

The weaknesses listed here for 0.1.0 were fixed before the audit ([CHANGELOG.md](../CHANGELOG.md#unreleased)): the handoff `jti` spent on a chain mismatch, the unbounded `label`, the client-built sponsored operation, the unbounded recovery challenge table, the missing HSTS and body limit, plain-HTTP token RPC URLs in production, the missing share A audit record, and the SDK waiting forever on a malformed result. These remain, observed in the code; they are listed so the audit can confirm and rate them.

- The share A release budgets are spent before the set is looked up, so refused and missing sets count too. Whoever holds a session for a user (the user, or a holder of a valid token) can exhaust that user's per-user budget and block their unlocks until the window ends (`SHARE_A_WINDOW_SECONDS`, 1 hour by default).
- When forwarding `eth_sendUserOperation` fails with a transport error or a timeout, the deployment is released back to `prepared`, although the bundler may have received it. The same signed operation can then be sent again. This is bounded: it is the same operation, with nonce 0, and it can be included on-chain only once.
- A `submitting` deployment left by a process that died mid-send blocks the Safe for 60 seconds (a constant) before it can be claimed again.
- The same two apply to transactions: a transport error or timeout while forwarding releases the operation to `prepared`, so the same signed operation can be sent again (bounded by its EntryPoint nonce, so it is included at most once), and a stuck `submitting` row can be claimed again after 60 seconds.

## Out of scope

- The sample integrator app (`examples/demo`): its password storage, TOTP implementation (it rejects a reused code, and attempts are rate limited per IP and per user), rate limits and sessions are illustrative.
- The local account-abstraction test stack (`apps/vault/tests/aa-stack`): test bundler, test paymaster contract and anvil setup.
- The Caddy examples in `deploy/`, hosting providers, DNS and TLS certificate management.
- Denial of service against the operator's infrastructure beyond what is listed above.
- Physical attacks on the user's device and authenticator.
- Social engineering of users into revealing their code or approving signatures, beyond the UI's warnings.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).
