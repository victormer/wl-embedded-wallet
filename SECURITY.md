# Security policy

WL Embedded Wallet handles wallet key material. We take every report seriously and ask that vulnerabilities be disclosed privately first.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Earlier | No (there are no earlier releases) |

Version 0.1.0 is the initial release and has **not** been audited. It is not ready to hold real funds; see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md#accepted-risks).

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

- <https://github.com/victormer/wl-embedded-wallet/security/advisories/new> (the **Report a vulnerability** button under the repository's **Security** tab).

Please include:

- the affected component and version or commit (for example `packages/core/src/signer.ts` at a given commit);
- a description of the issue and its impact (which asset is exposed: seed, shares, PRF output, recovery code, session, sponsorship budget, ...);
- steps to reproduce or a proof of concept, using test keys and local chains only;
- whether you believe it is one of the [accepted risks](docs/THREAT-MODEL.md#accepted-risks) or a [known weakness](docs/THREAT-MODEL.md#known-weaknesses-noted-for-the-audit), and why it goes beyond what is documented.

What to expect:

- an acknowledgement of your report;
- an assessment and, if confirmed, a fix and a coordinated disclosure date agreed with you;
- credit in the release notes if you wish.

This project is maintained on a best-effort basis. We aim to acknowledge reports promptly and to keep reporters informed as we assess and fix them, but we cannot guarantee response or fix times, and there is no SLA.

Never use real user funds, real user data or third-party infrastructure (public bundlers, paymasters, RPC providers) when testing. The repository includes a local stack for this (`pnpm aa:stack`, see [docs/TESTING.md](docs/TESTING.md)).

## Scope

In scope: the code in this repository, primarily `packages/core`, `apps/vault`, `packages/sdk` and `packages/recovery-tool`. The proposed audit scope, its priorities and the critical dependencies are in [docs/AUDIT-SCOPE.md](docs/AUDIT-SCOPE.md); the security goals, trust assumptions and accepted risks in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

Out of scope: the sample app `examples/demo`, the local test stack `apps/vault/tests/aa-stack`, the example configurations in `deploy/`, and third-party services and contracts. Vulnerabilities in dependencies (for example WDK packages) should be reported to their maintainers; tell us as well if they affect this project.

## For operators

A deployment's security depends on its configuration. Before running the vault, read the [production checklist](docs/DEPLOYMENT.md#production-checklist): in particular, there is no real KMS yet, the built-in rate limits need `TRUSTED_PROXIES` behind a reverse proxy (or `CLIENT_IP_SOURCE=vercel` on Vercel), and the recovery tool's published hash ([docs/REPRODUCIBLE-BUILDS.md](docs/REPRODUCIBLE-BUILDS.md)) should be republished outside the vault's domain.
