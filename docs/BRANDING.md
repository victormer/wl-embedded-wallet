# Branding

Each deployment of the vault can carry its own brand **without rebuilding the image**. A brand is a directory
with a `brand.json` file and the files it references (logo, favicon, fonts), mounted into the container and
selected with the `VAULT_BRAND_DIR` environment variable. Without it, the vault uses its neutral default brand,
"Vault".

A brand is a set of **tokens only**: a name, eight colors per color scheme, a corner radius, a typeface, a logo,
a favicon and three links. It is never CSS, markup or flow text. The security notices, their color scale, the
flow and its texts are fixed and cannot be changed, hidden or imitated by a brand (see
[What a brand cannot change](#what-a-brand-cannot-change)).

This document describes the behavior of the code in `apps/vault/server/brand.ts` (loading and validation),
`apps/vault/app/brand/[file]/route.ts` (serving), `apps/vault/app/_components/brand.tsx` (header and footer),
`apps/vault/app/layout.tsx` (where the brand is applied), `apps/vault/server/startup.ts` (startup checks) and
`apps/vault/scripts/build-static-recovery.mjs` with `apps/vault/static-recovery/brand-build.tsx` (static
recovery page). The visual system the tokens plug into is described in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

Related documents: [DEPLOYMENT.md](DEPLOYMENT.md) (all environment variables), [RECOVERY.md](RECOVERY.md)
(static recovery page and offline tool), [THREAT-MODEL.md](THREAT-MODEL.md), [TESTING.md](TESTING.md),
[TEST-STATUS.md](TEST-STATUS.md).

## Contents

- [Mounting a brand](#mounting-a-brand)
- [`brand.json` reference](#brandjson-reference)
- [Limits](#limits)
- [Validation](#validation)
- [How the brand is applied and served](#how-the-brand-is-applied-and-served)
- [What a brand cannot change](#what-a-brand-cannot-change)
- [Static recovery page](#static-recovery-page)
- [Offline recovery tool](#offline-recovery-tool)
- [Example brand: Acme Wallet](#example-brand-acme-wallet)
- [The demo app](#the-demo-app)
- [Tests](#tests)
- [Known limitations](#known-limitations)

## Mounting a brand

| Variable | Required | Meaning |
|---|---|---|
| `VAULT_BRAND_DIR` | No | Path to the brand directory, which must contain `brand.json`. Leading and trailing whitespace is trimmed; empty or unset means the neutral brand. A relative path is resolved against the process working directory. |
| `VAULT_BRAND_NAME` | No | Name shown in the UI and used as the passkey relying-party name. Overrides `name` in `brand.json`. Validated at startup: at most 64 characters, no control characters. |

The brand is read **once per process**. Changing it requires restarting the container, not rebuilding the image.

### Docker

The image does not contain any brand (`brands` is listed in `.dockerignore`). Mount the directory read-only and
point `VAULT_BRAND_DIR` at the mount point:

```bash
docker run -d --name vault --restart unless-stopped --init \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file .env -e VAULT_BRAND_DIR=/brand \
  --volume "$PWD/my-brand:/brand:ro" \
  -p 127.0.0.1:3000:3000 wl-embedded-wallet-vault:local
```

### Compose

`compose.yaml` passes `VAULT_BRAND_DIR` and `VAULT_BRAND_NAME` through from `.env` and contains a commented-out
volume for the `vault` service. Uncomment it and set `VAULT_BRAND_DIR=/brand` in `.env`:

```yaml
    volumes:
      - ./brands/example:/brand:ro
```

`e2e/compose.image.yaml` does exactly this for `pnpm test:e2e:image`.

### Local development

`apps/vault/.env.example` (and the `apps/vault/.env.local` that `pnpm setup:env` generates) sets
`VAULT_BRAND_DIR=../../brands/example`, relative to `apps/vault`, so the development vault uses the fictional
example brand. Remove the variable to see the neutral brand.

### Name precedence

| What | First | Then | Default |
|---|---|---|---|
| Name | `VAULT_BRAND_NAME` (trimmed, if not empty) | `name` in `brand.json` | `Vault` |
| Everything else | `brand.json` in `VAULT_BRAND_DIR` | | Neutral brand |

The name appears in the brand header (visible text, or screen-reader-only text when a logo is present), the
page `<title>`, the meta description (`"<name>: your wallet keys."`), the footer navigation label, the
`data-brand` attribute of the runtime configuration element, and as `rp.name` when a passkey is created
(`apps/vault/lib/prf.ts`). Changing the name later does not affect passkeys that were already created; the
relying-party ID (`RP_ID`) is what binds them, not the name.

## `brand.json` reference

A complete example is in [`brands/example/brand.json`](../brands/example/brand.json). Every key except
`version` is optional. Unknown keys are errors, not ignored.

```json
{
  "version": 1,
  "name": "Acme Wallet",
  "colors": {
    "light": { "background": "#F8FAFC", "surface": "#FFFFFF", "text": "#0F172A", "muted": "#64748B",
               "border": "#E2E8F0", "accent": "#4F46E5", "accentText": "#FFFFFF" },
    "dark":  { "background": "#0F172A", "surface": "#1E293B", "text": "#F8FAFC", "muted": "#94A3B8",
               "border": "#334155", "accent": "#818CF8", "accentText": "#0F172A" }
  },
  "radius": 12,
  "font": {
    "family": "Inter",
    "files": [
      { "path": "fonts/Inter-Regular.woff2", "weight": 400 },
      { "path": "fonts/Inter-Bold.woff2", "weight": 700 }
    ]
  },
  "logo": { "light": "logo.svg", "dark": "logo-dark.svg" },
  "favicon": "favicon.svg",
  "links": {
    "support": "https://example.com/support",
    "privacy": "https://example.com/privacy",
    "terms": "https://example.com/terms"
  }
}
```

### Top-level keys

| Key | Required | Type | Rules |
|---|---|---|---|
| `$schema` | No | any | Accepted and ignored. No JSON Schema file ships with the repository. |
| `version` | **Yes** | number | Must be exactly `1`. |
| `name` | No | string | Trimmed. Must be non-empty after trimming, at most 64 characters, with no control characters (Unicode category `Cc`). |
| `colors` | No | object | Only the keys `light` and `dark`. See [Colors](#colors). |
| `radius` | No | integer | Pixels, from 0 to 20. Default 10. |
| `font` | No | object | `family` and `files`. See [Font](#font). Without it, the system font stack is used. |
| `logo` | No | string or object | A path, or `{ "light": path, "dark": path }` with `dark` optional. |
| `favicon` | No | string | A path. |
| `links` | No | object | Only `support`, `privacy` and `terms`. See [Links](#links). |

### Colors

`colors.light` and `colors.dark` each accept any subset of the eight tokens below. Every value must be a
`#RRGGBB` hex color (six digits; `#fff`, named colors or anything else is rejected). Values are lowercased.
Missing tokens come from the neutral brand.

| Token | CSS variable | Used for | Neutral light | Neutral dark |
|---|---|---|---|---|
| `background` | `--bg` | Page background behind the card | `#f3f4f6` | `#121418` |
| `surface` | `--surface` | Card, editable fields, secondary button, current tab | `#ffffff` | `#1b1e24` |
| `text` | `--text` | Main text, text of neutral notices | `#15181e` | `#eceef2` |
| `muted` | `--muted` | Labels, secondary text, pending steps, info icon, spinner | `#575d69` | `#a3a9b5` |
| `border` | `--border` | Card border, panel separator, pending step bar | `#d9dce2` | `#30353e` |
| `accent` | `--accent` | Fill of the primary button, checkbox `accent-color`, text selection tint | `#2f3d55` | `#b4c2dc` |
| `accentText` | `--accent-text` | Text on the primary button | `#ffffff` | `#121418` |
| `accentInk` | `--accent-ink` | The accent as text or a thin stroke: links, focus ring, focused field border | `#2f3d55` | `#b4c2dc` |

Derivation rules, applied in this order (`parseColors` in `server/brand.ts`):

1. **No dark accent.** If `colors.dark.accent` is missing and `colors.light.accent` is present, the dark scheme
   uses the light accent. The rest of the dark palette is the neutral one unless given.
2. **`accentText`.** If a scheme sets its own `accent` (including one copied by rule 1) but not `accentText`,
   `accentText` becomes whichever of `#ffffff`, the scheme's `text` and `#000000` has the highest contrast with
   the accent.
3. **`accentInk`.** If a scheme does not set `accentInk`, it is derived from the accent: the accent itself if it
   already reaches 4.5:1 against both `background` and `surface`; otherwise the first mix of the accent toward
   black or white (in 2% steps, trying black first at each step) that does. If no mix reaches 4.5:1 on both
   grounds, that is an error on `colors.<scheme>.accent`. This is the typical case of a bright orange accent,
   usable as a button fill with dark text but unreadable as text on white.

Other colors used by the UI (`--surface-2`, `--ground-2`, `--line-strong`, `--accent-hover`, `--radius-inner`)
are derived in `apps/vault/app/globals.css` with `color-mix()` and `calc()` from the brand tokens; they cannot be
set directly. See [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md#colors).

### Radius

An integer number of pixels from 0 to 20 (default 10). Buttons and the tab track use it as is, the card uses
`radius + 4px`, and nested elements (fields, read-only values, notices, tabs) use `max(0px, radius - 3px)`.

### Font

```json
"font": { "family": "Brand Sans", "files": [ { "path": "fonts/regular.woff2", "weight": 400, "style": "normal" } ] }
```

| Field | Rules |
|---|---|
| `family` | 1 to 64 characters, matching `^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$`: letters, digits, spaces and hyphens, starting with a letter or digit. |
| `files` | A list of 1 to 8 entries. Fonts are always self-hosted: a `font` without `files` (for example, intending a CDN) is an error. |
| `files[].path` | A path to a `.woff2`, `.woff`, `.ttf` or `.otf` file. See [Files](#files). |
| `files[].weight` | Optional, default 400. An integer from 100 to 900 in steps of 100. |
| `files[].style` | Optional, default `normal`. `normal` or `italic`. |

Each file becomes an `@font-face` rule with `font-display: swap`, and the family is prepended to the system
stack: `--font-sans: "<family>", ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial,
sans-serif`. The monospace stack is fixed and cannot be changed by a brand.

### Logo

Either a path (used in both schemes) or `{ "light": path, "dark": path }`, where `dark` is optional. Allowed
types: `.svg`, `.png`, `.webp`. The logo is rendered as an `<img>` inside a `<picture>`, with a
`<source media="(prefers-color-scheme: dark)">` when a dark logo is given, at 24 px high and at most 200 px wide
(`object-fit: contain`). The `<img>` has an empty `alt`; the brand name stays in the DOM for screen readers.
Without a logo, the name is shown as text.

### Favicon

A path to a `.svg`, `.png` or `.ico` file. It is declared through Next.js metadata as
`<link rel="icon" type="<content type>">`.

### Links

`support`, `privacy` and `terms`, shown in the footer as "Help", "Privacy" and "Terms" (in that order). Each
value must be:

- a string of at most 2048 characters;
- an absolute URL;
- without a username or password;
- `https:`. `http:` is accepted only for `localhost`, `127.0.0.1`, `[::1]` or a `*.localhost` host, and only
  when insecure local mode applies (outside `NODE_ENV=production`, or with `ALLOW_INSECURE_LOCAL=1`). The static
  recovery page build never accepts `http:` links.

Values are normalized with `new URL(value).href`. The links open in a new tab with
`rel="noopener noreferrer"`. The footer is omitted when no link is set.

### Files

Every path in `brand.json` (logo, favicon, fonts) is checked when the brand is loaded:

- It must be a string of at most 128 characters matching
  `^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$`. Each segment starts with a letter, digit,
  `_` or `-`, so there are no `..` segments, no hidden files, no absolute paths and no backslashes.
- Its extension (case-insensitive) must be allowed for that kind of file.
- It is resolved with `realpath`. The result must be inside the real path of the brand directory: a symbolic
  link that stays inside the directory is accepted, one that points outside is rejected.
- It must be a regular file, within the per-kind size limit and within the total limit.
- Its content must match its extension (magic bytes; see [Validation](#validation)). SVG files are additionally
  checked as text.

## Limits

All values come from `apps/vault/server/brand.ts`. Sizes are in binary units (1 KB = 1024 bytes in the error
messages). A file exactly at the limit is accepted.

| Limit | Value |
|---|---|
| `brand.json` size | 64 KB (65,536 bytes) |
| Total size of all referenced files | 4 MB (4,194,304 bytes). `brand.json` is not counted. A file referenced twice counts twice. |
| Logo file (each of `light` and `dark`) | 256 KB; `.svg`, `.png`, `.webp` |
| Favicon file | 64 KB; `.svg`, `.png`, `.ico` |
| Font file (each) | 512 KB; `.woff2`, `.woff`, `.ttf`, `.otf` |
| Number of font files | 1 to 8 |
| Path length | 128 characters |
| Link URL length | 2048 characters |
| `name` / `VAULT_BRAND_NAME` length | 64 characters |
| `font.family` length | 64 characters |
| `radius` | Integer, 0 to 20 px |
| Font `weight` | 100 to 900, multiples of 100 |
| Minimum contrast | 4.5:1 (WCAG 2.x AA for normal text) |
| Signal hue margins | Danger 0° ± 12°, caution 50° ± 10° (accent only) |

## Validation

Validation runs at startup together with the environment variables (`server/startup.ts`). All issues are
collected and reported at once, one line per issue, naming the field and never a secret (a brand has none):

```
Invalid configuration: brand.json:colors.light.muted contrast 2.54:1 on surface (#9aa59f on #ffffff); the minimum is 4.5:1
Invalid configuration: brand.json:css unsupported key. brand.json only accepts tokens: no CSS, no markup, no flow text
Invalid configuration: brand.json:logo points outside the brand directory
Invalid configuration: VAULT_BRAND_DIR is not an accessible directory
```

The field is `brand.json:<path>` for issues inside the file, `brand.json` for the file as a whole (missing, not
valid JSON, not an object, too large) and `VAULT_BRAND_DIR` when the directory cannot be read.

**Effect of an invalid brand.** A brand is never applied partially:

- With `NODE_ENV=production` (the Docker image), any issue makes the process exit with status 1 before it accepts
  requests.
- Outside production, the issues are logged and the vault runs with the neutral brand (the
  `VAULT_BRAND_NAME` override still applies).

### Contrast

For each scheme, after the derivation rules above, these seven pairs must reach at least 4.5:1 (WCAG 2.x
relative luminance and contrast ratio, computed in `contrastRatio`):

| Foreground | Background |
|---|---|
| `text` | `background` |
| `text` | `surface` |
| `muted` | `background` |
| `muted` | `surface` |
| `accentText` | `accent` |
| `accentInk` | `background` |
| `accentInk` | `surface` |

A pair below the minimum is an error, reported on the foreground token. Only `accentText` and `accentInk` are
ever derived, and only when they are missing; a color the operator chose explicitly is never changed silently.
An explicit `accentInk` must also pass. The reported ratio is truncated (not rounded) to two decimals.

### Accent versus security signals

The security notices use a fixed scale (see [What a brand cannot change](#what-a-brand-cannot-change)). To keep
the primary button from reading as a warning, or a warning from reading as the brand, the `accent` of each
scheme is rejected when it is saturated and its hue is too close to a signal hue (`signalClash`):

- The accent is converted to HSL. If saturation < 0.4, or lightness < 0.15 or > 0.9, it is never rejected
  (greys, very dark and very light colors are not mistaken for a signal).
- Otherwise it is rejected if its hue is less than 12° from **danger** (red, 0°) or less than 10° from
  **caution** (yellow, 50°), measured around the color wheel.
- **Success** (green) is not protected: a green brand hides no warning.

The error names the hue, the color and the signal, for example:
`brand.json:colors.light.accent hue 0° (#d92626) too close to the danger hue; security warnings have their own
scale and the accent must not be confused with it`.

Only `accent` is checked this way. `accentInk` is derived from the accent's hue, but an explicit `accentInk`, and
the other tokens (`background`, `surface`, `border`, ...), are not hue-checked. See
[Known limitations](#known-limitations).

### Tokens only

Every object in `brand.json` has a closed set of keys. Any other key, at any level, is an error
(`unsupported key. brand.json only accepts tokens: no CSS, no markup, no flow text`). This covers attempts such
as `css`, `texts`, `colors.light.caution` or `font.css`. Colors, radius and font family are validated with strict
formats before any stylesheet is generated, so a value cannot close a CSS rule (for example
`"#ffffff;}body{display:none"` or a family containing quotes is rejected).

### File content

The first bytes of each file must match its extension:

| Extension | Required signature |
|---|---|
| `.png` | `89 50 4E 47 0D 0A 1A 0A` |
| `.webp` | `RIFF` at offset 0 and `WEBP` at offset 8 |
| `.ico` | `00 00 01 00` |
| `.woff2` | `wOF2` |
| `.woff` | `wOFF` |
| `.ttf` | `00 01 00 00` or `true` |
| `.otf` | `OTTO` |
| `.svg` | No binary signature; checked as text (below) |

SVG files (logo or favicon) must be valid UTF-8, must contain `<svg` followed by whitespace or `>`, and are
rejected if they match any of these case-insensitive patterns:

| Pattern | Rejected because |
|---|---|
| `<script` | Scripts |
| `<foreignObject` | Embedded HTML |
| `<!ENTITY` | Entity declarations |
| whitespace + `on<letters>` + `=` | Event handler attributes |
| `javascript:` | Script URLs |
| `@import` | Imported stylesheets |
| `href=` or `src=` (any prefix, such as `xlink:href`) with a quoted value not starting with `#` | Any reference outside the file |
| `url(` whose argument does not start with `#` | Any external `url()` |

These checks are a regex denylist and are defense in depth only. The primary controls are that the logo is only
ever loaded as an `<img>` (where an SVG runs no script and loads nothing), and that brand files are served with a
sandbox CSP (below). SVGs are not rasterized or re-serialized.

## How the brand is applied and served

**Generated stylesheet.** For a custom brand, `themeCss` builds a stylesheet containing only `@font-face` rules
and custom-property values:

```css
@font-face{font-family:"Inter";src:url("/brand/<hash>.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}
:root:root{--font-sans:"Inter",ui-sans-serif,...;--radius:12px;--bg:#f8fafc;--surface:#ffffff;...}
@media (prefers-color-scheme: dark){:root:root{--radius:12px;--bg:#0f172a;...}}
```

`app/layout.tsx` links it after `globals.css`. The doubled `:root:root` selector has higher specificity than the
`:root` defaults in `globals.css`, so the brand values win regardless of load order. The neutral brand needs no
stylesheet: its values are the defaults in `globals.css`, and a unit test checks that they match
`DEFAULT_PALETTES` in `server/brand.ts`.

**Served from memory, by content hash.** At startup every brand file (and the generated stylesheet) is read into
memory and given a public name: the first 16 hex characters of its SHA-256 plus its extension, for example
`/brand/3f9a0c1d2b4e5f60.woff2`. `GET /brand/<name>` (`app/brand/[file]/route.ts`) only accepts names matching
`^[0-9a-f]{16}\.(svg|png|webp|ico|woff2|woff|ttf|otf|css)$` and looks them up in that in-memory map. A request
never builds a file-system path, so path traversal is not possible, and a file changed on disk after startup is
not served. Any other name returns `404` with `Cache-Control: no-store`.

Response headers for brand files (`brandAssetHeaders`):

| Header | Value |
|---|---|
| `Content-Type` | By extension (`image/svg+xml`, `image/png`, `image/webp`, `image/x-icon`, `font/woff2`, `font/woff`, `font/ttf`, `font/otf`, `text/css; charset=utf-8`) |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | SVG: `default-src 'none'; style-src 'unsafe-inline'; sandbox`. Others: `default-src 'none'; sandbox` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `public, max-age=31536000, immutable` (the name is the content hash) |

`/brand/` is excluded from the page CSP middleware (`apps/vault/proxy.ts`) because it sets its own CSP. The page
CSP itself (`default-src 'none'`, `style-src 'self'`, `img-src 'self'`, `font-src 'self'`, Trusted Types) allows
brand assets only from the vault's own origin: no CDN, no inline styles and no remote fonts. The brand stylesheet
is a same-origin file, so no nonce or `'unsafe-inline'` is needed for styles.

## What a brand cannot change

- **Security notices and errors**: their text, their color scale (caution, danger, success and the neutral
  info notice), their icon and their presence. The fixed scale lives in `apps/vault/app/globals.css`
  (`--caution*`, `--danger*`, `--success*`) and is not part of the brand stylesheet; a unit test checks that the
  generated stylesheet never contains rules for them. Warnings such as "store the kit and the code separately" or
  "the seed file gives full control" cannot be hidden or restyled. This is the reason `brand.json` accepts no
  CSS: a CSS rule could hide a notice or make it look like decoration.
- **The flow and its texts**: steps, order, confirmations, review screens and every UI string.
- **Structure and layout**: one card per step, the header, the footer, the tabs and the step bar.
- **The monospace font**, used for addresses, hashes, codes and signed data.
- **The page CSP and Trusted Types policy.** The brand adds no inline style or script and no external origin.
- **The offline recovery tool**, which is never branded (see below).

## Static recovery page

The static recovery page (kit + passkey + code, no backend; see [RECOVERY.md](RECOVERY.md)) takes the brand at
**build time**, from the same `brand.json` the vault mounts:

```bash
pnpm --filter ./apps/vault build:static-recovery \
  --rp-id vault.example.com --manifest-pubkey <hex> \
  --out /absolute/path/recovery --brand-dir /absolute/path/my-brand [--brand "My wallet"]
```

- `renderStaticBrand` (`static-recovery/brand-build.tsx`) runs the same `loadBrand` validation and renders the
  same `BrandHeader` and `BrandFooter` components to static markup. The script bundles it for Node with esbuild.
- Brand files are written next to `index.html` as `brand-<hash>.<ext>`, plus `brand.css`; all of them are listed
  in the generated `SHA256SUMS`. The same `brand.json` produces the same bytes.
- `--brand` replaces the name, like `VAULT_BRAND_NAME` (1 to 64 characters, no control characters). It is
  HTML-escaped.
- Any brand issue prints `Invalid brand: <field> <reason>` and the build exits with status 1 without writing an
  output directory.
- `http:` links are never accepted here, regardless of environment.
- The page CSP (in a `<meta>` tag and in the generated `_headers`) allows `img-src 'self'` and `font-src 'self'`
  for the brand files; `connect-src` stays `'none'`.

## Offline recovery tool

The single-file offline recovery tool (`packages/recovery-tool`, `wl-embedded-wallet-recovery.html`) takes no
brand input at all. It is identical for every deployment, so its published SHA-256 can be compared against what
any vault serves (see [REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md)). A per-customer brand would give every
deployment a different hash, which would defeat that comparison and would let a compromised vault serve a
different tool unnoticed.

## Example brand: Acme Wallet

[`brands/example/`](../brands/example) is a fictional brand that exercises every kind of field. See its
[README](../brands/example/README.md).

| File | Content |
|---|---|
| `brand.json` | Name "Acme Wallet"; slate neutrals; indigo accent `#4F46E5` (light) and `#818CF8` (dark); `accentText` `#FFFFFF` / `#0F172A`; radius 12; Inter 400/500/600/700; a single logo for both schemes; favicon; a `support` link to `https://example.com/support` |
| `logo.svg` | 372 x 96 wordmark, 473 bytes |
| `favicon.svg` | 64 x 64 mark, 263 bytes |
| `fonts/Inter-*.woff2` | Inter Regular, Medium, SemiBold and Bold, about 97 to 104 KB each |
| `fonts/NOTICE.txt` | Inter copyright and SIL Open Font License 1.1 notice |

No `accentInk` is given: both accents already reach 4.5:1 as text on their background and surface, so the
derived ink equals the accent (the unit tests assert this). Indigo (about 243°) is far from both signal hues.

The example brand is used by the development vault (`apps/vault/.env.example`), by the main vault of the e2e
suite, by the image tests (mounted read-only at `/brand`), and by the demo app.

## The demo app

The demo integrator app (`examples/demo`) is a separate Next.js app and does **not** read `brand.json` or
`VAULT_BRAND_DIR`. It is branded statically with the same Acme example, at build time:

- `examples/demo/app/brand.tsx` loads the four Inter files from `brands/example/fonts` with `next/font/local`
  (self-hosted by Next, never from a CDN), exposed as `--font-brand`, and exports `BrandLogo`, an `<img>` of
  `brands/example/logo.svg` with `alt="Acme Wallet"`.
- `examples/demo/app/layout.tsx` sets the title "Acme Wallet Demo" and uses `brands/example/favicon.svg` as the
  icon.
- `examples/demo/app/globals.css` hard-codes the Acme palette as its own CSS variables (`--bg`, `--surface`,
  `--ink`, `--muted`, `--line`, `--accent`, `--accent-hover`, `--accent-active`, `--accent-text`,
  `--accent-ink`), plus its own fixed `--danger*` and `--ok*` notice scales.

Changing `brands/example` therefore changes the demo only after it is rebuilt, and changing the vault's brand
never changes the demo. An integrator's real app is expected to have its own design; the demo only shows that
the app and the vault can look consistent.

## Tests

| Test | What it covers |
|---|---|
| `apps/vault/tests/unit/brand.test.ts` | The example brand is valid and its derived ink; ink derivation for a light accent; the stylesheet contains only `@font-face` and variable values; `globals.css` defaults equal `DEFAULT_PALETTES` and meet AA; minimal brand; contrast errors with field, colors and ratio; explicit ink; signal hue rejection; unknown keys; malformed values (colors, radius, family, weight, name, version, links); local `http` links; path traversal, hidden files, wrong extensions, symlinks inside and outside; per-kind and total size limits; content signatures; hostile SVGs; missing, invalid and oversized `brand.json`; content-hash names; name precedence; static recovery build with and without a brand, name escaping, invalid brand produces nothing, reproducible output |
| `apps/vault/tests/unit/brand-route.test.ts` | `GET /brand/[file]`: types and headers for every file, case and extension mismatch, a file changed on disk after startup is not served, the neutral brand serves nothing |
| `e2e/tests/i-deployment.spec.ts` | A production start with a brand lacking contrast and containing CSS exits and names each field; the same build started with another RP ID, key and a mounted test brand renders that brand under the strict CSP (button color, loaded font, logo, favicon, links), keeps the caution notice colors fixed, and serves only hash-named files with safe headers (`/brand/brand.json`, `/brand/logo.svg` and encoded traversal attempts are 404) |
| `e2e/tests-image/image.spec.ts` with `e2e/compose.image.yaml` | The example brand mounted read-only into the real image |

## Known limitations

- **Only the accent is hue-checked.** A brand could choose, for example, a saturated red or yellow `background`,
  `surface` or `border`, or an explicit `accentInk` near a signal hue. Contrast rules still apply, and the notice
  scale keeps its own colors, icons and text, but the overall page could look alarming. Reviewing a customer's
  brand remains an operator responsibility.
- **Derived colors are not contrast-checked.** `accentText` on `--accent-hover` (the hover shade, a mix of the
  accent with `text`), and `text` on the derived tints `--surface-2` and `--ground-2`, are not validated. For the
  neutral and example brands they pass by construction of the palettes; for arbitrary brands this is not
  verified.
- **Contrast is WCAG 2.x only**, for normal-size text (4.5:1). Non-text contrast (3:1) is not checked for
  `border`.
- **SVG checks are a regex denylist**, not a parser. They are defense in depth behind `<img>`-only use and the
  sandbox CSP.
- **Logo dimensions are not validated**; a logo is scaled to 24 px high and clipped to 200 px wide by CSS.
- **Font files are only checked by signature**, not parsed.
- **`$schema` is accepted** but there is no published schema.
- Name length is measured in UTF-16 code units before trimming, so a name with leading or trailing spaces can be
  rejected even if its trimmed form fits.
