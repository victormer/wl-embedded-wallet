---
name: Vault
description: White-label embedded wallet; a custody popup that reads like a calm signing document.
colors:
  # Neutral default brand (light). A brand.json replaces these eight tokens per scheme at runtime.
  background: "#f3f4f6"
  surface: "#ffffff"
  text: "#15181e"
  muted: "#575d69"
  border: "#d9dce2"
  accent: "#2f3d55"
  accent-text: "#ffffff"
  accent-ink: "#2f3d55"
  # Neutral default brand (dark).
  background-dark: "#121418"
  surface-dark: "#1b1e24"
  text-dark: "#eceef2"
  muted-dark: "#a3a9b5"
  border-dark: "#30353e"
  accent-dark: "#b4c2dc"
  accent-text-dark: "#121418"
  accent-ink-dark: "#b4c2dc"
  # Derived from the brand tokens (color-mix over the brand tokens; resolved here for the neutral brand).
  surface-2: "#f4f5f5"
  ground-2: "#e6e7e9"
  line-strong: "#939598"
  accent-hover: "#2b384d"
  surface-2-dark: "#24272d"
  ground-2-dark: "#1f2125"
  line-strong-dark: "#7b7e83"
  accent-hover-dark: "#bcc8df"
  # Fixed notice scale: the same for every brand, not customizable.
  caution: "#594b00"
  caution-bg: "#fefbe3"
  caution-line: "#e8d77a"
  caution-icon: "#a08600"
  danger: "#8f1d1d"
  danger-bg: "#fdf1f1"
  danger-line: "#f1c2c2"
  danger-icon: "#c02626"
  success: "#14532d"
  success-bg: "#effaf3"
  success-line: "#bfe3cc"
  success-icon: "#15803d"
  caution-dark: "#f3e38e"
  caution-bg-dark: "#25220a"
  caution-line-dark: "#57501a"
  caution-icon-dark: "#e2cb3a"
  danger-dark: "#f6b4b4"
  danger-bg-dark: "#2c1717"
  danger-line-dark: "#5c2a2a"
  danger-icon-dark: "#f07171"
  success-dark: "#a7e3bd"
  success-bg-dark: "#12261a"
  success-line-dark: "#24513a"
  success-icon-dark: "#4ccf7f"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-small:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  code-plate:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
rounded:
  control: "10px"
  inner: "7px"
  card: "14px"
  bar: "2px"
spacing:
  field: "6px"
  tight: "10px"
  stack: "12px"
  screen: "18px"
  gutter: "24px"
components:
  screen-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "24px 22px 26px"
    width: "496px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-text}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-disabled:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.inner}"
    padding: "10px 12px"
    height: "44px"
  value-block:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.mono}"
    rounded: "{rounded.inner}"
    padding: "10px 12px"
  recovery-code:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.code-plate}"
    rounded: "{rounded.inner}"
    padding: "18px 14px"
  note-info:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.body-small}"
    rounded: "{rounded.inner}"
    padding: "11px 13px"
  note-caution:
    backgroundColor: "{colors.caution-bg}"
    textColor: "{colors.caution}"
    typography: "{typography.body-small}"
    rounded: "{rounded.inner}"
    padding: "11px 13px"
  note-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    typography: "{typography.body-small}"
    rounded: "{rounded.inner}"
    padding: "11px 13px"
  note-success:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    typography: "{typography.body-small}"
    rounded: "{rounded.inner}"
    padding: "11px 13px"
  tabs-track:
    backgroundColor: "{colors.ground-2}"
    rounded: "{rounded.control}"
    padding: "4px"
  tab:
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.inner}"
    padding: "6px 8px"
    height: "38px"
  tab-current:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.inner}"
  step-bar:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.bar}"
    height: "4px"
  step-bar-current:
    backgroundColor: "{colors.text}"
    rounded: "{rounded.bar}"
    height: "4px"
  link:
    textColor: "{colors.accent-ink}"
---

# Design System: Vault

This document describes the visual system of the vault UI: the popup served by `apps/vault`, and the static
recovery page built from the same components and the same `apps/vault/app/globals.css`. The front matter above
lists the tokens in machine-readable form, resolved for the neutral default brand (`rounded` values assume the
default radius of 10 px). The source of truth is the code: `apps/vault/app/globals.css` for tokens and
components, `apps/vault/server/brand.ts` for the brand contract, and `apps/vault/app/_components/` for the React
components. How a deployment supplies its own brand is described in [BRANDING.md](BRANDING.md).

The offline recovery tool (`packages/recovery-tool`) and the demo integrator app (`examples/demo`) have their own
stylesheets and are not covered here.

## Overview

**Creative north star: "the signing document"**

The vault is a custody popup about 480 px wide that reads like a document reviewed before signing: a single white
card per step on a barely grey background, the task title at the top, the data being approved in tinted read-only
blocks, and the primary action full width at the end. The density is that of a careful form, not a dashboard:
15 px body text, 18 px vertical rhythm between blocks, and nothing decorative competing with the current step.

The system has two layers, and that separation is the design:

- **The brand layer** is a token contract that each deployment replaces at runtime with its `brand.json`: eight
  colors per scheme, one radius, one typeface, a logo, a favicon and links. The values in this document are the
  neutral default brand, "Vault", in a muted slate blue. The repository also ships a fictional example brand,
  "Acme Wallet" (`brands/example`: indigo accent on slate neutrals, Inter), used in development, in the e2e suite
  and by the demo app.
- **The fixed layer** is the notice scale (caution, danger, success, neutral info), the card structure and the
  flow. No brand can change, hide or imitate them.

Both the "dark wallet with neon" look and the flat grey form with no hierarchy are explicitly rejected. The theme
follows `prefers-color-scheme` with no toggle, and dark mode is a complete brand scheme, not an inversion.

**Key characteristics:**

- One card per step, centered, at most 496 px wide.
- The brand accent lives only in the primary button, links, focus and the checkbox. The current step and the
  current tab are neutral: position is not a state, but it looks too much like one.
- Security notices have their own fixed scale, always with a stroke icon and text.
- What is being approved (addresses, network, RPC host, signed data) goes in tinted read-only blocks, in
  monospace, distinct from editable fields.
- AA contrast is validated at startup for any brand. In production an invalid brand stops the vault from
  starting; outside production the vault logs the issues and uses the neutral brand.
- Everything is served from the vault's own origin: no CDN, no inline styles, self-hosted fonts.

## Colors

A cool neutral palette with a single accent, plus a notice scale that does not belong to the brand. All tokens
are CSS custom properties on `:root` in `apps/vault/app/globals.css`, with dark values under
`@media (prefers-color-scheme: dark)`.

### Primary

- **Signing slate** (`--accent`; `accent` / `accent-dark` above): fill of the primary button, `accent-color` of
  checkboxes, and the base of the text selection tint (at 32%). In the neutral brand it is a dark slate blue in
  light mode and a mist blue in dark mode; each deployment replaces it.
- **Text on accent** (`--accent-text`): the primary button's text. If the brand does not provide it, the vault
  picks whichever of white, the brand's text color and black has the most contrast with the accent.
- **Accent ink** (`--accent-ink`): the accent when it has to read as text or a thin stroke on the background and
  the surface: links, the focus ring, the border of a focused field. If the brand does not provide it, it is
  derived by darkening or lightening the accent just enough to reach 4.5:1. The typical case is an orange: fine
  as a fill with dark text, unreadable as text on white.
- **Accent hover** (`--accent-hover`): derived, `color-mix(in srgb, var(--accent) 86%, var(--text))`. Not
  configurable.

### Neutral

- **Table** (`--bg`; `background`): the page background behind the card.
- **Paper** (`--surface`; `surface`): the card, editable fields, the secondary button and the current tab.
- **Ink** (`--text`; `text`): main text, and the text of every neutral notice.
- **Pencil** (`--muted`; `muted`): field labels, secondary text, pending steps, the info icon and the spinner. It
  is only validated on background and surface, so it is never used as a text color on tints.
- **Rule** (`--border`; `border`): card border, panel separator, pending step bar.
- **Tinted paper** (`--surface-2`): derived, `text` at 4.5% over `surface`. Background of read-only blocks, the
  info notice, the disabled button and the hovered secondary button.
- **Rail** (`--ground-2`): derived, `text` at 6% over `background`. Track of the segmented tab control.
- **Firm stroke** (`--line-strong`): derived, `text` at 46% over `surface` (exactly 3:1 on white in the neutral
  brand). Border of editable fields, the secondary button and the recovery code plate, and the scrollbar color.

### Notice scale (fixed)

- **Caution** (`--caution`, `--caution-bg`, `--caution-line`, `--caution-icon`): security warnings, for example
  "store the kit and the code separately", "the seed gives full control", a different wdk-utils version, or a
  transaction whose data is an ERC-20 approval or is not decoded. It is a true yellow (hue about 50°), deliberately
  kept away from brand oranges such as `#FCA311` (about 37°). An "amber" was considered and resolved into yellow so
  that it cannot be confused with an orange accent.
- **Danger** (`--danger`, `--danger-bg`, `--danger-line`, `--danger-icon`): flow errors, with `role="alert"`.
- **Success** (`--success`, `--success-bg`, `--success-line`, `--success-icon`): confirmations.
- **Info**: has no color of its own. It uses tinted paper, the rule and a pencil icon, so it inherits the brand
  without being able to look like a warning.

Each tone has four parts (text, background, line and icon), each with a dark variant. On its background, each icon
is above 3:1 and each text above 8:1. In the components the tones map to the classes `note` (info), `note-warn`
(caution), `note-error` (danger) and `note-ok` (success); see `NoteTone` in `apps/vault/app/_components/ui.tsx`.

### Brand contract

A brand can change only these tokens, per light and dark scheme: `background`, `surface`, `text`, `muted`,
`border`, `accent`, `accentText`, `accentInk` (CSS variables `--bg`, `--surface`, `--text`, `--muted`, `--border`,
`--accent`, `--accent-text`, `--accent-ink`). In addition: `radius` (integer, 0 to 20 px, setting `--radius`),
`font` (a family and 1 to 8 self-hosted files, setting `--font-sans`), `logo` (light, optional dark), `favicon`
and `links` (`support`, `privacy`, `terms`). Never CSS or markup. The derived tokens are recomputed from the brand
tokens by `color-mix()` in `globals.css`. Full rules and limits: [BRANDING.md](BRANDING.md).

### Example brand: Acme Wallet

The fictional example in `brands/example` uses an indigo accent, `#4F46E5` in light mode and `#818CF8` in dark
mode, with `accentText` `#FFFFFF` and `#0F172A` respectively; slate neutrals (`#F8FAFC`, `#FFFFFF`, `#0F172A`,
`#64748B`, `#E2E8F0` in light mode; `#0F172A`, `#1E293B`, `#F8FAFC`, `#94A3B8`, `#334155` in dark mode); radius
12 px; and Inter (400, 500, 600, 700, SIL OFL 1.1). Both accents already reach 4.5:1 as text, so the derived
accent ink is the accent itself in both schemes.

### Named rules

**The stateless accent rule.** The brand accent never means a state or a warning. It lives in the primary button,
links, focus and the checkbox; never in a notice, an error, a confirmation, the step bar or the current tab, which
use ink and the firm stroke.

**The fixed scale rule.** Caution, danger and success are the same for every brand. The vault rejects a saturated
accent less than 12° from the danger red (0°) or less than 10° from the caution yellow (50°). Green is not
protected, because a green brand hides no warning.

**The startup AA rule.** Text on background and surface, pencil on background and surface, text on accent, and
ink on background and surface: all seven pairs at 4.5:1 or more, in both schemes. A brand that fails is never
applied partially.

## Typography

**Display font:** none; the largest title is the task title, at 22 px.

**Body font:** the brand family (`--font-sans`), with the system stack
(`ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`) behind it. In the
neutral brand it is only the system stack; a brand with its own identity ships its font (the Acme example ships
Inter).

**Mono font:** `--mono`, `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`, fixed for every brand.

**Character:** a sober sans for reading short instructions, and a monospace for everything that is compared
character by character. Hierarchy comes from weight and size, without decorative capitals.

### Hierarchy

- **Headline** (700, 22 px, line height 1.25, -0.015em, `text-wrap: balance`): the task `h1`, one per card.
- **Title** (650, 16 px, 1.35): panel `h2`, and the weight of buttons, the current tab, the current step and the
  kit delivery titles.
- **Body** (400, 15 px, 1.55, `text-wrap: pretty`): instructions and non-technical read-only values.
- **Body small** (14 px): secondary text in pencil, notices and confirmation checkboxes.
- **Label** (500, 13 px, in pencil): the label above each value; also the tabs.
- **Caption** (12 px): step bar labels and the labels of each call in a UserOperation. Footer links are 13 px.
- **Mono** (13 px, 1.5): addresses, `chainId`, RPC host, messages, EIP-712 and UserOperation data, fingerprints
  and seeds.
- **Code plate** (600, 17 px, 0.06em, mono): only the recovery code.

### Named rules

**The comparison rule.** Every value the user may have to compare character by character (address, hash,
fingerprint, code) is set in monospace and breaks anywhere (`overflow-wrap: anywhere`) rather than overflow the
card.

**The literal terms rule.** Technical terms needed to review a signature (`chainId`, EIP-712, UserOperation) are
shown with their original spelling, neither translated nor styled.

## Layout

One column. At the top, the brand header (`.brand`): a logo 24 px high and at most 200 px wide, left-aligned with
the card's content, or the name at 15 px/700 when there is no logo; it has the card's width (at most 496 px,
`calc(100% - 24px)`) and a minimum height of 64 px. Below it, the task card (`.screen`): at most 496 px,
`calc(100% - 24px)` on narrow screens, centered. At the end, the footer (`.site-footer`, at most 520 px) with the
brand links (Help, Privacy, Terms) centered at 13 px, pushed to the bottom of the viewport. The recover and relink
tabs (`.tabs`) sit outside the card, above it, at the same width.

Inside the card everything is a vertical stack: 18 px between blocks, 12 px inside a group (`.stack`, `.panel`),
6 px between label and value (`.field`). A secondary panel is separated by a rule and 22 px of space. Buttons go in
a row that shares the width (`.actions .button`: `flex: 1 1 auto`, minimum `min(180px, 100%)`, 10 px gap): each
keeps its text on one line, and when they do not fit they stack at full width.

Breakpoints:

- **600 px and up:** the card padding goes from 24/22/26 px to 30/32/32 px, and the header gains space at the top
  (padding from `16px 22px 8px` to `24px 32px 8px`).
- **420 px and below:** the recovery code drops to 14 px with 0.02em tracking and 8 px horizontal padding, so it
  fits on one line; monospace value blocks drop to 12 px with -0.01em tracking and 8 px horizontal padding, so a
  42-character address fits on one line; UserOperation calls lose their indentation.

The enrollment step bar is a grid of five equal columns with labels truncated by an ellipsis.

**The one card per step rule.** Each screen is a single card with a single `h1`. A caution notice sits right
above the action it affects, and the primary button closes the card.

## Elevation and depth

Almost flat. In light mode the card has a very soft two-layer ambient shadow that only lifts it off the
background; in dark mode there is no shadow, and separation comes from the tonal step between background and
surface plus the rule. Depth inside the card is tonal: read-only data sinks one step (tinted paper), and editable
fields stay at paper level with a firm stroke. The current tab of the segmented control rises with a 1 px shadow.

### Shadow vocabulary

- **Card** (`--shadow`: `0 1px 2px rgb(16 24 40 / 0.04), 0 8px 24px -12px rgb(16 24 40 / 0.14)`): only the task
  card, only in light mode.
- **Current tab** (`box-shadow: 0 1px 2px rgb(16 24 40 / 0.06)`): the selected tab on its rail.

### Named rules

**The fading shadow rule.** Shadows exist only in light mode; in dark mode `--shadow` is `none` and the card
separates by tone. No other element has its own shadow. (The current tab keeps its 1 px shadow in dark mode, where
it is barely visible against the dark surface.)

## Shapes

Softly rounded corners from a single token. The brand provides `--radius` (10 px in the neutral brand, 12 px in the
Acme example); buttons and the tab track use it as is, the card adds 4 px, and everything nested inside (fields,
value blocks, notices, tabs, the file picker) uses `--radius-inner`, the radius minus 3 px, never below zero. Step
bars are 4 px high capsules with a 2 px radius; the spinner is the only circle. Borders are 1 px and solid, with
one exception: the recovery code plate, which is dashed.

**The derived radius rule.** Only one radius is configured. Inner = radius - 3 px, card = radius + 4 px; a
component never sets a standalone radius.

## Components

### Buttons

Firm and unadorned: one fill, one weight and no shadow (`.button`).

- **Shape:** brand radius corners (10 px in the neutral brand), at least 44 px high.
- **Primary:** accent fill with text on accent, weight 650, 10 x 18 px padding. It is the only element on the
  screen with the accent as its background.
- **Hover / focus:** on hover, the accent hover shade (150 ms ease-out fade); on press it moves down 1 px
  (100 ms). Focus is a 2 px ring offset by 2 px, in accent ink, except on the primary button, where it is in ink
  (`--text`): a ring the color of the fill would read as a thicker button.
- **Secondary** (`.button-secondary`): paper with ink text and a firm stroke; tinted paper on hover.
- **Disabled:** tinted paper, pencil text, the rule as border, `cursor: not-allowed`. It looks switched off, not
  translucent.
- **Back to the app** (`BackToApp`): a primary button at the end of the final screen. It focuses the opener and
  closes the popup when clicked; the popup never closes by itself.

### Inputs and fields

- **Style** (`.input`): paper, 1 px firm stroke, inner radius, 44 px high, 10 x 12 px padding. Text areas and the
  code field are monospace; the code field is also uppercase with 0.04em tracking (`.input-code`), so it is typed
  the way it is read.
- **Focus:** the border switches to accent ink and the focus ring is added at a 1 px offset.
- **Hover:** the border darkens (`text` at 64% over `surface`).
- **File** (`.file-picker`): a custom control instead of the native one (whose text would appear in the browser's
  language): "Choose file" as a small secondary button on tinted paper, and the file name in pencil, or "No file".
  The real input covers the control, transparent, and keeps focus, keyboard handling and its `data-testid`.
- **Checkbox** (`.check`): an 18 px box with the brand `accent-color` and the confirmation sentence next to it, at
  14 px.

### Cards and containers

- **Corner style:** brand radius + 4 px (14 px in the neutral brand).
- **Background:** paper on the table.
- **Shadow strategy:** the card shadow in light mode, none in dark mode.
- **Border:** 1 px rule.
- **Internal padding:** 24/22/26 px, 30/32/32 px from 600 px.

### Read-only value block

The label in pencil at 13 px above, and the value below on tinted paper (`.value`), with a transparent border,
inner radius and 10 x 12 px padding. Technical values are monospace at 13 px; long data (messages, EIP-712) goes in
a scrollable block of at most 220 px (`.value-pre`; also a transaction's calldata). The summarizing value (the network with its `chainId`) is
set at 650 (`.value-strong`). An empty value shows in pencil at 14 px (`.value-empty`).

Each call of a UserOperation (`.call`) is a definition list of `to`, amount and data, each with its 12 px
label, indented 12 px behind a 1 px rule. A transaction's decoded ERC-20 `transfer` or `approve` (token contract,
recipient or spender, amount) uses the same `.call` list.

**The read versus editable rule.** A value being approved never looks like a field: what is read is tinted and has
no stroke; what is editable is paper with a firm stroke.

### Notices

A strip (`Note`, `.note`) with an 18 px stroke icon on the left and the text at 14 px/1.5, 11 x 13 px padding,
inner radius and a 1 px border in the tone's line color. Four tones: info (neutral, part of the brand), caution,
danger and success (fixed scale). The icons are custom, drawn with a single 1.6 px stroke on a 20-unit grid: a
triangle with a stroke and a dot for caution, a circle with a cross for danger, a circle with a check mark for
success, and a circle with a stroke and a dot for info. The "working" state (`Working`, `.note-working`) uses the
same neutral strip with a 16 px spinner instead of the icon and `role="status"`.

**The named notice rule.** No state is conveyed by color alone: every notice has its icon and a sentence that says
what is happening.

### Navigation

- **Tabs** (`.tabs`, `.tab`): a segmented control outside the card; a rail with 4 px padding and the brand radius,
  tabs 38 px high at 13 px/500 with the inner radius. The current tab (`.tab-current`) is paper, weight 650, with
  the rule and a 1 px shadow; in dark mode, where paper is darker than the rail, it is lightened (`text` at 12%
  over `surface`) with a firm stroke so that it does not read inverted. On hover, paper at 50%. Tabs are marked
  with `aria-pressed`.
- **Footer** (`BrandFooter`): brand links at 13 px in accent ink, with a 1 px underline offset by 3 px that
  thickens to 2 px on hover. They open outside the vault without a `Referer` (`rel="noopener noreferrer"`).

### Step bar (system signature)

The five enrollment steps (Passkey, Code, Encryption, Kit, Drill; `apps/vault/app/_components/enroll-steps.tsx`) in
equal columns (`.steps`). Each is a 4 px bar above its 12 px label: pending in rule and pencil, done in firm stroke
with ink text, current in ink with text at 650. No accent: progress is a state. The bar changes color with a 200 ms
fade.

### Kit delivery

The tool-then-kit delivery list (`.delivery`) is a vertical list with 20 px gaps and 650 titles; a step that is not
yet available (`.delivery-locked`) shows its title in pencil.

### Recovery code (system signature)

The single-copy plate (`.value.value-code`): monospace at 17 px and 600 with 0.06em tracking, centered, on tinted
paper, with a 1 px dashed firm-stroke border and 18 x 14 px padding. One click selects it whole
(`user-select: all`). It is shown only once. Below 420 px it drops to 14 px with 0.02em tracking and 8 px horizontal
padding, so the code fits on one line.

## Motion

Transitions are short and functional: 150 ms ease-out for button and field color changes, 100 ms for the button
press, 200 ms for step bar color, and a 0.8 s linear spin for the spinner. With `prefers-reduced-motion: reduce`,
all transitions and animations drop to 0.01 ms and the spinner stops as an open ring.

## Do's and don'ts

### Do

- **Do** reserve the accent for the primary button, links, focus and the checkbox.
- **Do** use the accent ink, never the accent, for any text or thin stroke on background or surface.
- **Do** put every value being approved in a tinted read-only block, with its label above, in monospace if it is
  technical.
- **Do** pair every notice with its stroke icon and its text, in the tone of the fixed scale that fits it.
- **Do** derive every radius from the single brand `radius` (inner - 3 px, card + 4 px).
- **Do** respect `prefers-reduced-motion`: transitions at 0.01 ms and the spinner stopped as an open ring.
- **Do** serve logos, the favicon and fonts from the vault itself.

### Don't

- **Don't** use the brand accent, or a nearby hue, in a notice, error or confirmation.
- **Don't** let a brand change the notice scale, hide a notice or touch the flow; `brand.json` only changes tokens.
- **Don't** accept a saturated accent less than 12° from the danger red or less than 10° from the caution yellow.
- **Don't** give a read-only value the look of an editable field, or the other way around.
- **Don't** build the "dark wallet with neon" or the flat grey form with no hierarchy.
- **Don't** use inline styles, a CDN or remote fonts: the vault CSP does not allow them.
- **Don't** add shadows outside the card and the current tab, or any card shadow in dark mode.

## Related documents

[BRANDING.md](BRANDING.md) (brand contract and validation), [ARCHITECTURE.md](ARCHITECTURE.md),
[THREAT-MODEL.md](THREAT-MODEL.md) (why notices are fixed), [TESTING.md](TESTING.md).
