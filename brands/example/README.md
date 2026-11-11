# Example brand: Acme Wallet

"Acme Wallet" is a **fictional** brand. It exists to show every kind of field `brand.json` accepts and to give the
development environment, the demo app and the test suites a non-neutral brand. It is not a real product and does
not represent any company.

## Files

| File | Purpose |
|---|---|
| `brand.json` | Brand tokens: name, light and dark palettes (indigo accent `#4F46E5` / `#818CF8` on slate neutrals), radius 12, the Inter font files, logo, favicon and a support link |
| `logo.svg` | Wordmark shown in the vault header (one logo for both color schemes) |
| `favicon.svg` | Browser tab icon |
| `fonts/Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2`, `Inter-Bold.woff2` | Self-hosted Inter, weights 400, 500, 600 and 700 |
| `fonts/NOTICE.txt` | Copyright and license notice for the Inter fonts |

## Mounting it

The vault reads a brand directory at startup from `VAULT_BRAND_DIR`. Mount this directory (or your own, with the
same layout) read-only:

```bash
docker run ... -e VAULT_BRAND_DIR=/brand --volume "$PWD/brands/example:/brand:ro" wl-embedded-wallet-vault:local
```

With `compose.yaml`, uncomment the `volumes` entry of the `vault` service (`./brands/example:/brand:ro`) and set
`VAULT_BRAND_DIR=/brand` in `.env`. In local development, `apps/vault/.env.example` points
`VAULT_BRAND_DIR` at `../../brands/wl`; the e2e suites mount this example brand.

Restart the vault after any change; the brand is read once per process. In production an invalid brand stops
the vault from starting.

The demo app (`examples/demo`) does not use this directory: it imports its logo, favicon and fonts from
`brands/wl` at build time.

## Making your own

Copy this directory, replace the files and edit `brand.json`. The schema, limits and validation rules (contrast,
accent hue, SVG rules, file sizes) are in [`docs/BRANDING.md`](../../docs/BRANDING.md).

## Font license

The Inter fonts are copyright The Inter Project Authors and are licensed under the SIL Open Font License,
Version 1.1. See [`fonts/NOTICE.txt`](fonts/NOTICE.txt).
