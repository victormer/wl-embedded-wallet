# Roadmap

Goal: a self-hosted vault that any integrator deploys with its own database, domain and API to offer its own embedded, non-custodial wallet built on WDK.

Related documents: [README.md](../README.md), [DECISIONS.md](DECISIONS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [THREAT-MODEL.md](THREAT-MODEL.md), [AUDIT-SCOPE.md](AUDIT-SCOPE.md), [DEPLOYMENT.md](DEPLOYMENT.md), [TEST-STATUS.md](TEST-STATUS.md).

## Delivered in 0.1.0

- Vault service (`apps/vault`) and sample integrator app (`examples/demo`), with the core (`@wl-embedded-wallet/core`), the SDK (`@wl-embedded-wallet/sdk`) and the offline recovery tool (`packages/recovery-tool`).
- 2-of-3 Shamir split of the seed (A on the server, B behind a passkey PRF, C behind the recovery code), with an emergency kit that also carries an encrypted seed backup.
- A multichain Safe 4337 as the user's account, deployed through a bundler and an optional paymaster behind the vault proxy.
- Signing of messages (ERC-1271), EIP-712 typed data and UserOperations (signed, not submitted).
- Recovery without a kit (discoverable passkey + code), operation with B+C or kit + code without the server, static recovery page, and relinking a wallet to a new account.
- Postgres via `DATABASE_URL` (SQLite for development), integrator authentication by fixed public key or JWKS, and multiple apps per vault through the signed `origin` claim.
- Generic Docker image with runtime configuration, per-deployment branding mounted at runtime, and operator documentation ([DEPLOYMENT.md](DEPLOYMENT.md), [BRANDING.md](BRANDING.md)).
- Reproducible build of the offline tool ([REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md)).

## Next phases

1. **Sending:** submit regular UserOperations, extending the proxy policy, which today only admits the Safe deployment, built by the server. Rate limits tuned per deployment from real traffic.
2. **Configurable:** pluggable KMS instead of `MASTER_KEY`, and gas sponsorship policies.
3. **Release:** external security audit, published images and packages, and published recovery artifacts (see "Pending before a public release").

## Design decisions

- **One deployment per integrator:** each with its own `MASTER_KEY`, RP ID and database. This avoids mixing keys and domains across integrators.
- **The API does not sign:** the seed is only reconstructed in the user's browser. The API covers accounts, policies and management. Every signature goes through the popup and the passkey.
- **The domain is nearly irreversible:** passkeys are bound to the RP ID. Changing it makes share B unusable for every user, who would have to re-enroll with A+C. If the domain is lost, B stops working and only kit + code remain. This must be treated as an installation-time decision (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- **Bundler and paymaster behind a proxy:** API keys must never reach the browser. The vault forwards to the configured URL using ERC-7677, and only operations of the session's Safe: never an open relay.
- **The same address on every EVM network:** a product invariant. It depends only on the owner and on init parameters signed into each user's manifest. A network where the factory would not yield exactly that address (for example zkSync, which derives CREATE2 differently) is not supported.
- **Changing the owner does not propagate across networks:** if it is changed on one network, the others do not know, and on networks where the Safe is not yet deployed it is always deployed with the original owner. If the key is compromised, changing the owner is not enough: the attacker could deploy the Safe on another network with the stolen key and use whatever arrives at that address. A compromised key must be treated as compromised on every network.
- **Changing the module version is a migration:** it is done within the same Safe, not by creating another one, because a different version would produce a different address.
- **Rotation does not revoke what lives outside the server:** whoever keeps the old kit and the old code can still reconstruct the seed, without a passkey if the kit carries the backup, because none of this consults the server. Rotation protects against losing a factor, not against theft. If theft is suspected, the user must create another wallet and move the funds.
- **Kit + code already yield the seed:** since kit `v: 2`, with no passkey or server, and by default. This is what allows surviving the disappearance of the backend. The kit and the code must be stored separately.
- **RPC per operation:** the network and its RPC are signed by the integrator's backend. RPCs with an API key go in `AA_CHAINS`, because the token passes through the browser.
- **Runtime configuration:** the RP ID and the manifest public key are delivered in the HTML, so that the same image can serve any integrator. See [DECISIONS.md, "Deployment"](DECISIONS.md#deployment).
- **Safe startup:** no default values for keys. If configuration is missing, the app does not start.
- **2FA belongs to the app:** the vault trusts the token from the app's backend to deliver share A, and cannot verify that 2FA took place. Whoever compromises the backend, its signing key, its JWKS or a live token obtains A. Combined with the user's recovery code, that yields the seed, so the code cannot be shortened.
- **Multiple apps, one wallet:** the domain is authorized by the signed `origin` claim, and the wallet is bound to `sub` within the single `HANDOFF_ISSUER`. A compromise in any app affects the shared wallet. A message signature made in one app can be replayed in another if the message does not include a domain, so apps must use SIWE or EIP-712 with a domain.

## Pending before a public release

- Per-origin user consent the first time an app uses the wallet.
- One key (`kid`) per app, bound to its origin, so a single app can be revoked.
- Rate limiting on token redemption, the proxy and the demo login. There is none today, and the demo's TOTP step can be brute-forced for as long as the intermediate session lasts.
- Rate limiting on WebAuthn challenges and relink nonces, which do not require a session or can be requested without limit. Expired rows are purged, but they occupy rows until then.
- Notify the user on every delivery of share A. This is how the use of a stolen token would be detected, since the vault no longer asks for a second factor of its own.
- Notify the user when their wallet is relinked to another account. Today this is only recorded in the server's audit trail.
- Pluggable KMS instead of `MASTER_KEY` (`apps/vault/server/kms.ts` currently simulates a KMS/HSM with a local key).
- Publish the static recovery page and the hash of the offline tool with every release, outside the vault's domain.
- On-chain recovery (second owner, guardians): the only way to survive theft of the kit and code together without moving the funds in time.
- Publish the image, `linux/amd64` included, and the SDK packages on npm.
- Ship the Apache-2.0 `LICENSE` file (compatible with WDK); today the license is only declared in `package.json`.
- External security audit. Publishing a key management system without one is a risk for whoever deploys it. See [AUDIT-SCOPE.md](AUDIT-SCOPE.md).

## Known constraints

- The WDK dependencies are in beta and do not guarantee compatibility between versions.
