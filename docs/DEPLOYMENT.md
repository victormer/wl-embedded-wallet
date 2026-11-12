# Deployment

The vault (`apps/vault`) ships as a Docker image that carries no configuration. Each deployment runs its own copy, with its own Postgres, its own domain and its own keys, and passes everything through environment variables at startup. The vault and the demo app can also run as two Vercel projects with a Neon database each, which is how the public testnet demo is set up: see [Deploy to Vercel and Neon](#deploy-to-vercel-and-neon).

**Version 0.1.0 is not ready to hold real funds.** It has no real KMS, and its rate limits and sponsorship caps have defaults that were not tuned or tested under real load, among other gaps: read the [production checklist](#production-checklist) before deploying anything that matters. What has and has not been tested is tracked in [TEST-STATUS.md](TEST-STATUS.md).

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) (components), [HTTP-API.md](HTTP-API.md) (routes), [INTEGRATION.md](INTEGRATION.md) (integrating an app), [BRANDING.md](BRANDING.md) (`brand.json`), [RECOVERY.md](RECOVERY.md) (user recovery paths), [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md) (the recovery tool hash), [THREAT-MODEL.md](THREAT-MODEL.md) and [SECURITY.md](../SECURITY.md).

## Before you start

> [!WARNING]
> **`RP_ID` cannot be changed without every user re-enrolling.** Passkeys are bound to that domain. If it changes or is lost, share B stops working for everyone, and without the domain the only path left is the kit and the recovery code. Choose the final domain before the first user enrolls. See [WebAuthn RP ID and the vault origin](#webauthn-rp-id-and-the-vault-origin).

> [!WARNING]
> **Losing `MASTER_KEY` makes share A unusable for every user.** Users can still sign and download their seed with B+C, or with their kit and code, and re-enroll while the vault is up. Keep a copy of the key outside the server. See [Backups](#backups).

## Requirements

- Docker with Compose v2 (`compose.yaml` uses the top-level `name:` key). Docker 24 or later is recommended (not re-verified for this document).
- Postgres, your own or the one in `compose.yaml` (`postgres:17.6-alpine`). The test suites run against 17.6; older major versions (14 or later is expected to work) have not been verified for this release.
- A domain with HTTPS. WebAuthn requires a secure context, and the session cookie is `Secure`.
- The image, built from the repository root. It is not published to any registry.

## Build the image

From the repository root:

```bash
docker build -f apps/vault/Dockerfile -t wl-embedded-wallet-vault:local .
```

`compose.yaml` builds the same tag if you run `docker compose build`, and uses `VAULT_IMAGE` instead when you set it (for example an image you pushed to your own registry).

What the `Dockerfile` does:

- **Build stage** (`node:22-bookworm-slim`, pinned by digest): installs `pnpm@10.5.1`, runs `pnpm install --frozen-lockfile` for the vault and its workspace dependencies, and runs the vault's `build` script, which first builds `packages/recovery-tool` (the offline tool served at `/recovery-tool`) and then `next build` with `output: 'standalone'`. The macOS `sodium-native` prebuilds are removed.
- **Runtime stage** (same base image): `NODE_ENV=production`, `HOSTNAME=0.0.0.0`, `PORT=3000`, telemetry off. It copies the standalone output, the static assets, `scripts/generate-secrets.mjs` and the `peer-address.cjs` preload, runs as the unprivileged `node` user, exposes port 3000, has a [health check](#health-checks), and starts with `node --require ./peer-address.cjs server.js` from `/app/apps/vault`. If you replace the command, keep the preload: in production the vault refuses to start without it ([Client addresses behind a proxy](#client-addresses-behind-a-proxy)).
- `.dockerignore` keeps `.env*` files, `data/` directories, tests, docs, `deploy/`, `examples/demo`, `brands/`, `compose.yaml` and the Git metadata out of the build context.

For another architecture, or several at once, with your own registry:

```bash
docker buildx build -f apps/vault/Dockerfile --platform linux/amd64,linux/arm64 -t registry.example.com/wl-embedded-wallet-vault:0.1.0 --push .
```

Only `linux/arm64` has been built and tested. `sodium-native` ships Linux binaries for both architectures, but `linux/amd64` is untested.

## Generate secrets

```bash
docker run --rm wl-embedded-wallet-vault:local node scripts/generate-secrets.mjs > .env
```

`scripts/generate-secrets.mjs` has no dependencies, which is why it also runs inside the image. It writes two blocks:

- **stdout** (redirected to `.env`): the vault's secrets, `MASTER_KEY` (32 random bytes, hex), `MANIFEST_SIGNING_KEY` (Ed25519 private key, hex), `VAULT_SERVICE_TOKEN` (32 random bytes, hex) and `POSTGRES_PASSWORD` (24 random bytes, hex).
- **stderr** (printed to the terminal): material for **your app's backend**, which you copy there: `VAULT_HANDOFF_PRIVATE_KEY` (an Ed25519 private key, hex), `VAULT_HANDOFF_KID` (a `kid` derived from its public key) and a copy of `VAULT_SERVICE_TOKEN`. These names are the ones the SDK example in [INTEGRATION.md](INTEGRATION.md) reads (`packages/sdk/examples/mint-token.ts`); your backend may store them under any name, and the vault never reads them. The bundled demo (`examples/demo`) reads the key and `kid` as `DEMO_HANDOFF_PRIVATE_KEY` and `DEMO_HANDOFF_KID` (see [Demo app](#demo-app)), which the output also notes. The private key must never be placed in the vault's environment or reach a browser. Your backend publishes the matching public key in its JWKS. Generating it here is optional: your backend may use its own EdDSA, ES256 or RS256 key ([INTEGRATION.md](INTEGRATION.md)).

Then complete `.env` from the root [`.env.example`](../.env.example): at least `ORIGIN`, `RP_ID`, `HANDOFF_JWKS_URL` (or `HANDOFF_PUBLIC_KEY`) and `HANDOFF_ISSUER`, plus `VAULT_DOMAIN` for the TLS profile. Store `.env` as a secret: anyone who reads it together with the database obtains share A of every user.

For local development, use `pnpm setup:env` instead ([Local development](#local-development)).

## Start with the bundled Postgres

`compose.yaml` (Compose project `wl-embedded-wallet`) runs Postgres and the vault:

```bash
docker compose up -d --wait
```

- **`postgres`**: user and database `vault`, password `POSTGRES_PASSWORD`, data in the `postgres-data` volume, health check with `pg_isready` over TCP.
- **`vault`**: waits for Postgres to be healthy. `DATABASE_URL` is composed in `compose.yaml` itself (`postgres://vault:${POSTGRES_PASSWORD}@postgres:5432/vault`), so a `DATABASE_URL` in `.env` is ignored, and `POSTGRES_PASSWORD` must be URL-safe (the generated hex value is). The port is published only on `127.0.0.1:${VAULT_PORT:-3000}`, because TLS is terminated by a proxy. The container runs with a read-only root filesystem, a `tmpfs` on `/tmp`, all capabilities dropped, `no-new-privileges`, `init`, and as a non-root user.

Every variable the vault reads is passed through from `.env`; the ones marked `:?` in `compose.yaml` are required and Compose refuses to start without them. The brand directory is mounted with a commented-out `volumes` entry: see [Branding](#branding).

## External Postgres

Without `compose.yaml`, run the image directly. SSL is chosen in the URL with `sslmode`:

```bash
docker run -d --name vault --restart unless-stopped --init \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file .env \
  -e DATABASE_URL='postgres://vault_user:password@db.example.com:5432/vault?sslmode=verify-full' \
  -p 127.0.0.1:3000:3000 wl-embedded-wallet-vault:local
```

- The database user must be able to create tables and indexes: [migrations](#upgrades-and-migrations) run at startup.
- `POSTGRES_PASSWORD` is not used in this case.
- With a private CA, `sslmode=verify-full` requires Node to trust it: mount the CA certificate and point Node's standard `NODE_EXTRA_CA_CERTS` variable at it.
- The connection URL contains the password; the vault never logs it. On a connection failure at startup it logs only the error code.
- `sslmode=require`, `prefer` and `verify-ca` already behave as `verify-full` in `pg`; the vault spells them `verify-full` before connecting (same behavior, without `pg`'s `SECURITY WARNING`). `channel_binding=require`, which `pg` does not read from the URL, is removed from it and enables the pool's `enableChannelBinding` option instead; `channel_binding=disable` or `prefer` is just dropped (`server/store/postgres-url.ts`). The rest of the URL is kept as is.

Postgres over SSL, managed Postgres services and connection poolers are untested ([TEST-STATUS.md](TEST-STATUS.md)).

## Domain and TLS

The `tls` profile adds Caddy as an example TLS proxy (`deploy/Caddyfile`):

```bash
docker compose --profile tls up -d --wait
```

Set in `.env`:

```bash
VAULT_DOMAIN=vault.example.com
ORIGIN=https://vault.example.com
RP_ID=vault.example.com
```

with the domain's DNS pointing to this machine and ports 80 and 443 open. Caddy obtains the certificate for `VAULT_DOMAIN`, compresses responses and proxies to `vault:3000`. Its state lives in the `caddy-data` and `caddy-config` volumes. The example Caddyfile sets no extra headers. The vault itself sends `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no `preload`) on pages and API responses, in production and only when `ORIGIN` is `https`; add those directives at the proxy if you want them. Also set [`TRUSTED_PROXIES`](#client-addresses-behind-a-proxy) to Caddy's address, or every client shares one rate-limit bucket.

**This profile has only been checked with `caddy validate` and `docker compose config`.** It has not been tested with a real domain or a real certificate.

Any other TLS proxy works. The vault does not read `Host`, `X-Forwarded-Host` or `X-Forwarded-Proto`: it compares the browser's `Origin` header with the configured `ORIGIN`, so the proxy must pass `Origin` through unchanged. It reads `X-Forwarded-For` only from the proxies in `TRUSTED_PROXIES`, for rate limiting.

### Client addresses behind a proxy

Per-IP rate limits key on the client address (`server/rate-limit.ts`):

- The address is the socket's peer. Next.js does not expose it to route handlers, so the preload `apps/vault/scripts/peer-address.cjs` (`node --require ./peer-address.cjs server.js` in the image) writes it into the `x-vault-peer-address` request header of every request, replacing any copy the client sent. Without the preload the address is `unknown` for everyone, so **with `NODE_ENV=production` the vault refuses to start without it** (exit code 1, "peer-address preload is missing"). `scripts/start-standalone.mjs` (`pnpm start`) and `pnpm dev` load it too; `pnpm dev` sets it through `NODE_OPTIONS`, which needs a POSIX shell.
- Only when the peer is in `TRUSTED_PROXIES` is `X-Forwarded-For` read, from the right: the first entry that is not itself a trusted proxy is the client. If that entry is not an IP address, the peer is used.
- IPv6 clients are keyed by their /64. IPv4-mapped IPv6 addresses count as IPv4.
- `CLIENT_IP_SOURCE` chooses where the address comes from: `socket` (the default, everything above) or `vercel`. With `vercel`, and only inside a Vercel function (`VERCEL=1` **and** `VERCEL_REGION` set; `VERCEL_REGION` exists only at runtime, so the output of `vercel env pull` does not count), the address is the `x-real-ip` header, which the Vercel edge overwrites with the client address it saw. `X-Forwarded-For` and the peer header are never read then, and a missing, invalid or comma-separated `x-real-ip` is `unknown`. With `vercel` anywhere else no header is trusted and every client is `unknown`. Startup problems (fatal in production): an unknown value; `vercel` outside a Vercel runtime; `vercel` together with `TRUSTED_PROXIES`; and `VERCEL=1` with the default `socket`, because the preload cannot run on Vercel. With `vercel` in effect the preload is not required. See [Deploy to Vercel and Neon](#deploy-to-vercel-and-neon).

Set `TRUSTED_PROXIES` to the address or subnet your proxy connects from, and make sure the proxy appends (or sets) `X-Forwarded-For`; Caddy does by default. Without it, every client is counted as the proxy and shares its budget. Do not list a range that also contains clients: those could then choose their address through `X-Forwarded-For`.

- **Compose `tls` profile:** Caddy connects over the Compose network, from an address that changes between runs. Use that network's subnet (`docker network inspect wl-embedded-wallet_default`), or Docker's default pool `172.16.0.0/12` as in `.env.example`.
- **Proxy on the host, through the published port:** the peer is usually the Docker bridge gateway (for example `172.17.0.1` or the Compose network's gateway), not `127.0.0.1`. List that address.
- **No proxy at all** (not recommended): leave it unset.

## WebAuthn RP ID and the vault origin

- `ORIGIN` is the vault's public origin: scheme, host and optional port, no path and no trailing slash, HTTPS.
- `RP_ID` must be **exactly the host of `ORIGIN`**. A parent domain is rejected at startup, because it would let any subdomain request your users' passkeys.
- The vault must not share its origin with your app. Give it its own host (for example `vault.example.com` next to `app.example.com`).
- Passkeys, and therefore share B, are bound to `RP_ID`. **Changing `RP_ID` or losing the domain breaks every existing passkey.** Users then need their kit and recovery code (and re-enroll on the new domain if the vault still runs). The static recovery page only works on an origin valid for the same RP ID.
- `HANDOFF_AUDIENCE` defaults to `ORIGIN`, and the relink message signs `ORIGIN` as `vaultOrigin`: changing `ORIGIN` also invalidates handoff tokens that use the default audience and any pending relink nonce.

## Environment variables

`validateConfig` (`apps/vault/server/config.ts`) and the brand loader run before the vault accepts requests (`apps/vault/instrumentation.ts` → `server/startup.ts`). They report every problem at once, naming the variable and never its value. **With `NODE_ENV=production` (always the case in the image), any problem stops the process with exit code 1.** Outside production the problems are logged and the vault keeps running.

"Insecure local mode" below means `NODE_ENV` is not `production`, or `ALLOW_INSECURE_LOCAL=1`. Local hosts are `localhost`, `127.0.0.1`, `[::1]` and any `*.localhost` name.

### Vault

| Variable | Required | Default | Meaning and validation |
|---|---|---|---|
| `MASTER_KEY` | Yes | | 32 bytes in hex. Root key of the KMS stub: share A is sealed with AES-GCM under a key derived from it with HKDF per user and set (`server/kms.ts`). Losing it loses share A for everyone. |
| `MANIFEST_SIGNING_KEY` | Yes | | Ed25519 private key, 32 bytes in hex. Signs every share-set manifest. The public key is derived from it and published in the page HTML as `data-manifest-pubkey`. |
| `HANDOFF_JWKS_URL` | One of the two | | Your app's public JWKS, used to verify handoff tokens (EdDSA, ES256 or RS256, `kid` required). HTTPS; HTTP only on a local host in insecure local mode. Redirects are rejected. |
| `HANDOFF_PUBLIC_KEY` | One of the two | | Alternative to `HANDOFF_JWKS_URL`: a fixed Ed25519 public key, 32 bytes in hex (EdDSA only). No key rotation without a restart. Setting both, or neither, is an error. |
| `HANDOFF_ISSUER` | Yes | | Exact `iss` of your app's handoff tokens. Also part of the relink message. |
| `HANDOFF_AUDIENCE` | No | `ORIGIN` | Exact `aud` of the handoff tokens. |
| `HANDOFF_JWKS_CACHE_SECONDS` | No | `300` | Positive integer. How often the JWKS is refreshed. |
| `HANDOFF_JWKS_COOLDOWN_SECONDS` | No | `30` | Positive integer. Minimum time between refreshes for an unknown `kid`, and between retries after a failure. |
| `HANDOFF_JWKS_MAX_STALE_SECONDS` | No | `3600` | Positive integer. With the JWKS unreachable, how long the last good document stays usable. After that, tokens are rejected (`INVALID_TOKEN`) and the cause is logged. |
| `VAULT_SERVICE_TOKEN` | Yes | | At least 32 characters. Bearer token for [`GET /api/s2s/accounts/{sub}`](HTTP-API.md#get-apis2saccountssub). Your backend holds a copy; never a browser. |
| `ORIGIN` | Yes | | The vault's public origin. HTTPS (HTTP only on a local host in insecure local mode), no path or trailing slash. Every browser write must carry it as `Origin`. |
| `RP_ID` | Yes | | WebAuthn relying party ID. A hostname, exactly the host of `ORIGIN`. See [above](#webauthn-rp-id-and-the-vault-origin). |
| `ALLOWED_APP_ORIGINS` | No | Unset: any origin | Comma-separated app origins. An additional restriction: without it, any app origin that arrives signed in a valid token is accepted. Each entry must be a valid origin. |
| `DATABASE_URL` | Yes in production | `sqlite:data/vault.db` outside production | `postgres://` or `postgresql://` URL (SSL via `sslmode`). `sqlite:<path>` is rejected in production unless `ALLOW_INSECURE_LOCAL=1`. The SQLite file is created with mode `0600`, in WAL mode, relative to the working directory. With `VERCEL=1`, a Postgres URL whose host is not local must set `sslmode=require`, `verify-ca` or `verify-full`. |
| `DATABASE_POOL_SIZE` | No | `10`; `5` with `VERCEL=1` | Integer from 1 to 200. Postgres connections per replica (per function instance on Vercel, where idle connections are also closed after 5 seconds). |
| `AA_CHAINS` | No | `{}` | JSON object keyed by `chainId`. Bundler, paymaster and RPC per chain. Without an entry with `bundlerUrl`, the Safe cannot be deployed on that chain, nor send transactions there. See [Chain configuration](#chain-configuration). |
| `RPC_ALLOWED_HOSTS` | No | Empty: none | Comma-separated hostnames allowed for an RPC URL that arrives in a handoff token (or in the `rpcUrl` query of the service route) when `AA_CHAINS` has no `rpcUrl` for that chain. Such URLs must be HTTPS without credentials; HTTP only on a local host in insecure local mode. |
| `VAULT_BRAND_DIR` | No | Unset: neutral brand | Directory with `brand.json` and its files, mounted read-only. Read once at startup; an invalid brand stops the vault in production. See [BRANDING.md](BRANDING.md). |
| `VAULT_BRAND_NAME` | No | `name` in `brand.json`, else `Vault` | Name shown in the UI and stored with the passkey. At most 64 characters, no control characters. Overrides `name` in `brand.json`. |
| `ALLOW_INSECURE_LOCAL` | No | Unset | `1` allows, even in production, HTTP on local hosts (for `ORIGIN`, the JWKS URL, `AA_CHAINS` URLs, token RPC URLs, app origins and brand links) and SQLite. **Testing only.** |
| `CLIENT_IP_SOURCE` | No | `socket` | `socket` or `vercel`: where the client address for rate limits comes from. `vercel` reads `x-real-ip`, only inside a Vercel function, and cannot be combined with `TRUSTED_PROXIES`; on Vercel it is required. See [Client addresses behind a proxy](#client-addresses-behind-a-proxy). |
| `TRUSTED_PROXIES` | No | Unset: none | Comma-separated IPv4 or IPv6 addresses or CIDRs of the reverse proxies in front of the vault, whose `X-Forwarded-For` is read. Any invalid entry is a startup error in production, and at runtime makes the vault trust no proxy. See [Client addresses behind a proxy](#client-addresses-behind-a-proxy). |
| `RATE_LIMITS` | No | Unset: the defaults | JSON object `{ "<scope>": { "ip"?: n, "sub"?: n, "windowSeconds"?: n } }` with positive integers, merged field by field over the [defaults](#rate-limits). Unknown scopes or fields are startup errors. |
| `SHARE_A_WINDOW_SECONDS` | No | `3600` | Positive integer. Window of the share A release budgets. |
| `SHARE_A_MAX_PER_SESSION` | No | `5` | Positive integer. Share A releases per session in each window. |
| `SHARE_A_MAX_PER_USER` | No | `30` | Positive integer. Share A releases per user (`sub`) in each window, across sessions. |
| `RECOVERY_CHALLENGE_MAX_LIVE` | No | `1000` | Positive integer. Unexpired kit-free recovery challenges at once, across all clients. At the cap, `POST /api/recovery/passkey/challenge` answers `429`. |
| `AA_MAX_VERIFICATION_GAS_LIMIT` | No | `3000000` | Positive decimal integer. Cap on the `verificationGasLimit` of every operation the server builds (deployments and transactions). |
| `AA_MAX_CALL_GAS_LIMIT` | No | `500000` | Same, for `callGasLimit`. |
| `AA_MAX_PRE_VERIFICATION_GAS` | No | `500000` | Same, for `preVerificationGas`. Too low for some L2s: see [Sponsorship limits](#sponsorship-limits). |
| `AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT` | No | `500000` | Same, for `paymasterVerificationGasLimit`. |
| `AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT` | No | `200000` | Same, for `paymasterPostOpGasLimit`. |
| `AA_MAX_FEE_PER_GAS` | No | `500000000000` (500 gwei) | Positive decimal integer, in wei. Cap on `maxFeePerGas`; a network priced above it is refused (`FEES_TOO_HIGH`). |
| `AA_FEE_MULTIPLIER_PERCENT` | No | `200` | Integer from 100 to 1000. Margin on the node's `eth_gasPrice` in `maxFeePerGas`. See [Sponsorship limits](#sponsorship-limits). |
| `AA_PRIORITY_FEE_MULTIPLIER_PERCENT` | No | `120` | Integer from 100 to 1000. Margin on the priority fee (the tip) and on the bundler's quoted `maxFeePerGas`. |
| `AA_DEPLOYMENT_RETRY_SECONDS` | No | `900` | Positive integer. How long a sent sponsored deployment blocks another for the same Safe and chain. |

All of these are optional and passed through by `compose.yaml`; an empty value means the default. An invalid value is reported naming the variable (never the value) and stops the vault in production; outside production it is logged and the default is used.

`HANDOFF_JWKS_URL` and the other handoff variables are explained from the integrator's side in [INTEGRATION.md](INTEGRATION.md) and [PROTOCOL.md](PROTOCOL.md).

### Runtime, Compose and proxy

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `NODE_ENV` | Vault | `production` in the image | Production mode: CSP on, configuration errors fatal, SQLite and HTTP refused unless `ALLOW_INSECURE_LOCAL=1`. |
| `PORT` | Vault (Next.js server) | `3000` in the image | Internal listening port. |
| `HOSTNAME` | Vault (Next.js server) | `0.0.0.0` in the image | Listening interface. |
| `NODE_EXTRA_CA_CERTS` | Node.js | Unset | Extra CA certificates, for example for Postgres with a private CA. |
| `NEXT_DIST_DIR` | Vault build and `pnpm start` | `.next` | Build output directory. Used by the e2e tests to keep their build separate; not needed in a deployment. |
| `VERCEL`, `VERCEL_REGION` | Vault and demo, build and runtime | Set by Vercel | System variables; never set them yourself. `VERCEL=1` at build time turns off `output: 'standalone'` and traces the brand directory into the functions; at runtime it changes the pool defaults, requires `sslmode` and `CLIENT_IP_SOURCE=vercel`, and makes the demo require Postgres. `VERCEL_REGION` (runtime only) is what lets `x-real-ip` be read. |
| `ENABLE_EXPERIMENTAL_COREPACK` | Vercel build | Unset | `1` makes Vercel install the exact pnpm of `packageManager` in the root `package.json` (`pnpm@10.5.1`). |
| `POSTGRES_PASSWORD` | `compose.yaml` | Required with Compose | Password of the bundled Postgres; also used to compose the vault's `DATABASE_URL`. |
| `VAULT_IMAGE` | `compose.yaml` | `wl-embedded-wallet-vault:local` | Image for the `vault` service. |
| `VAULT_PORT` | `compose.yaml` | `3000` | Port published on `127.0.0.1`. |
| `VAULT_DOMAIN` | `compose.yaml`, `deploy/Caddyfile` | Required with the `tls` profile | Domain Caddy requests the certificate for. |
| `RECOVERY_DOMAIN` | `deploy/recovery.Caddyfile` | | Domain of the [static recovery page](#static-recovery-page). |

### Demo app

`examples/demo` is a sample integrator app. It is not part of the image and is not a hardened product; it runs locally for development and, as a public testnet demo, on Vercel ([Deploy to Vercel and Neon](#deploy-to-vercel-and-neon)). Its variables (`examples/demo/.env.example`):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DEMO_HANDOFF_PRIVATE_KEY` | Yes | | Ed25519 private key (32 bytes, hex) that signs the handoff tokens. |
| `DEMO_HANDOFF_KID` | Yes | | `kid` under which that key signs and is published at `/.well-known/jwks.json`. |
| `DEMO_HANDOFF_ISSUER` | No | `ORIGIN` | `iss` of a login shared by several apps; the same in all of them. Must match the vault's `HANDOFF_ISSUER`. |
| `DEMO_HANDOFF_PUBLISHED_KEYS` | No | `[]` | JSON `[{ "kid": "...", "publicKey": "<hex>" }]`: extra public keys kept in the JWKS during a key rotation. |
| `DEMO_TOTP_KEY` | Yes | | 32 bytes, hex. Encrypts the TOTP secrets of the demo's own login (second factor). |
| `VAULT_SERVICE_TOKEN` | Yes | | Same value as the vault's. |
| `VAULT_ORIGIN` | Yes | | The vault origin. Also the `aud` of the tokens the demo signs. |
| `ORIGIN` | Yes | | The demo's own origin, signed into each token as `origin`. |
| `DATABASE_URL` | Yes with `VERCEL=1` | Unset: SQLite at `DB_PATH` | `postgres://` or `postgresql://` selects Postgres (`pg`), with the same URL handling as the vault ([External Postgres](#external-postgres)); any other value is an error, and so is `VERCEL=1` without a Postgres URL ("DATABASE_URL is required on Vercel"). The schema (`users`, `sessions`, `rate_limits`) is created on first use, under a transaction-level advisory lock. Messages never include the URL. |
| `DATABASE_POOL_SIZE` | No | `5` | Integer from 1 to 200, Postgres connections per instance; an invalid value is an error. Connect timeout 10 seconds; with `VERCEL=1` idle connections are closed after 5 seconds. |
| `DB_PATH` | No | `data/demo.db` | The demo's SQLite file, used only without `DATABASE_URL` (local development, unit tests and e2e). |
| `DEMO_RATE_LIMITS` | No | Unset: the defaults | JSON `{ "<scope>": { "ip"?: n, "user"?: n, "windowSeconds"?: n } }` over the defaults of the demo's [auth limits](#demo-rate-limits). Invalid values fall back to the defaults. |
| `DEMO_CHAINS` | No | `[]` | JSON `[{ "chainId": 31001, "name": "Local A", "rpcUrl": "http://127.0.0.1:21545", "explorerUrl"?: "...", "nativeCurrency"?: "ETH" }]`: chains offered in the demo's selector. The RPC is signed into the token by the demo's server and never comes from the browser, but the browser can read the token: use keyless RPCs only. Validated on every use: a JSON array; `chainId` a positive safe integer, unique; `name` a non-empty string of at most 64 characters; `rpcUrl` an http(s) URL; optional `explorerUrl` an http(s) URL without credentials, query or fragment (a trailing slash is removed; links are `<explorerUrl>/address/<address>` and `/tx/<hash>`); optional `nativeCurrency` matching `^[A-Za-z0-9._-]{1,11}$`. The browser receives `chainId`, `name`, `explorerUrl` and `nativeCurrency`, never `rpcUrl`. An invalid value is not ignored: the pages and routes that need it fail (`500 INTERNAL`), and the error names `DEMO_CHAINS` without its value. |

#### Demo rate limits

The demo's auth routes are limited in its database (`examples/demo/server/rate-limit.ts`), so every instance shares the counters, after the `Origin` check and before any scrypt or TOTP work. Per 60-second window:

| Scope | Route | Per IP | Per user |
|---|---|---|---|
| `register` | `POST /api/auth/register` | 10 | |
| `login` | `POST /api/auth/login` | 20 | |
| `totp` | `POST /api/auth/totp` | 20 | 10 |
| `totp-setup` | `POST /api/auth/totp/setup` | 20 | 10 |

Over a budget the answer is `429 {"error":"RATE_LIMITED"}` with `Retry-After` and `Cache-Control: no-store`. There is no per-email limit on login, so nobody can lock another user out. The client address is `x-real-ip` only inside a Vercel function (`VERCEL=1` and `VERCEL_REGION`); anywhere else every request shares the `unknown` bucket, and `X-Forwarded-For` is never read. Locally that means one shared budget, which is why the e2e suite raises `DEMO_RATE_LIMITS`.

## Chain configuration

`AA_CHAINS` is a JSON object keyed by `chainId`. In `.env` put it on one line, between single quotes:

```json
{
  "11155111": {
    "name": "Sepolia",
    "nativeCurrency": "ETH",
    "rpcUrl": "https://rpc.example.com/API_KEY",
    "bundlerUrl": "https://bundler.example.com/API_KEY",
    "bundlerHeaders": { "Authorization": "Bearer ..." },
    "paymasterUrl": "https://paymaster.example.com/rpc",
    "paymasterHeaders": { "Authorization": "Bearer ..." },
    "paymasterContext": { "sponsorshipPolicyId": "..." },
    "sponsorTransactions": false,
    "limits": { "maxPreVerificationGas": "1000000", "maxFeePerGas": "50000000000" }
  }
}
```

| Field | Validation | Effect |
|---|---|---|
| key | `^[1-9][0-9]{0,15}$` | The chain id. |
| `name` | None | Shown as `chainName`. Without it, a built-in name for a few well-known chains (1, 10, 137, 8453, 42161, 80002, 84532, 11155111), else "Unnamed network". |
| `nativeCurrency` | `^[A-Za-z0-9._-]{1,11}$` | Symbol shown for amounts on that chain (`ChainStatus.nativeCurrency`, the deploy flow and the sign review). Without it, the built-in symbol of a well-known chain (`POL` on 137 and 80002, `ETH` on the others), else `ETH`. |
| `rpcUrl` | http(s) URL; HTTPS unless local in insecure local mode | Takes precedence over the RPC URL in the handoff token. Use it whenever the URL carries an API key, because the token passes through the browser. |
| `bundlerUrl` | Same | Required to deploy the Safe and to send transactions on that chain, and required if `paymasterUrl` is set. Signing works without it once the Safe is deployed. |
| `bundlerHeaders` | Object of strings | Added to every bundler request. |
| `paymasterUrl` | Same | ERC-7677 paymaster. Without it, the Safe must hold funds to pay for its own deployment. |
| `paymasterHeaders` | Object of strings | Added to every paymaster request. |
| `paymasterContext` | Object | Sent as the paymaster context. The server sets it; the browser cannot choose the sponsorship policy. |
| `sponsorTransactions` | `true` or `false`; `true` requires `paymasterUrl`. Default `false` | `true`: the paymaster also sponsors [transactions](#transaction-sponsorship) from the deployed Safe (`sendTransaction`), not only its deployment. Without it, the Safe pays for its own transactions. |
| `limits` | Object with the keys `maxVerificationGasLimit`, `maxCallGasLimit`, `maxPreVerificationGas`, `maxPaymasterVerificationGasLimit`, `maxPaymasterPostOpGasLimit`, `maxFeePerGas`, `feeMultiplierPercent`, `priorityFeeMultiplierPercent`; each a positive decimal integer string or a safe integer (the two multipliers from 100 to 1000). Unknown keys are errors. | Per-chain [sponsorship limits](#sponsorship-limits), over the `AA_MAX_*` variables. |

URLs and headers live only on the server. The browser talks to the vault's [`/api/aa/rpc`](HTTP-API.md#post-apiaarpc), where the server builds the deployment of the session user's own Safe, or one call from it once deployed, and forwards only that operation, signed by its owner. Real bundler and paymaster providers and public networks are untested ([TEST-STATUS.md](TEST-STATUS.md)); values for Pimlico on three public testnets are in [Public testnets](#public-testnets). Integrator details: [INTEGRATION.md](INTEGRATION.md).

### Sponsorship limits

The server builds every deployment and every transaction within caps (`server/limits.ts`), whether or not a paymaster sponsors it. For each field the value is taken from `AA_CHAINS["<chainId>"].limits`, then its environment variable, then the default:

| Limit | Variable | Default |
|---|---|---|
| `maxVerificationGasLimit` | `AA_MAX_VERIFICATION_GAS_LIMIT` | 3,000,000 |
| `maxCallGasLimit` | `AA_MAX_CALL_GAS_LIMIT` | 500,000 |
| `maxPreVerificationGas` | `AA_MAX_PRE_VERIFICATION_GAS` | 500,000 |
| `maxPaymasterVerificationGasLimit` | `AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT` | 500,000 |
| `maxPaymasterPostOpGasLimit` | `AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT` | 200,000 |
| `maxFeePerGas` (wei) | `AA_MAX_FEE_PER_GAS` | 500 gwei |
| `feeMultiplierPercent` | `AA_FEE_MULTIPLIER_PERCENT` | 200 |
| `priorityFeeMultiplierPercent` | `AA_PRIORITY_FEE_MULTIPLIER_PERCENT` | 120 |

Fees are decided by the server (`deploymentFees` in `server/sponsorship.ts`) from the node's `eth_gasPrice` and `eth_maxPriorityFeePerGas` and, when the bundler answers it, its `pimlico_getUserOperationGasPrice` quote (`standard` tier), which is used as a floor:

- tip (`maxPriorityFeePerGas`) = max(node tip, bundler tip) × `priorityFeeMultiplierPercent` / 100;
- `maxFeePerGas` = max(`eth_gasPrice` × `feeMultiplierPercent` / 100 + tip, bundler `maxFeePerGas` × `priorityFeeMultiplierPercent` / 100), clamped to the cap, and the tip never above it.

A bundler without that method (method not found, an error, a malformed answer) leaves the node's values alone. A node gas price, node tip or bundler quote already above the cap is refused (`FEES_TOO_HIGH`). The floor exists because Pimlico (alto) refuses `eth_sendUserOperation` below its own recent quotes: on Sepolia the node's tip is about 50 wei while Pimlico asks 0.001 to 0.7 gwei, and on Polygon Amoy and Base Sepolia the node's tip equals Pimlico's floor exactly, so the tip margin covers a floor that rises between prepare and send. Each gas limit from the bundler's estimate gets 20 % more, clamped to its cap; an estimate already above its cap, or a paymaster gas limit above its cap, is refused (`GAS_LIMIT_EXCEEDED`).

The defaults suit L1-like chains and have not been tested against real providers. **On L2s, override them per chain:** on OP-stack chains (Optimism, Base) and Arbitrum, `preVerificationGas` includes the L1 data cost and can exceed 500,000 (millions on Arbitrum), so raise `maxPreVerificationGas`; and 500 gwei is a loose cap where fees are a fraction of a gwei, so lower `maxFeePerGas`. A sponsored deployment or transaction can cost up to the gas caps times the fee cap: size them against your paymaster budget.

### Transaction sponsorship

Transactions use the same fees and caps as deployments. Where `sponsorTransactions` is `true`, the paymaster pays their network fee; elsewhere the Safe pays it in the native currency, and `vault_prepareTransaction` answers `INSUFFICIENT_FUNDS` unless the Safe's balance covers the value plus the maximum fee (the gas limits times `maxFeePerGas`). The value is always paid by the Safe.

**Sponsoring transactions lets every user spend your paymaster budget on calls of their choosing**, not only on one deployment per Safe and chain. The vault bounds each operation (gas and fee caps), each user and IP (the [`transaction` rate-limit scope](#rate-limits)), and sends only operations it prepared, once, within 10 minutes. It has no total budget: set per-user and global spend limits in the paymaster's sponsorship policy (in the Pimlico dashboard, on the policy referenced by `paymasterContext`), and treat them as the outer bound. See [THREAT-MODEL.md](THREAT-MODEL.md).

## Rate limits

The vault limits its routes itself (`server/rate-limit.ts`). Each scope has a per-IP and, where there is a known `sub`, a per-`sub` budget, counted in fixed windows (60 seconds by default) in the `rate_limits` table, so replicas share them. A request over a budget gets `429 { "error": "RATE_LIMITED" }` with `Retry-After` in seconds ([HTTP-API.md](HTTP-API.md#rate-limiting)).

| Scope | Routes | Per IP | Per `sub` |
|---|---|---|---|
| `handoff` | `POST /api/auth/handoff` | 30 | 10 |
| `share-a` | `GET /api/shares/a` | 60 | 30 |
| `enroll` | `POST /api/webauthn/challenge`, `POST` and `PATCH /api/shares` | 20 | 10 |
| `recovery-challenge` | `POST /api/recovery/passkey/challenge` | 10 | |
| `recovery-assertion` | `POST /api/recovery/passkey` | 10 | |
| `relink-nonce` | `POST /api/relink/nonce` | 10 | 5 |
| `relink` | `POST /api/relink` | 10 | 5 |
| `aa` | `GET /api/aa/status`, `POST /api/aa/rpc` | 240 | 120 |
| `transaction` | `vault_prepareTransaction` on `POST /api/aa/rpc`, on top of `aa` | 30 | 10 |
| `s2s` | `GET /api/s2s/accounts/{sub}` | 600 | 60 |

Override any field with `RATE_LIMITS`, for example `RATE_LIMITS='{"handoff":{"ip":60},"s2s":{"windowSeconds":10}}'`. Share A releases also have their own budgets (`SHARE_A_*`), and live recovery challenges a global cap (`RECOVERY_CHALLENGE_MAX_LIVE`).

These defaults are a starting point, not tuned for any traffic, and have not been tested under real load or behind a real proxy. The per-IP limits only work if the vault sees real client addresses: see [Client addresses behind a proxy](#client-addresses-behind-a-proxy). Behind a proxy that many users share (a corporate NAT, for example), raise the per-IP limits. The `aa` limit must allow the receipt polling of the deploy and transaction flows (once a second for the first 30 polls, then every 3 seconds, for up to 180 seconds: at most 60 requests a minute per operation). Each `vault_prepareTransaction` may be sponsored and costs paymaster and bundler calls, so the `transaction` scope is much lower; size it against your paymaster budget where `sponsorTransactions` is on. Limiting at the proxy as well remains useful, especially for request floods that never reach a route.

## Branding

Each deployment can carry its own brand **without rebuilding the image**: a directory with `brand.json` and its files, mounted into the container and named by `VAULT_BRAND_DIR`. Without it the vault uses its neutral brand. The format, validation rules and what cannot be customized are in [BRANDING.md](BRANDING.md); the fictional example is [`brands/example`](../brands/example).

With Compose, uncomment the `volumes` entry of the `vault` service and set `VAULT_BRAND_DIR=/brand` in `.env`:

```yaml
    volumes:
      - ./brands/example:/brand:ro
```

With `docker run`:

```bash
docker run ... --env-file .env -e VAULT_BRAND_DIR=/brand --volume "$PWD/my-brand:/brand:ro" ... wl-embedded-wallet-vault:local
```

The brand is read once per process: restart the container to change it.

## Offline recovery tool

The vault serves the offline recovery tool at [`GET /recovery-tool`](HTTP-API.md#get-recovery-tool). The UI makes users download it before every kit it hands out, so **if `/recovery-tool` does not serve the tool, nobody can enroll or rotate.** The image and `pnpm build` include it. After deploying, compare what your vault serves with the published hash in [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md):

```bash
curl -fsS https://vault.example.com/recovery-tool | shasum -a 256
```

Publish that hash with each release **outside the vault's domain**: a compromised vault can serve a different tool just as it can serve different JavaScript. How users run the tool and its CLI: [RECOVERY.md](RECOVERY.md).

## Static recovery page

A static page that lets a user recover with kit + passkey + recovery code, with no backend at all. It uses the same worker logic as the vault and cannot talk to anything (`connect-src 'none'`). For the same reason it cannot fetch the recovery tool and does not hand out new kits.

### Build

```bash
pnpm --filter ./apps/vault build:static-recovery --rp-id vault.example.com --manifest-pubkey <hex> --out /absolute/path/recovery --brand-dir /absolute/path/my-brand
```

| Option | Required | Meaning |
|---|---|---|
| `--rp-id` | Yes | Your `RP_ID`, exactly. |
| `--manifest-pubkey` | Yes | The manifest public key, 32 bytes in lowercase hex: the `data-manifest-pubkey` value in the vault's HTML. |
| `--out` | No | Output directory. Default `dist/static-recovery`. Relative paths resolve against the working directory, which `pnpm --filter` sets to `apps/vault`; prefer absolute paths. |
| `--brand-dir` | No | The same brand directory the vault mounts. An invalid brand produces no output. |
| `--brand` | No | Overrides the brand name, like `VAULT_BRAND_NAME`. 1 to 64 characters, no control characters. |

`apps/vault/scripts/build-static-recovery.mjs` writes `index.html`, `recovery.js`, `recovery-worker.js`, `recovery.css`, the brand files (`brand.css` and `brand-<hash>.<ext>`, next to the HTML), a `_headers` file and a `SHA256SUMS` file covering all of them, and prints the sums.

### Where to host it

It only works from an origin valid for the RP ID, because the browser binds the passkey to it: the vault's own host or a subdomain of it.

- **`https://recovery.vault.example.com`, recommended:** a separate static host (an object store behind a CDN, a static site host, or a Caddy server) that does not depend on the vault's machine. Deploy it from day one, and only add this host to your DNS.
- **`https://vault.example.com`:** only as an emergency plan, pointing the DNS at the static host once the vault no longer exists.
- **Any other domain does not work:** the browser refuses the passkey request for that RP ID. If the domain is lost, share B is unusable and the only path left is the kit and the code.

A subdomain of the RP ID can request your users' passkeys: protect it like the vault itself and do not delegate it to third parties.

### Headers

The HTML carries its CSP in a `<meta>` tag, but a worker's CSP comes from the response that serves its script, so the host must send headers. The build writes `_headers` in the format used by Netlify and Cloudflare Pages. On any other host, send the same headers on every file; [`deploy/recovery.Caddyfile`](../deploy/recovery.Caddyfile) is an example (set `RECOVERY_DOMAIN` and serve the build from `/srv/recovery`):

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'none'; worker-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types default; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The page does not re-enroll users, because that needs the server; the vault's `/recover` page does it with a session. The page is tested in e2e with a static server and the vault blocked, in Chromium, but not on any real hosting provider.

## Health checks

[`GET /api/health`](HTTP-API.md#get-apihealth) returns `200 {"status":"ok"}` when the database answers and `503 {"status":"unavailable"}` otherwise, without revealing anything else.

The image's `HEALTHCHECK` calls it every 15 seconds (5-second timeout, 30-second start period, 3 retries), so Docker marks the container `unhealthy` while the database is down and healthy again when it returns. A failed database connection is not cached: the vault reconnects on the next request. Compose's `caddy` service waits for this health check.

Observability is limited to stdout logs and this endpoint.

## Upgrades and migrations

1. Back up the database ([Backups](#backups)).
2. Build or obtain the new image.
3. Replace the container: `docker compose up -d --wait` (or recreate it with `docker run`).

Migrations (`apps/vault/server/store/migrate.ts` and `migrations/`) run automatically at startup, before requests are accepted:

- They are versioned in code (`001-initial` to `007-prepared-transactions` in this release) and recorded in a `schema_migrations` table (`version`, `name`, `applied_at`).
- All pending migrations run in **one transaction**. On Postgres it takes a transaction-level advisory lock, so replicas that start at the same time are serialized, and it also works behind a pooler. On SQLite, `BEGIN IMMEDIATE` does the same.
- **There are no down migrations.** A vault started against a schema newer than it knows refuses to touch it ("The database schema is newer than this vault") and, in production, exits. To roll back, restore the backup taken before upgrading.
- Some migrations are destructive by design: `002-remove-vault-second-factor` deletes all sessions and drops the old TOTP columns. Sessions are short-lived, so users only need to reopen the popup.
- `006-limits-and-audit` adds `rate_limits`, `share_a_releases`, `sponsored_deployments` and `share_sets.created_session_hash`. Sets that were `pending` before it have no creating session recorded, so share A of those sets is never released: the user restarts that enrollment or rotation. Active sets are unaffected.
- `007-prepared-transactions` adds `prepared_transactions`, the transactions the server built for a deployed Safe. It changes no existing table.

Restoring from a backup is untested.

## Backups

| If you lose | Consequence | Can it be regenerated? |
|---|---|---|
| `MASTER_KEY` | Share A of every user is unusable. Users can still recover with B+C, or with their kit and code. | **No** |
| `MANIFEST_SIGNING_KEY` | No manifest verifies: the vault flows and the static page abort with `MANIFEST_INVALID`. The offline tool does not depend on it. | **No**, short of code changes |
| The database | No shares on the server. Only kits and exported seeds survive; with kit and code a user keeps their seed. | **No** |
| Your app's handoff signing key | Your app cannot open the vault. | Yes: publish a new key in your JWKS, no vault restart needed |
| `VAULT_SERVICE_TOKEN` | Your backend cannot query accounts. | Yes |

What to back up: **the database** (Postgres dump or volume snapshot) and **the two keys** (`MASTER_KEY`, `MANIFEST_SIGNING_KEY`). Store them **separately**: together, a leak gives share A of every user. The database alone is useless without `MASTER_KEY`, and share A alone reconstructs nothing.

The `wallet_relinks` and `share_a_releases` tables are audit trails that are never pruned; keep them in your backups. `sponsored_deployments` keeps one row per Safe and chain ever prepared and is not pruned either. In `prepared_transactions`, rows never sent are deleted once they expire; sent ones are kept.

## Multiple replicas

Replicas can share one Postgres with no session affinity: sessions, single-use `jti` values, WebAuthn challenges, relink nonces, rate-limit counters, share A budgets, sponsored deployments and prepared transactions are all in the database, and every operation that relies on atomicity stays atomic across replicas. Limits are therefore per deployment, not per replica. Rate-limit windows follow each replica's clock, so keep the clocks synchronized. All replicas need the same environment. `DATABASE_POOL_SIZE` times the number of replicas must stay below Postgres's `max_connections` and your pooler's limit.

Known limitation: a browser holds one vault session cookie, and redeeming a new token deletes that browser's previous session. Two concurrent operations from the same browser (for example on two chains) therefore interfere.

Two replicas are exercised by `pnpm test:e2e:image`: enrollment and deployment on one, signing on the other, and the same token rejected on the second.

## Deploy to Vercel and Neon

The vault and the demo app can each run as a Vercel project with its own Neon Postgres database. This is the setup of the public testnet demo. The repository carries what Vercel needs; the public demo runs on it. Run the [smoke tests](#smoke-tests) after the first deployment of your own.

> [!WARNING]
> **Passkeys made on a `*.vercel.app` vault are bound to that host forever.** `RP_ID` must be the vault's host, and moving later to a custom domain changes it: every passkey, the PRF material derived from it and the kit-free recovery path become unusable, and users are left with their kit and recovery code. Treat a `*.vercel.app` deployment as a **testnet demo whose wallets may be lost**, or use the final custom domain from day one.

Other differences from the image:

- **No preload:** the client address comes from `x-real-ip` (`CLIENT_IP_SOURCE=vercel`, see [Client addresses behind a proxy](#client-addresses-behind-a-proxy)).
- **`MASTER_KEY` and the other secrets are Vercel environment variables.** That is as demo-grade as the image's environment (there is no real KMS): Sensitive values cannot be read back from the dashboard, but anyone who can change the project's settings or deploy to it can replace them or ship code that reads them. Not for real funds.
- **The brand is part of the build:** `VAULT_BRAND_DIR` must point inside the repository and be set when Vercel builds, not only at runtime.

### What the repository sets

| File | Effect |
|---|---|
| `apps/vault/vercel.json`, `examples/demo/vercel.json` | Framework `nextjs`, install `pnpm install --frozen-lockfile`, build `pnpm run build`, and `git.deploymentEnabled: { "**": false, "main": true }`: only `main` deploys, there are no preview deployments. |
| `apps/vault/next.config.mjs` | With `VERCEL=1` at build time: no `output: 'standalone'` (that is for the image), and a relative `VAULT_BRAND_DIR` is added to `outputFileTracingIncludes` for every route (`'**'`), because a missing brand stops the vault in production. The offline tool is traced into `/recovery-tool`; the vault's `build` script generates it before `next build`. A local Vercel-like build traced the 13 files of `brands/wl` into every route and the tool into `/recovery-tool`. |
| Route segment config | `maxDuration = 60` on the vault's `api/aa/rpc`, `api/aa/status`, `api/shares`, `api/s2s/accounts/[sub]` and `api/auth/handoff`; `maxDuration = 30` on the demo's `api/wallet`, `api/signatures/verify` and `api/vault/token`. They call RPCs, the bundler, the paymaster, the JWKS or the vault. |
| Root `package.json` | `"packageManager": "pnpm@10.5.1"`, the version of the image and CI. Set `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses it. |
| Root `.vercelignore` | Only for `vercel deploy` from a working tree, which does not read `.gitignore`: it keeps `.env*` files, `data/` and build output out of the upload. Deploy through the Git integration, not the CLI. |

At runtime `VERCEL=1` also changes the code: the vault and the demo default to 5 Postgres connections per instance and close idle ones after 5 seconds; the vault requires `sslmode` on a non-local `DATABASE_URL` and `CLIENT_IP_SOURCE=vercel`; the demo requires `DATABASE_URL`.

<a id="vercel-aa-chains"></a>

### Updating `AA_CHAINS` from a local file

`AA_CHAINS` carries the bundler and paymaster API keys, so it is a Sensitive variable that cannot be read back, and a
JSON typo in the dashboard stops the vault (`Invalid configuration: AA_CHAINS is not valid JSON`). Keep it in a local,
ignored file instead and push it with `scripts/vercel-aa-chains.mjs`:

```bash
mkdir -p .secrets && cp deploy/vercel/aa-chains.example.json .secrets/aa-chains.json   # then fill in the keys
echo '{ "project": "<vault project>", "team": "<team slug>" }' > .secrets/vercel.json
node scripts/vercel-aa-chains.mjs --check       # validates; prints chain ids, hosts and flags, never keys
node scripts/vercel-aa-chains.mjs --redeploy    # saves it as Sensitive (Production) and redeploys the vault
```

`.secrets/` is in `.gitignore` and `.vercelignore`. The token is `VERCEL_TOKEN` or the Vercel CLI's login. The script
checks the structure (valid JSON, known fields, https URLs, no leftover `<PLACEHOLDER>`); the vault still runs its full
validation at startup, so check `/api/health` after the redeploy.

### Project settings

Create two projects from the same Git repository, production branch `main`:

| Setting | Vault | Demo |
|---|---|---|
| Root Directory | `apps/vault` | `examples/demo` |
| Include files outside the Root Directory | On (`packages/*`, `brands/*`, the root lockfile) | On |
| Framework, install and build commands | From `vercel.json` | From `vercel.json` |
| Node.js version | 22.x | 22.x |
| Fluid compute | On | On |
| Function region | The Neon region (for example `fra1` with Neon `aws-eu-central-1`) | The same |
| Deployment Protection | Standard. **Not** "All deployments": the vault fetches the demo's JWKS and the demo calls the vault's s2s route over the public production domains, without Vercel authentication. | Standard |
| Git Fork Protection | On | On |
| Automatically expose System Environment Variables | On (`VERCEL`, `VERCEL_REGION`) | On |
| Web Analytics, Speed Insights, Vercel Toolbar | **Off**: they inject scripts that the vault's CSP and Trusted Types block. With previews disabled, the preview toolbar never appears. | Optional |

The vault's CSP is the same as in the image. Vault and demo on `*.vercel.app` are different sites (`vercel.app` is on the Public Suffix List), unlike `vault.localhost` and `app.localhost` locally. That should not matter, because the vault's `SameSite=Strict` cookie is only used inside its own popup, but it has not been verified on the deployed domains.

### Neon

From each project's **Storage** tab, create its **own** Neon resource in the region of the functions and connect it to **Production** only, with **no environment variable prefix**, so the integration injects `DATABASE_URL`. Do not share one database between the two: the demo has open registration, and both apps have a `sessions` table.

- `DATABASE_URL` is Neon's pooled URL (`-pooler` host, `sslmode=require&channel_binding=require`). It works for the migrations too, because they take a transaction-level advisory lock and use no session state; `DATABASE_URL_UNPOOLED` is not needed.
- The vault and the demo rewrite `sslmode=require` as `verify-full` and turn `channel_binding=require` into `enableChannelBinding` ([External Postgres](#external-postgres)). Neon's certificates are publicly trusted, so no CA has to be added.
- The integration also injects `DATABASE_URL_UNPOOLED`, `POSTGRES_*` and `PG*` variables. Neither app reads them; never use the `NO_SSL` variant.
- Backups follow the Neon plan's point-in-time window. Losing the vault database loses share A and the manifests of every user (users keep their kit): see [Backups](#backups).

### Order of operations

1. Create both projects with the settings above, without deploying (or accept a first failed deployment). **Read their real production domains**: if a name is taken, Vercel picks another. `ORIGIN`, `RP_ID` and the cross-references depend on them.
2. Create and connect the two Neon resources.
3. [Generate the secrets](#secrets-for-vercel).
4. Add the [vault](#vault-environment-on-vercel) and [demo](#demo-environment-on-vercel) variables to **Production** only, secrets marked **Sensitive**, and go through the [cross-reference checklist](#cross-reference-checklist).
5. Deploy the demo first (the vault fetches its JWKS on the first handoff), then the vault.
6. Run the [smoke tests](#smoke-tests).

### Secrets for Vercel

Generate them once, on your machine, outside the repository:

```bash
(
  umask 077
  node scripts/generate-secrets.mjs > vault.env 2> demo.env
  node -e "console.log('DEMO_TOTP_KEY=' + require('node:crypto').randomBytes(32).toString('hex'))" >> demo.env
)
```

- `vault.env` (stdout): `MASTER_KEY`, `MANIFEST_SIGNING_KEY`, `VAULT_SERVICE_TOKEN` and `POSTGRES_PASSWORD`, which only Compose uses: ignore it.
- `demo.env` (stderr, plus the line above): `VAULT_HANDOFF_PRIVATE_KEY` and `VAULT_HANDOFF_KID`, which the demo reads as `DEMO_HANDOFF_PRIVATE_KEY` and `DEMO_HANDOFF_KID`, the same `VAULT_SERVICE_TOKEN`, and `DEMO_TOTP_KEY`, which `generate-secrets.mjs` does not produce (`pnpm setup:env` does, for local development only). Comment lines start with `#`.

Add them with `vercel env add <NAME> production --sensitive` or the dashboard's Sensitive toggle. Sensitive values cannot be read back, so first keep a copy of `MASTER_KEY` and `MANIFEST_SIGNING_KEY` outside Vercel ([Backups](#backups)); then delete both files.

### Vault environment on Vercel

`V` is the vault's production origin and `D` the demo's, for example `https://wl-embedded-wallet-vault.vercel.app` and `https://wl-embedded-wallet-demo.vercel.app`.

| Variable | Value or source | Sensitive | Notes |
|---|---|---|---|
| `MASTER_KEY` | Generated | Yes | Losing it loses share A for everyone |
| `MANIFEST_SIGNING_KEY` | Generated | Yes | |
| `VAULT_SERVICE_TOKEN` | Generated | Yes | The same value in the demo |
| `ORIGIN` | `V` | No | No trailing slash |
| `RP_ID` | Host of `V` | No | Permanent for every passkey ([warning above](#deploy-to-vercel-and-neon)) |
| `HANDOFF_JWKS_URL` | `D/.well-known/jwks.json` | No | |
| `HANDOFF_ISSUER` | `D` | No | The demo's `DEMO_HANDOFF_ISSUER`, which defaults to its `ORIGIN` |
| `ALLOWED_APP_ORIGINS` | `D` | No | |
| `CLIENT_IP_SOURCE` | `vercel` | No | Required on Vercel |
| `DATABASE_URL` | Injected by Neon | Yes | |
| `VAULT_BRAND_DIR` | `../../brands/wl` | No | Relative to `apps/vault`; read at build (tracing) and at runtime |
| `AA_CHAINS` | See [Public testnets](#public-testnets) | Yes | Carries the bundler and paymaster API key |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | No | Build |
| `HANDOFF_AUDIENCE`, `DATABASE_POOL_SIZE`, `VAULT_BRAND_NAME`, `RPC_ALLOWED_HOSTS`, `RATE_LIMITS`, `SHARE_A_*`, `AA_*` | Optional | No | Defaults are fine for a testnet demo. `RPC_ALLOWED_HOSTS` is not needed when every `AA_CHAINS` entry has an `rpcUrl` |
| `HANDOFF_PUBLIC_KEY`, `TRUSTED_PROXIES`, `ALLOW_INSECURE_LOCAL`, `NEXT_DIST_DIR` | **Unset** | | |
| `NODE_ENV`, `VERCEL`, `VERCEL_REGION` | Set by Vercel | | Do not set |

### Demo environment on Vercel

| Variable | Value or source | Sensitive | Notes |
|---|---|---|---|
| `DEMO_HANDOFF_PRIVATE_KEY` | Generated (`VAULT_HANDOFF_PRIVATE_KEY`) | Yes | |
| `DEMO_HANDOFF_KID` | Generated (`VAULT_HANDOFF_KID`) | No | |
| `DEMO_TOTP_KEY` | Generated | Yes | |
| `VAULT_SERVICE_TOKEN` | The vault's value | Yes | |
| `VAULT_ORIGIN` | `V` | No | Also the `aud` of the tokens |
| `ORIGIN` | `D` | No | |
| `DATABASE_URL` | Injected by Neon (the demo's own resource) | Yes | |
| `DEMO_CHAINS` | See [Public testnets](#public-testnets) | No | Keyless RPCs only |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | No | Build |
| `DEMO_HANDOFF_ISSUER`, `DEMO_HANDOFF_PUBLISHED_KEYS`, `DATABASE_POOL_SIZE`, `DEMO_RATE_LIMITS` | Optional | No | |
| `DB_PATH` | **Unset** | | |
| `NODE_ENV`, `VERCEL`, `VERCEL_REGION` | Set by Vercel | | Do not set |

### Cross-reference checklist

- [ ] The host of the vault's `HANDOFF_JWKS_URL` is the demo's production domain.
- [ ] The vault's `HANDOFF_ISSUER` equals the demo's `DEMO_HANDOFF_ISSUER` or, if unset, its `ORIGIN`.
- [ ] The demo's `VAULT_ORIGIN` equals the vault's `ORIGIN` (and its `HANDOFF_AUDIENCE`, if set).
- [ ] The vault's `RP_ID` is exactly the host of its `ORIGIN`.
- [ ] The vault's `ALLOWED_APP_ORIGINS` contains the demo's `ORIGIN`.
- [ ] `VAULT_SERVICE_TOKEN` is identical in both projects.
- [ ] Every `DEMO_CHAINS[].chainId` that should deploy a Safe has an `AA_CHAINS` entry with `bundlerUrl` (and `paymasterUrl` to sponsor it, plus `"sponsorTransactions":true` to sponsor its transactions).
- [ ] Every `DEMO_CHAINS[].rpcUrl` host is in `RPC_ALLOWED_HOSTS`, unless that chain has an `rpcUrl` in `AA_CHAINS`.

### Public testnets

Values for Ethereum Sepolia, Polygon Amoy and Base Sepolia with Pimlico as bundler and paymaster (EntryPoint v0.7), checked on 2026-11-11: the Safe 4337 contracts the vault expects are deployed on all three, and the factory returns the predicted address. Nothing has been sent through the vault to any of them yet, neither a deployment nor a transaction ([TEST-STATUS.md](TEST-STATUS.md)).

| Chain | `chainId` | Native currency | Keyless RPC | Explorer |
|---|---|---|---|---|
| Ethereum Sepolia | 11155111 | ETH | `https://ethereum-sepolia-rpc.publicnode.com` | `https://sepolia.etherscan.io` |
| Polygon Amoy | 80002 | POL | `https://polygon-amoy-bor-rpc.publicnode.com` | `https://amoy.polygonscan.com` |
| Base Sepolia | 84532 | ETH | `https://base-sepolia-rpc.publicnode.com` | `https://sepolia.basescan.org` |

`AA_CHAINS` for the vault (replace `<PIMLICO_API_KEY>`; in the Vercel dashboard paste only the JSON, without the quotes):

```bash
AA_CHAINS='{"11155111":{"name":"Ethereum Sepolia","rpcUrl":"https://ethereum-sepolia-rpc.publicnode.com","bundlerUrl":"https://api.pimlico.io/v2/11155111/rpc?apikey=<PIMLICO_API_KEY>","paymasterUrl":"https://api.pimlico.io/v2/11155111/rpc?apikey=<PIMLICO_API_KEY>","sponsorTransactions":true,"limits":{"maxFeePerGas":"100000000000"}},"80002":{"name":"Polygon Amoy","nativeCurrency":"POL","rpcUrl":"https://polygon-amoy-bor-rpc.publicnode.com","bundlerUrl":"https://api.pimlico.io/v2/80002/rpc?apikey=<PIMLICO_API_KEY>","paymasterUrl":"https://api.pimlico.io/v2/80002/rpc?apikey=<PIMLICO_API_KEY>","sponsorTransactions":true,"limits":{"maxFeePerGas":"500000000000"}},"84532":{"name":"Base Sepolia","rpcUrl":"https://base-sepolia-rpc.publicnode.com","bundlerUrl":"https://api.pimlico.io/v2/84532/rpc?apikey=<PIMLICO_API_KEY>","paymasterUrl":"https://api.pimlico.io/v2/84532/rpc?apikey=<PIMLICO_API_KEY>","sponsorTransactions":true,"limits":{"maxPreVerificationGas":"1000000","maxFeePerGas":"2000000000"}}}'
```

`DEMO_CHAINS` for the demo:

```bash
DEMO_CHAINS='[{"chainId":11155111,"name":"Ethereum Sepolia","rpcUrl":"https://ethereum-sepolia-rpc.publicnode.com","explorerUrl":"https://sepolia.etherscan.io","nativeCurrency":"ETH"},{"chainId":80002,"name":"Polygon Amoy","rpcUrl":"https://polygon-amoy-bor-rpc.publicnode.com","explorerUrl":"https://amoy.polygonscan.com","nativeCurrency":"POL"},{"chainId":84532,"name":"Base Sepolia","rpcUrl":"https://base-sepolia-rpc.publicnode.com","explorerUrl":"https://sepolia.basescan.org","nativeCurrency":"ETH"}]'
```

`RPC_ALLOWED_HOSTS` is not needed: every chain has an `rpcUrl` in `AA_CHAINS`, which takes precedence over the token's. Without those, set `RPC_ALLOWED_HOSTS=ethereum-sepolia-rpc.publicnode.com,polygon-amoy-bor-rpc.publicnode.com,base-sepolia-rpc.publicnode.com`.

Per chain:

- **Ethereum Sepolia:** a deployment estimates about 1.83M `verificationGasLimit`, which with the 20 % margin needs the default cap of 3,000,000 (so the old per-chain override is no longer needed). `maxFeePerGas` is capped at 100 gwei for budget hygiene. The node's tip is about 50 wei, far below what Pimlico accepts: the [bundler quote](#sponsorship-limits) is what makes the send pass.
- **Polygon Amoy:** fees can spike, so the cap stays at the default 500 gwei, written out in case `AA_MAX_FEE_PER_GAS` is lowered globally. `nativeCurrency` is `POL`, as the built-in default for 80002. The node's tip equals Pimlico's floor (about 30 gwei); the tip margin (`priorityFeeMultiplierPercent`, 120 %) gives the headroom.
- **Base Sepolia:** an OP-stack chain, where Pimlico folds the L1 data fee into `preVerificationGas`. It is about 53k today but can climb into the hundreds of thousands when Sepolia L1 fees rise, so `maxPreVerificationGas` is 1,000,000. `maxFeePerGas` is 2 gwei, where fees are around 0.01 gwei.

Pimlico:

- The same URL, `https://api.pimlico.io/v2/<chainId>/rpc?apikey=<KEY>`, serves the bundler and the paymaster, with no headers. The key in the query string is never logged by the vault, and URLs are stripped from upstream error messages; `AA_CHAINS` must still be Sensitive.
- The paymaster sponsors from the Pimlico account's balance, and new accounts start with no credit: fund the account, or create a sponsorship policy in the Pimlico dashboard and add `"paymasterContext":{"sponsorshipPolicyId":"sp_..."}` to each chain.
- Pimlico's `paymasterData` carries a `validUntil`. If the user takes too long between `vault_prepareDeployment` (or `vault_prepareTransaction`) and signing, the send fails (an AA3x bundler error, `SPONSORSHIP_REJECTED` to the app); retrying prepares a new operation. A transaction prepared more than 10 minutes earlier is refused by the vault itself (`TRANSACTION_EXPIRED`).
- With `"sponsorTransactions":true`, every user can have the paymaster pay for any call from their Safe. Use a sponsorship policy with per-user and global spend limits sized to the budget you accept to lose, and fund the account accordingly; remove `sponsorTransactions` from a chain to have its Safes pay for their own transactions. A policy that is inactive or out of budget reaches the app as `SPONSORSHIP_REJECTED`.

The `rpcUrl` of `DEMO_CHAINS` is signed into the handoff token, which the browser can read, and the demo also uses it server-side for ERC-1271 checks: it must never carry an API key. A keyed RPC belongs only in `AA_CHAINS[chainId].rpcUrl`, which never leaves the vault server. Keyless public RPCs are rate-limited on a fair-use basis: fine for a demo, not for real traffic.

### Smoke tests

After the first deployment of both projects:

- `curl -s V/api/health` returns `{"status":"ok"}`, and the vault's Neon database has `schema_migrations` rows 1 to 7.
- `curl -sI V/` shows `Content-Security-Policy` with a nonce, `Strict-Transport-Security` and `X-Frame-Options: DENY`; a worker chunk under `V/_next/static/` has the worker CSP.
- `curl -sI V/recovery-tool` returns `200` with `Content-Disposition: attachment; filename="wl-embedded-wallet-recovery.html"`, not `404` "Tool not available in this deployment.", and the downloaded file matches [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md). Together with the next check, this confirms the assumption that `process.cwd()` inside a function is the app directory.
- Pages render the WL brand, and the `/brand/<hash>.css` they link returns `200`.
- `curl -s D/.well-known/jwks.json` lists one OKP (Ed25519) key with no `d`.
- The runtime logs of both projects show no `Invalid configuration`, no `Cannot prepare the DATABASE_URL database` and no `pg` `SECURITY WARNING`. A startup issue naming `CLIENT_IP_SOURCE` and "not a Vercel runtime" means `VERCEL_REGION` is missing: check that system variables are exposed.
- Eleven `POST V/api/recovery/passkey/challenge` with `Origin: V` from one machine: the eleventh is `429`, and still `429` with forged `X-Forwarded-For` or `X-Real-IP` headers. Likewise the eleventh `POST D/api/auth/register` with `Origin: D` is `429`.
- In Chrome, Safari and Firefox on the real domains: register on the demo, set up TOTP, open the wallet, create the passkey (the prompt names the vault's host), download the tool and the kit, deploy the Safe on each testnet (sponsored), sign a message and have the demo verify it, send a 0-value transaction from the Transaction tab to another address (sponsored: the Safe's balance does not change) and follow its explorer link, log out and in, unlock with the passkey, and follow the explorer links.

### Vercel Firewall

The vault's own limits remain the real control, but on a public deployment add Vercel Firewall rules as a first layer: a rate limit on the demo's `/api/auth/*` (for example 20 requests a minute per IP: each attempt runs scrypt) and a coarser one on the vault's `/api/*`. Rate-limit rules depend on the Vercel plan.

## Local development

Requirements: Node 22.13 or later (the vault uses `node:sqlite`), pnpm 10, [Foundry](https://getfoundry.sh/) (`anvil`) for the local chains, Docker only for the Postgres and image test suites, and Chrome or Chromium. `*.localhost` names resolve natively in Chromium; in other browsers add `127.0.0.1 app.localhost vault.localhost` to `/etc/hosts`.

```bash
pnpm install
pnpm setup:env     # writes apps/vault/.env.local and examples/demo/.env.local
pnpm aa:stack      # terminal 1: local chains with the real Safe and EntryPoint contracts
pnpm dev           # terminal 2: the vault and the demo
```

Then open `http://app.localhost:3200`.

| Service | Address | Source |
|---|---|---|
| Demo app | `http://app.localhost:3200` | `examples/demo/package.json` (`next dev -p 3200`) |
| Vault | `http://vault.localhost:3201` | `apps/vault/package.json` (`next dev -p 3201`) |
| Local chain 31001 | RPC `http://127.0.0.1:21545`, bundler `:22545`, paymaster `:23545`; also sponsors transactions | `apps/vault/tests/aa-stack/run.mjs` |
| Local chain 31002 | RPC `http://127.0.0.1:21546`, bundler `:22546`, paymaster `:23546`; the Safe pays for its transactions | Same |
| Local chain 31003 | RPC `http://127.0.0.1:21547`, no contracts, no bundler or paymaster (the vault must reject it as `CHAIN_NOT_SUPPORTED`) | Same |

The AA stack runs `anvil` per chain, with the bundler on the RPC port + 1000 and the paymaster on the RPC port + 2000 (`apps/vault/tests/aa-stack/stack.mjs`). It prints matching `AA_CHAINS`, `RPC_ALLOWED_HOSTS` and `DEMO_CHAINS` values.

`pnpm setup:env` (`scripts/setup-env.mjs`) generates both `.env.local` files with mutually consistent keys (the demo's handoff key and `kid`, the shared `VAULT_SERVICE_TOKEN`, origins, `AA_CHAINS` for the local stack, `RPC_ALLOWED_HOSTS=127.0.0.1`, `DATABASE_URL=sqlite:data/vault.db`, `ALLOW_INSECURE_LOCAL=1` and `VAULT_BRAND_DIR=../../brands/example`). It writes the files with mode `0600` and never prints a secret. If the files already exist it only adds missing variables and never regenerates a key; `--force` regenerates everything, after which existing local data can no longer be decrypted.

`pnpm dev` does not apply the vault's CSP, because Next.js needs `eval` in development. To test it, build and run the production output: `pnpm --filter ./apps/vault build` then `pnpm --filter ./apps/vault start` (`scripts/start-standalone.mjs` copies the static assets and starts `node --require peer-address.cjs server.js` on port 3201 by default). That runs with `NODE_ENV=production`, which is why the generated environment sets `ALLOW_INSECURE_LOCAL=1`.

Tests and their ports: [TESTING.md](TESTING.md).

## Production checklist

Release 0.1.0 is a reference implementation for review, not a production service. Before holding real funds, at least:

- [ ] **Real KMS or HSM.** `MASTER_KEY` sits in the process environment and `server/kms.ts` only simulates a KMS. Share A also travels to the server in plaintext (over TLS) at enrollment; it should be encrypted client-side to the KMS.
- [ ] **Rate limits reviewed.** Set [`TRUSTED_PROXIES`](#client-addresses-behind-a-proxy) to your proxy (or `CLIENT_IP_SOURCE=vercel` on Vercel) and check, from the logs or a test request, that clients are not all counted as the proxy. Tune [`RATE_LIMITS`](#rate-limits) for your traffic; the defaults are untested under load. Keep limiting floods at the proxy too.
- [ ] **Sponsorship limits** set per chain in `AA_CHAINS["<chainId>"].limits` for every L2, and sized against your paymaster budget ([Sponsorship limits](#sponsorship-limits)). Where `sponsorTransactions` is on, spend limits set in the paymaster's policy as well ([Transaction sponsorship](#transaction-sponsorship)).
- [ ] **Image command unchanged**, or still loading the `peer-address.cjs` preload (on Vercel, `CLIENT_IP_SOURCE=vercel` instead).
- [ ] **TLS hardening** at the proxy. The vault sends `Strict-Transport-Security: max-age=31536000` with an `https` `ORIGIN`; add `includeSubDomains` or `preload` at the proxy if you want them.
- [ ] **Final domain and `RP_ID`** chosen before the first user, and the [static recovery page](#static-recovery-page) deployed on a subdomain from day one.
- [ ] **Backups** of the database and of both keys, stored separately, with a tested restore procedure.
- [ ] **Recovery tool hash** published outside the vault's domain, and `/recovery-tool` checked after every deploy.
- [ ] **`ALLOWED_APP_ORIGINS`** set if only known apps may use the vault.
- [ ] **`ALLOW_INSECURE_LOCAL` unset** and `DATABASE_URL` pointing at Postgres.
- [ ] **`VAULT_SERVICE_TOKEN`** only in your backend, and the `/api/s2s/*` route ideally not reachable from the internet.
- [ ] **Observability and alerting** beyond stdout logs and `/api/health`.
- [ ] **External audit** of the key handling and the dependencies (WDK is still in beta; `node:sqlite`, used outside production, is experimental). See [AUDIT-SCOPE.md](AUDIT-SCOPE.md).
- [ ] **Real passkeys and browsers.** Real authenticators, Safari and Firefox are untested. See [TEST-STATUS.md](TEST-STATUS.md).

Open items and plans are in [ROADMAP.md](ROADMAP.md); the reasoning behind these choices is in [DECISIONS.md](DECISIONS.md).
