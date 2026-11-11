# WL Embedded Wallet brand

This is the brand of the project's public demo: **WL Embedded Wallet**, an independent, open-source embedded wallet.
It themes the vault popup with tokens only (palettes, radius, typeface, logo, favicon and a support link). The
"WL" mark and the wordmark are original artwork made for this project; there are no third-party logos in this
directory.

For a fictional brand that shows every field `brand.json` accepts, see [`../example`](../example).

## Files

| File | Purpose |
|---|---|
| `brand.json` | Brand tokens: name, light and dark palettes (graphite/cream inverse primary accent, ink blue `#2E4BFF` / `#8494FF` for links and focus), radius 4, the Inter Tight font files, light and dark logos, favicon and a support link |
| `logo-light.svg` | Lockup for light grounds: black tile with the "WL" mark and the "Embedded Wallet" wordmark in `#0F1115` (317 x 64; the vault shows it 24 px high, about 119 px wide) |
| `logo-dark.svg` | Lockup for dark grounds: same artwork with a lifted tile (`#1B1B1D`), a hairline edge and the wordmark in `#F4F3EF` |
| `favicon.svg` | 64 x 64 mark with slightly heavier strokes for 16 px; in a dark color scheme it adds a hairline edge so the tile does not vanish on a dark tab bar |
| `fonts/InterTight-Regular.woff2`, `InterTight-Medium.woff2`, `InterTight-SemiBold.woff2`, `InterTight-Bold.woff2` | Self-hosted Inter Tight, weights 400, 500, 600 and 700 (used by the vault) |
| `fonts/JetBrainsMono-Regular.woff2`, `JetBrainsMono-Medium.woff2` | JetBrains Mono, weights 400 and 500, for the demo app only (the vault's monospace stack is fixed) |
| `fonts/OFL.txt` | SIL Open Font License 1.1, with the copyright lines of both families |
| `fonts/NOTICE.txt` | Copyright, source (repository and commit) and modifications of the font files |

The wordmark in the lockups is outlined to paths (Inter Tight SemiBold, 30 px, tracking -0.4, kerned): the vault
loads the logo as an `<img>`, which cannot use web fonts. The SVGs contain no `<text>`, scripts, handlers,
entities, `<foreignObject>` or external references (only `url(#id)`), and each file uses its own gradient id.

## Mounting it

The vault reads a brand directory at startup from `VAULT_BRAND_DIR`. In local development, set it relative to
`apps/vault`:

```bash
VAULT_BRAND_DIR=../../brands/wl
```

In a container, mount this directory read-only and point `VAULT_BRAND_DIR` at the mount:

```bash
docker run ... -e VAULT_BRAND_DIR=/brand --volume "$PWD/brands/wl:/brand:ro" wl-embedded-wallet-vault:local
```

Restart the vault after any change; the brand is read once per process. In production an invalid brand stops
the vault from starting. The schema, limits and validation rules are in
[`docs/BRANDING.md`](../../docs/BRANDING.md).

## Contrast

Computed with the vault's own formula (`contrastRatio` in `apps/vault/server/brand.ts`, WCAG 2.x). Every pair
the loader checks must be at least 4.5:1.

| Pair | Light | Dark |
|---|---|---|
| text / background | 17.02 | 17.72 |
| text / surface | 18.90 | 16.58 |
| muted / background | 5.76 | 7.80 |
| muted / surface | 6.40 | 7.30 |
| accentText / accent | 14.68 | 15.91 |
| accentInk / background | 5.30 | 7.18 |
| accentInk / surface | 5.89 | 6.72 |

Neither accent is close to the danger or caution hues (`signalClash` returns nothing for the accents or the
inks). The accent differs from the text color on purpose, so the derived hover color stays visible.

## Font license

Inter Tight is copyright 2022 The Inter Project Authors and JetBrains Mono is copyright 2020 The JetBrains Mono
Project Authors. Both are licensed under the SIL Open Font License, Version 1.1 (see [`fonts/OFL.txt`](fonts/OFL.txt)).
The files are static WOFF2 instances subset from the variable builds in the Google Fonts repository; the exact
source commit and the changes are listed in [`fonts/NOTICE.txt`](fonts/NOTICE.txt). Neither family declares a
Reserved Font Name, so the original names are kept. Outlining glyphs into the logo artwork is permitted by the OFL.
