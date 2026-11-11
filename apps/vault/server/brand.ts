import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

/**
 * Deployment brand, at runtime and without rebuilding: a directory with `brand.json` and its files.
 * Tokens only (name, colors, radius, typeface, logo, favicon and links). Never CSS or markup: the security
 * warnings, their color scale and the flow cannot be customized. Everything is validated at startup and served from
 * memory, with content-derived names, so a request never reaches the file system.
 *
 * No dependencies on the rest of the vault: `scripts/build-static-recovery.mjs` bundles it to apply the brand at build time.
 */

export const BRAND_FILE = 'brand.json';
export const BRAND_SCHEMA_VERSION = 1;
export const DEFAULT_BRAND_NAME = 'Vault';
export const MAX_BRAND_NAME_LENGTH = 64;
export const MIN_TEXT_CONTRAST = 4.5;
export const MAX_BRAND_JSON_BYTES = 64 * 1024;
export const MAX_BRAND_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_RADIUS = 20;
const MAX_FONT_FILES = 8;
const MAX_PATH_LENGTH = 128;
const MAX_URL_LENGTH = 2048;

export type Scheme = 'light' | 'dark';
export const SCHEMES: Scheme[] = ['light', 'dark'];

/** The only colors a brand can change. Warnings, errors and states have their fixed scale in `globals.css`. */
export const COLOR_TOKENS = ['background', 'surface', 'text', 'muted', 'border', 'accent', 'accentText', 'accentInk'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export type Palette = Record<ColorToken, string>;

/** CSS variable for each token. `globals.css` defines the same default values: a test checks it. */
export const CSS_VARIABLES: Record<ColorToken, string> = {
  background: '--bg',
  surface: '--surface',
  text: '--text',
  muted: '--muted',
  border: '--border',
  accent: '--accent',
  accentText: '--accent-text',
  accentInk: '--accent-ink',
};

/** The neutral brand of the open-source vault. */
export const DEFAULT_PALETTES: Record<Scheme, Palette> = {
  light: {
    background: '#f3f4f6',
    surface: '#ffffff',
    text: '#15181e',
    muted: '#575d69',
    border: '#d9dce2',
    accent: '#2f3d55',
    accentText: '#ffffff',
    accentInk: '#2f3d55',
  },
  dark: {
    background: '#121418',
    surface: '#1b1e24',
    text: '#eceef2',
    muted: '#a3a9b5',
    border: '#30353e',
    accent: '#b4c2dc',
    accentText: '#121418',
    accentInk: '#b4c2dc',
  },
};
export const DEFAULT_RADIUS = 10;
export const SYSTEM_FONT_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

type AssetKind = 'logo' | 'favicon' | 'font';

const KINDS: Record<AssetKind, { extensions: string[]; maxBytes: number }> = {
  logo: { extensions: ['.svg', '.png', '.webp'], maxBytes: 256 * 1024 },
  favicon: { extensions: ['.svg', '.png', '.ico'], maxBytes: 64 * 1024 },
  font: { extensions: ['.woff2', '.woff', '.ttf', '.otf'], maxBytes: 512 * 1024 },
};

const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8',
};

const FONT_FORMATS: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

/** A file served by the vault. The public name is the content hash: there are no paths to traverse. */
export interface BrandAsset {
  name: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface BrandFont {
  asset: BrandAsset;
  weight: number;
  style: 'normal' | 'italic';
}

export interface BrandLinks {
  support: string | null;
  privacy: string | null;
  terms: string | null;
}

export interface Brand {
  /** `false` for the neutral brand: no brand stylesheet is needed. */
  custom: boolean;
  name: string;
  radius: number;
  palettes: Record<Scheme, Palette>;
  fontFamily: string | null;
  fonts: BrandFont[];
  logo: { light: BrandAsset; dark: BrandAsset | null } | null;
  favicon: BrandAsset | null;
  links: BrandLinks;
}

/** Same format as `ConfigIssue`: names the field, and the reason never contains secrets (a brand has none). */
export interface BrandIssue {
  variable: string;
  reason: string;
}

export function defaultBrand(name: string = DEFAULT_BRAND_NAME): Brand {
  return {
    custom: false,
    name,
    radius: DEFAULT_RADIUS,
    palettes: { light: { ...DEFAULT_PALETTES.light }, dark: { ...DEFAULT_PALETTES.dark } },
    fontFamily: null,
    fonts: [],
    logo: null,
    favicon: null,
    links: { support: null, privacy: null, terms: null },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Color

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex([0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * amount) as [number, number, number]);
}

function passesOn(color: string, grounds: string[]): boolean {
  return grounds.every((ground) => contrastRatio(color, ground) >= MIN_TEXT_CONTRAST);
}

/**
 * Accent ink: the same hue, darkened or lightened just enough to read as text (links and focus ring)
 * on the background and the surface. The typical case is a brand orange: fine as the fill of a
 * button with dark text, unreadable as text on white. `null` if no shade gets there.
 */
export function deriveInk(accent: string, grounds: string[]): string | null {
  if (passesOn(accent, grounds)) return accent;
  for (let step = 1; step <= 50; step += 1) {
    for (const target of ['#000000', '#ffffff']) {
      const candidate = mix(accent, target, step / 50);
      if (passesOn(candidate, grounds)) return candidate;
    }
  }
  return null;
}

/** The text color with the most contrast on the accent, among the brand text color, white and black. */
function deriveAccentText(accent: string, text: string): string {
  return ['#ffffff', text, '#000000'].reduce((best, candidate) => (contrastRatio(candidate, accent) > contrastRatio(best, accent) ? candidate : best));
}

/** HSL hue in degrees, saturation and lightness of a `#rrggbb` color. */
function hueOf(hex: string): { hue: number; saturation: number; lightness: number } {
  const [r, g, b] = channels(hex).map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation, lightness };
}

/**
 * Hues of the fixed security signals in `globals.css`: danger (red, 0°) and caution (yellow, ≈50°).
 * A saturated accent too close to them would make the primary button read as a warning, or a warning as the brand.
 * Success (green) is not protected: a green brand hides no warning.
 */
export const SIGNAL_HUES = [
  { name: 'danger', hue: 0, margin: 12 },
  { name: 'caution', hue: 50, margin: 10 },
];

export function signalClash(color: string): { name: string; hue: number } | null {
  const { hue, saturation, lightness } = hueOf(color);
  if (saturation < 0.4 || lightness < 0.15 || lightness > 0.9) return null;
  for (const signal of SIGNAL_HUES) {
    const distance = Math.min(Math.abs(hue - signal.hue), 360 - Math.abs(hue - signal.hue));
    if (distance < signal.margin) return { name: signal.name, hue: Math.round(hue) };
  }
  return null;
}

function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

// ---------------------------------------------------------------------------------------------------------------
// `brand.json` validation

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LOCAL_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

function checkLink(value: unknown, allowInsecure: boolean): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return `must be a URL of up to ${MAX_URL_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.username || url.password) return 'must not include a username or password';
  if (url.protocol === 'https:') return null;
  const local = LOCAL_HOSTS.includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol === 'http:' && allowInsecure && local) return null;
  return 'must be https';
}

// Each segment starts with a letter, digit, `_` or `-`: no `..`, no hidden files, no absolute paths.
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;

function hasPrefix(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The content must match its extension. On top of `nosniff`. */
function checkSignature(extension: string, bytes: Uint8Array): string | null {
  const ok = (() => {
    switch (extension) {
      case '.png':
        return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case '.webp':
        return hasPrefix(bytes, ascii('RIFF')) && hasPrefix(bytes, ascii('WEBP'), 8);
      case '.ico':
        return hasPrefix(bytes, [0x00, 0x00, 0x01, 0x00]);
      case '.woff2':
        return hasPrefix(bytes, ascii('wOF2'));
      case '.woff':
        return hasPrefix(bytes, ascii('wOFF'));
      case '.ttf':
        return hasPrefix(bytes, [0x00, 0x01, 0x00, 0x00]) || hasPrefix(bytes, ascii('true'));
      case '.otf':
        return hasPrefix(bytes, ascii('OTTO'));
      case '.svg':
        return true;
      default:
        return false;
    }
  })();
  return ok ? null : `is not a valid ${extension.slice(1)} file`;
}

/**
 * Defense in depth: the SVG is only used as an `<img>`, where nothing runs, and is served with a sandbox CSP.
 * Even so, anything that would only make sense for an attack is rejected: scripts, handlers, `foreignObject`,
 * entities and any reference outside the file itself.
 */
function checkSvg(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'must be UTF-8 text';
  }
  if (!/<svg[\s>]/i.test(text)) return 'is not an SVG';
  const forbidden: [RegExp, string][] = [
    [/<script/i, 'must not contain <script>'],
    [/<foreignObject/i, 'must not contain <foreignObject>'],
    [/<!ENTITY/i, 'must not declare entities'],
    [/\son[a-z]+\s*=/i, 'must not contain event handlers'],
    [/javascript:/i, 'must not contain javascript: URLs'],
    [/@import/i, 'must not import stylesheets'],
    [/(?:href|src)\s*=\s*["'](?!#)/i, 'only allows internal references (#id)'],
    [/url\(\s*["']?(?!#)/i, 'only allows url(#id)'],
  ];
  for (const [pattern, reason] of forbidden) if (pattern.test(text)) return reason;
  return null;
}

function assetName(bytes: Uint8Array, extension: string): string {
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${extension}`;
}

export function makeAsset(bytes: Uint8Array<ArrayBuffer>, extension: string): BrandAsset {
  return { name: assetName(bytes, extension), contentType: CONTENT_TYPES[extension], bytes };
}

class Loader {
  readonly issues: BrandIssue[] = [];
  private total = 0;

  constructor(
    private readonly dir: string,
    private readonly root: string,
  ) {}

  issue(field: string, reason: string): void {
    this.issues.push({ variable: field ? `${BRAND_FILE}:${field}` : 'VAULT_BRAND_DIR', reason });
  }

  /** A file declared in `brand.json`, inside the brand directory and without following links outside it. */
  file(field: string, value: unknown, kind: AssetKind): BrandAsset | null {
    if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || !SAFE_PATH.test(value)) {
      this.issue(field, `must be a relative path inside the brand directory, without "..", of up to ${MAX_PATH_LENGTH} characters`);
      return null;
    }
    const extension = extname(value).toLowerCase();
    const { extensions, maxBytes } = KINDS[kind];
    if (!extensions.includes(extension)) {
      this.issue(field, `unsupported extension: ${extensions.join(', ')}`);
      return null;
    }
    let real: string;
    try {
      real = realpathSync(/*turbopackIgnore: true*/ resolve(this.dir, value));
    } catch {
      this.issue(field, 'does not exist');
      return null;
    }
    if (!real.startsWith(this.root + sep)) {
      this.issue(field, 'points outside the brand directory');
      return null;
    }
    const stats = statSync(/*turbopackIgnore: true*/ real);
    if (!stats.isFile()) {
      this.issue(field, 'is not a file');
      return null;
    }
    if (stats.size > maxBytes) {
      this.issue(field, `exceeds the maximum of ${maxBytes / 1024} KB`);
      return null;
    }
    this.total += stats.size;
    if (this.total > MAX_BRAND_TOTAL_BYTES) {
      this.issue(field, `the brand exceeds the total maximum of ${MAX_BRAND_TOTAL_BYTES / 1024 / 1024} MB`);
      return null;
    }
    const bytes = new Uint8Array(readFileSync(/*turbopackIgnore: true*/ real));
    const invalid = checkSignature(extension, bytes) ?? (extension === '.svg' ? checkSvg(bytes) : null);
    if (invalid) {
      this.issue(field, invalid);
      return null;
    }
    return makeAsset(bytes, extension);
  }
}

function checkKeys(loader: Loader, field: string, value: Json, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    loader.issue(field ? `${field}.${key}` : key, 'unsupported key. brand.json only accepts tokens: no CSS, no markup, no flow text');
  }
}

const TOP_KEYS = ['$schema', 'version', 'name', 'colors', 'radius', 'font', 'logo', 'favicon', 'links'];

function parseName(loader: Loader, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_BRAND_NAME_LENGTH || /[\p{Cc}]/u.test(value)) {
    loader.issue('name', `must be 1 to ${MAX_BRAND_NAME_LENGTH} characters, with no control characters`);
    return null;
  }
  return value.trim();
}

function parseColors(loader: Loader, value: unknown): Record<Scheme, Palette> {
  const given: Record<Scheme, Partial<Palette>> = { light: {}, dark: {} };
  if (value !== undefined) {
    if (!isRecord(value)) loader.issue('colors', 'must be an object with light and dark');
    else {
      checkKeys(loader, 'colors', value, SCHEMES);
      for (const scheme of SCHEMES) {
        const palette = value[scheme];
        if (palette === undefined) continue;
        if (!isRecord(palette)) {
          loader.issue(`colors.${scheme}`, 'must be an object of colors');
          continue;
        }
        checkKeys(loader, `colors.${scheme}`, palette, COLOR_TOKENS);
        for (const token of COLOR_TOKENS) {
          const color = palette[token];
          if (color === undefined) continue;
          if (typeof color !== 'string' || !HEX_COLOR.test(color)) loader.issue(`colors.${scheme}.${token}`, 'must be a #RRGGBB color');
          else given[scheme][token] = color.toLowerCase();
        }
      }
    }
  }

  // Without a dark palette, dark mode uses the neutral one with the light palette's accent.
  if (given.dark.accent === undefined && given.light.accent !== undefined) given.dark.accent = given.light.accent;

  const palettes = {} as Record<Scheme, Palette>;
  for (const scheme of SCHEMES) {
    const own = given[scheme];
    const base = DEFAULT_PALETTES[scheme];
    const palette: Palette = { ...base, ...own };
    if (own.accentText === undefined && own.accent !== undefined) palette.accentText = deriveAccentText(palette.accent, palette.text);
    if (own.accentInk === undefined) {
      const ink = deriveInk(palette.accent, [palette.background, palette.surface]);
      if (ink) palette.accentInk = ink;
      else loader.issue(`colors.${scheme}.accent`, 'no shade of this color is readable as text on background and surface');
    }
    checkContrast(loader, scheme, palette);
    palettes[scheme] = palette;
  }
  return palettes;
}

/** The pairs used for text and buttons. Below AA is an error: the brand does not start. */
function checkContrast(loader: Loader, scheme: Scheme, palette: Palette): void {
  const clash = signalClash(palette.accent);
  if (clash) {
    loader.issue(
      `colors.${scheme}.accent`,
      `hue ${clash.hue}° (${palette.accent}) too close to the ${clash.name} hue; security warnings have their own scale and the accent must not be confused with it`,
    );
  }
  const pairs: [ColorToken, ColorToken][] = [
    ['text', 'background'],
    ['text', 'surface'],
    ['muted', 'background'],
    ['muted', 'surface'],
    ['accentText', 'accent'],
    ['accentInk', 'background'],
    ['accentInk', 'surface'],
  ];
  for (const [foreground, ground] of pairs) {
    const ratio = contrastRatio(palette[foreground], palette[ground]);
    if (ratio >= MIN_TEXT_CONTRAST) continue;
    loader.issue(
      `colors.${scheme}.${foreground}`,
      `contrast ${formatRatio(ratio)} on ${ground} (${palette[foreground]} on ${palette[ground]}); the minimum is ${MIN_TEXT_CONTRAST}:1`,
    );
  }
}

function parseRadius(loader: Loader, value: unknown): number {
  if (value === undefined) return DEFAULT_RADIUS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_RADIUS) {
    loader.issue('radius', `must be an integer number of pixels between 0 and ${MAX_RADIUS}`);
    return DEFAULT_RADIUS;
  }
  return value;
}

function parseFont(loader: Loader, value: unknown): { family: string | null; fonts: BrandFont[] } {
  if (value === undefined) return { family: null, fonts: [] };
  if (!isRecord(value)) {
    loader.issue('font', 'must be an object with family and files');
    return { family: null, fonts: [] };
  }
  checkKeys(loader, 'font', value, ['family', 'files']);
  const family = typeof value.family === 'string' && FONT_FAMILY.test(value.family) ? value.family : null;
  if (!family) loader.issue('font.family', 'must be a name of up to 64 characters: letters, digits, spaces and hyphens');
  const files = value.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FONT_FILES) {
    loader.issue('font.files', `must be a list of 1 to ${MAX_FONT_FILES} files: fonts are served from the vault, never from a CDN`);
    return { family: null, fonts: [] };
  }
  const fonts: BrandFont[] = [];
  files.forEach((entry, index) => {
    const field = `font.files[${index}]`;
    if (!isRecord(entry)) {
      loader.issue(field, 'must be an object with path, weight and style');
      return;
    }
    checkKeys(loader, field, entry, ['path', 'weight', 'style']);
    const weight = entry.weight ?? 400;
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) {
      loader.issue(`${field}.weight`, 'must be 100, 200, … or 900');
      return;
    }
    const style = entry.style ?? 'normal';
    if (style !== 'normal' && style !== 'italic') {
      loader.issue(`${field}.style`, 'must be normal or italic');
      return;
    }
    const asset = loader.file(`${field}.path`, entry.path, 'font');
    if (asset) fonts.push({ asset, weight, style });
  });
  return { family: family && fonts.length > 0 ? family : null, fonts: family ? fonts : [] };
}

function parseLogo(loader: Loader, value: unknown): Brand['logo'] {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const light = loader.file('logo', value, 'logo');
    return light ? { light, dark: null } : null;
  }
  if (!isRecord(value)) {
    loader.issue('logo', 'must be a path or an object with light and dark');
    return null;
  }
  checkKeys(loader, 'logo', value, ['light', 'dark']);
  const light = loader.file('logo.light', value.light, 'logo');
  const dark = value.dark === undefined ? null : loader.file('logo.dark', value.dark, 'logo');
  return light ? { light, dark } : null;
}

function parseLinks(loader: Loader, value: unknown, allowInsecure: boolean): BrandLinks {
  const links: BrandLinks = { support: null, privacy: null, terms: null };
  if (value === undefined) return links;
  if (!isRecord(value)) {
    loader.issue('links', 'must be an object with support, privacy and terms');
    return links;
  }
  checkKeys(loader, 'links', value, ['support', 'privacy', 'terms']);
  for (const key of ['support', 'privacy', 'terms'] as const) {
    if (value[key] === undefined) continue;
    const invalid = checkLink(value[key], allowInsecure);
    if (invalid) loader.issue(`links.${key}`, invalid);
    else links[key] = new URL(value[key] as string).href;
  }
  return links;
}

/**
 * Reads and validates the brand in `dir`. Returns every issue at once, like `validateConfig`. If there is any, the brand
 * is the neutral one: in production the vault does not start. `allowInsecure` allows `http` links to local hosts.
 */
export function loadBrand(dir: string, options: { allowInsecure?: boolean } = {}): { brand: Brand; issues: BrandIssue[] } {
  const absolute = resolve(/*turbopackIgnore: true*/ dir);
  let root: string;
  try {
    root = realpathSync(/*turbopackIgnore: true*/ absolute);
    if (!statSync(/*turbopackIgnore: true*/ root).isDirectory()) throw new Error('not a directory');
  } catch {
    return { brand: defaultBrand(), issues: [{ variable: 'VAULT_BRAND_DIR', reason: 'is not an accessible directory' }] };
  }
  const loader = new Loader(absolute, root);

  let raw: unknown;
  try {
    const path = realpathSync(/*turbopackIgnore: true*/ resolve(root, BRAND_FILE));
    if (!path.startsWith(root + sep)) throw new Error('outside');
    if (statSync(/*turbopackIgnore: true*/ path).size > MAX_BRAND_JSON_BYTES) {
      return { brand: defaultBrand(), issues: [{ variable: BRAND_FILE, reason: `exceeds the maximum of ${MAX_BRAND_JSON_BYTES / 1024} KB` }] };
    }
    raw = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'is not valid JSON' : `is missing from the brand directory`;
    return { brand: defaultBrand(), issues: [{ variable: BRAND_FILE, reason }] };
  }
  if (!isRecord(raw)) return { brand: defaultBrand(), issues: [{ variable: BRAND_FILE, reason: 'must be an object' }] };

  checkKeys(loader, '', raw, TOP_KEYS);
  if (raw.version !== BRAND_SCHEMA_VERSION) loader.issue('version', `must be ${BRAND_SCHEMA_VERSION}`);
  const name = parseName(loader, raw.name);
  const palettes = parseColors(loader, raw.colors);
  const radius = parseRadius(loader, raw.radius);
  const { family, fonts } = parseFont(loader, raw.font);
  const logo = parseLogo(loader, raw.logo);
  const favicon = raw.favicon === undefined ? null : loader.file('favicon', raw.favicon, 'favicon');
  const links = parseLinks(loader, raw.links, options.allowInsecure ?? false);

  if (loader.issues.length > 0) return { brand: defaultBrand(), issues: loader.issues };
  return {
    brand: { custom: true, name: name ?? DEFAULT_BRAND_NAME, radius, palettes, fontFamily: family, fonts, logo, favicon, links },
    issues: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Output

/** All brand files, excluding the stylesheet. */
export function brandFiles(brand: Brand): BrandAsset[] {
  return [...brand.fonts.map((font) => font.asset), ...(brand.logo ? [brand.logo.light, brand.logo.dark] : []), brand.favicon].filter(
    (asset): asset is BrandAsset => asset !== null,
  );
}

function declarations(palette: Palette, radius: number, font: string | null): string {
  const tokens = COLOR_TOKENS.map((token) => `${CSS_VARIABLES[token]}:${palette[token]}`);
  const shared = font === null ? [] : [`--font-sans:"${font}",${SYSTEM_FONT_STACK}`];
  return [...shared, `--radius:${radius}px`, ...tokens].join(';');
}

/**
 * Brand stylesheet: only `@font-face` and variable values, built from already validated data. It goes after
 * `globals.css`; `:root:root` beats its default values regardless of load order.
 */
export function themeCss(brand: Brand, urlFor: (asset: BrandAsset) => string): string {
  const faces = brand.fonts.map(
    ({ asset, weight, style }) =>
      `@font-face{font-family:"${brand.fontFamily}";src:url("${urlFor(asset)}") format("${FONT_FORMATS[extname(asset.name)]}");font-weight:${weight};font-style:${style};font-display:swap}`,
  );
  return [
    ...faces,
    `:root:root{${declarations(brand.palettes.light, brand.radius, brand.fontFamily)}}`,
    `@media (prefers-color-scheme: dark){:root:root{${declarations(brand.palettes.dark, brand.radius, null)}}}`,
    '',
  ].join('\n');
}

/** Headers for a brand file. An SVG opened directly stays in a sandbox, with no scripts. */
export function brandAssetHeaders(asset: BrandAsset): Record<string, string> {
  return {
    'Content-Type': asset.contentType,
    'Content-Length': String(asset.bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': asset.contentType === 'image/svg+xml' ? "default-src 'none'; style-src 'unsafe-inline'; sandbox" : "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The name is the content hash.
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
}

export const BRAND_ASSET_NAME = /^[0-9a-f]{16}\.(svg|png|webp|ico|woff2|woff|ttf|otf|css)$/;

// ---------------------------------------------------------------------------------------------------------------
// Process brand

export const BRAND_ROUTE = '/brand';

export interface VaultBrand extends Brand {
  stylesheet: BrandAsset | null;
  url(asset: BrandAsset): string;
}

type Env = Record<string, string | undefined>;

/** The brand from `VAULT_BRAND_DIR`, or the neutral one. The `VAULT_BRAND_NAME` name is applied afterwards: see `currentBrand`. */
export function loadBrandFromEnv(env: Env = process.env, allowInsecure: boolean = env.NODE_ENV !== 'production' || env.ALLOW_INSECURE_LOCAL === '1'): {
  brand: VaultBrand;
  issues: BrandIssue[];
} {
  const dir = env.VAULT_BRAND_DIR?.trim();
  const { brand, issues } = dir ? loadBrand(dir, { allowInsecure }) : { brand: defaultBrand(), issues: [] };
  const url = (asset: BrandAsset) => `${BRAND_ROUTE}/${asset.name}`;
  const stylesheet = brand.custom ? makeAsset(new TextEncoder().encode(themeCss(brand, url)) as Uint8Array<ArrayBuffer>, '.css') : null;
  return { brand: { ...brand, stylesheet, url }, issues };
}

let current: { brand: VaultBrand; files: Map<string, BrandAsset> } | null = null;

/**
 * The brand is read once per process: changing it requires restarting the container, not rebuilding the image.
 * Name precedence: `VAULT_BRAND_NAME`, then the `name` in `brand.json`, otherwise "Vault".
 */
export function currentBrand(env: Env = process.env): VaultBrand {
  if (!current) {
    const { brand } = loadBrandFromEnv(env);
    const files = new Map([...brandFiles(brand), ...(brand.stylesheet ? [brand.stylesheet] : [])].map((asset) => [asset.name, asset]));
    current = { brand, files };
  }
  const override = env.VAULT_BRAND_NAME?.trim();
  return override ? { ...current.brand, name: override } : current.brand;
}

/** `null` if the name is not that of a file of this brand. Never touches the file system. */
export function brandAsset(name: string): BrandAsset | null {
  if (!BRAND_ASSET_NAME.test(name)) return null;
  currentBrand();
  return current?.files.get(name) ?? null;
}

/** Tests only. */
export function resetBrandCache(): void {
  current = null;
}
