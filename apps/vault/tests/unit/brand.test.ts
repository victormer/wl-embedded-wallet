import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BRAND_ASSET_NAME,
  COLOR_TOKENS,
  CSS_VARIABLES,
  DEFAULT_PALETTES,
  MIN_TEXT_CONTRAST,
  contrastRatio,
  currentBrand,
  deriveInk,
  loadBrand,
  resetBrandCache,
  signalClash,
  themeCss,
  type Palette,
} from '../../server/brand';
import { brandName, publicRuntimeConfig } from '../../server/config';

const EXAMPLE_BRAND = resolve('../../brands/example');
const FONT = join(EXAMPLE_BRAND, 'fonts/Inter-Regular.woff2');
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><clipPath id="c"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#c)"><rect width="10" height="10" fill="#123456"/></g></svg>';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-brand-test-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A valid brand directory, with `brand` layered over the base. */
function brandDir(brand: Record<string, unknown> = {}, files: Record<string, string | Uint8Array> = {}): string {
  const dir = mkdtempSync(join(root, 'brand-'));
  mkdirSync(join(dir, 'fonts'));
  writeFileSync(join(dir, 'logo.svg'), LOGO);
  copyFileSync(FONT, join(dir, 'fonts/regular.woff2'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(
    join(dir, 'brand.json'),
    JSON.stringify({ version: 1, name: 'Brand', logo: 'logo.svg', font: { family: 'Brand Sans', files: [{ path: 'fonts/regular.woff2' }] }, ...brand }),
  );
  return dir;
}

const issuesOf = (dir: string, allowInsecure = false) => loadBrand(dir, { allowInsecure }).issues.map((issue) => issue.variable);
const reasonsOf = (dir: string) => loadBrand(dir).issues.map(({ variable, reason }) => `${variable} ${reason}`);

describe('brand.json: the example brand', () => {
  it('is valid, and its accent already reads as AA text in both schemes', () => {
    const { brand, issues } = loadBrand(EXAMPLE_BRAND);
    expect(issues).toEqual([]);
    expect(brand.custom).toBe(true);
    expect(brand.name).toBe('Acme Wallet');
    expect(brand.palettes.light.accent).toBe('#4f46e5');
    // Indigo on white reaches AA as text: the ink is the accent itself.
    expect(contrastRatio('#4f46e5', '#ffffff')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(brand.palettes.light.accentInk).toBe('#4f46e5');
    expect(contrastRatio(brand.palettes.light.accentInk, brand.palettes.light.surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(brand.palettes.light.accentInk, brand.palettes.light.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(brand.palettes.dark.accentInk).toBe('#818cf8');
    expect(brand.fonts.map((font) => font.weight)).toEqual([400, 500, 600, 700]);
    expect(brand.logo?.light.contentType).toBe('image/svg+xml');
    expect(brand.links).toEqual({ support: 'https://example.com/support', privacy: null, terms: null });
  });

  it('a light accent that does not reach AA as text derives an ink of the same hue', () => {
    const { brand, issues } = loadBrand(brandDir({ colors: { light: { accent: '#fca311', accentText: '#111827' } } }));
    expect(issues).toEqual([]);
    expect(contrastRatio('#fca311', '#ffffff')).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(brand.palettes.light.accentInk).not.toBe('#fca311');
    expect(contrastRatio(brand.palettes.light.accentInk, brand.palettes.light.surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(brand.palettes.light.accentInk, brand.palettes.light.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it('the stylesheet only carries @font-face and variable values, never rules targeting the warnings', () => {
    const { brand } = loadBrand(EXAMPLE_BRAND);
    const css = themeCss(brand, (asset) => `/brand/${asset.name}`);
    const rules = css.trim().split('\n');
    expect(rules.filter((rule) => rule.startsWith('@font-face{'))).toHaveLength(4);
    expect(rules.slice(4).map((rule) => rule.replace(/\{.*/, ''))).toEqual([':root:root', '@media (prefers-color-scheme: dark)']);
    for (const declaration of css.match(/--[a-z-]+:/g) ?? []) {
      expect(['--font-sans:', '--radius:', ...COLOR_TOKENS.map((token) => `${CSS_VARIABLES[token]}:`)]).toContain(declaration);
    }
    expect(css).not.toMatch(/caution|danger|success|note|visibility|[;{]display/);
    for (const url of css.match(/url\("[^"]+"\)/g) ?? []) expect(url).toMatch(/^url\("\/brand\/[0-9a-f]{16}\.woff2"\)$/);
  });
});

describe('brand.json: neutral brand', () => {
  it('the globals.css defaults match DEFAULT_PALETTES', () => {
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    const [light, dark] = [css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')];
    const block = (from: number) => css.slice(from, css.indexOf('}', css.indexOf('{', from) + 1) + 1);
    const read = (text: string): Partial<Palette> =>
      Object.fromEntries(COLOR_TOKENS.flatMap((token) => {
        const match = new RegExp(`${CSS_VARIABLES[token]}: (#[0-9a-f]{6});`).exec(text);
        return match ? [[token, match[1]]] : [];
      }));
    expect(read(block(light))).toEqual(DEFAULT_PALETTES.light);
    expect(read(css.slice(dark, css.indexOf('}', css.indexOf('}', dark) + 1)))).toEqual(DEFAULT_PALETTES.dark);
  });

  it('meets AA on every text and button pair', () => {
    for (const palette of Object.values(DEFAULT_PALETTES)) {
      for (const [foreground, ground] of [['text', 'background'], ['text', 'surface'], ['muted', 'background'], ['muted', 'surface'], ['accentText', 'accent'], ['accentInk', 'surface'], ['accentInk', 'background']] as const) {
        expect(contrastRatio(palette[foreground], palette[ground]), `${foreground} on ${ground}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    }
  });
});

describe('brand.json: validation', () => {
  it('a minimal brand: only the accent, and the rest from the neutral brand', () => {
    const dir = brandDir({ logo: undefined, font: undefined, colors: { light: { accent: '#0b6e4f' } } });
    const { brand, issues } = loadBrand(dir);
    expect(issues).toEqual([]);
    expect(brand.palettes.light).toMatchObject({ accent: '#0b6e4f', accentText: '#ffffff', background: DEFAULT_PALETTES.light.background });
    // Without a dark palette, dark mode uses the neutral one with the same accent.
    expect(brand.palettes.dark.accent).toBe('#0b6e4f');
    expect(brand.palettes.dark.background).toBe(DEFAULT_PALETTES.dark.background);
    expect(contrastRatio(brand.palettes.dark.accentInk, brand.palettes.dark.surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it('text and button pairs without AA contrast are an error naming the field, the colors and the contrast', () => {
    const dir = brandDir({ colors: { light: { muted: '#9aa59f', accent: '#fca311', accentText: '#ffffff' }, dark: { text: '#3a3f47' } } });
    expect(issuesOf(dir).sort()).toEqual(['brand.json:colors.dark.text', 'brand.json:colors.dark.text', 'brand.json:colors.light.accentText', 'brand.json:colors.light.muted', 'brand.json:colors.light.muted']);
    expect(reasonsOf(dir)).toContain('brand.json:colors.light.accentText contrast 2.02:1 on accent (#ffffff on #fca311); the minimum is 4.5:1');
    // With errors, the brand is the neutral one.
    expect(loadBrand(dir).brand.custom).toBe(false);
  });

  it('an explicit ink must also reach AA; the derived one always does', () => {
    expect(issuesOf(brandDir({ colors: { light: { accentInk: '#fca311' } } }))).toEqual(['brand.json:colors.light.accentInk', 'brand.json:colors.light.accentInk']);
    for (const accent of ['#fca311', '#ffe600', '#00b3ff', '#ff3b30', '#111111', '#f9fafb']) {
      const ink = deriveInk(accent, ['#ffffff', '#f3f4f6']);
      expect(ink, accent).not.toBeNull();
      expect(contrastRatio(ink as string, '#ffffff')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(contrastRatio(ink as string, '#f3f4f6')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it('an accent with the danger or caution hue is rejected; the example brand accent and a green are not', () => {
    expect(reasonsOf(brandDir({ colors: { light: { accent: '#d92626', accentText: '#ffffff' } } }))).toEqual([
      'brand.json:colors.light.accent hue 0° (#d92626) too close to the danger hue; security warnings have their own scale and the accent must not be confused with it',
      'brand.json:colors.dark.accent hue 0° (#d92626) too close to the danger hue; security warnings have their own scale and the accent must not be confused with it',
    ]);
    expect(issuesOf(brandDir({ colors: { light: { accent: '#eab308' }, dark: { accent: '#fca311' } } }))).toEqual(['brand.json:colors.light.accent']);
    for (const accent of ['#4f46e5', '#fca311', '#1f7a4d', '#2f3d55', '#7c3aed']) expect(signalClash(accent), accent).toBeNull();
    // A barely saturated reddish gray is not mistaken for anything.
    expect(signalClash('#6b5a5a')).toBeNull();
  });

  it('tokens only: CSS, markup, texts or unknown keys are rejected', () => {
    const dir = brandDir({ css: 'body{display:none}', colors: { light: { caution: '#fca311' }, sepia: {} }, font: { family: 'Brand', files: [{ path: 'fonts/regular.woff2' }], css: 'x' }, texts: { warning: '' } });
    expect(issuesOf(dir).sort()).toEqual(['brand.json:colors.light.caution', 'brand.json:colors.sepia', 'brand.json:css', 'brand.json:font.css', 'brand.json:texts']);
    expect(reasonsOf(dir)).toContain('brand.json:css unsupported key. brand.json only accepts tokens: no CSS, no markup, no flow text');
  });

  it.each([
    ['named color', { colors: { light: { accent: 'red' } } }, 'colors.light.accent'],
    ['color trying to close the rule', { colors: { light: { accent: '#ffffff;}body{display:none' } } }, 'colors.light.accent'],
    ['short color', { colors: { dark: { text: '#fff' } } }, 'colors.dark.text'],
    ['decimal radius', { radius: 4.5 }, 'radius'],
    ['huge radius', { radius: 999 }, 'radius'],
    ['family trying to close the rule', { font: { family: 'Brand";}body{x:"', files: [{ path: 'fonts/regular.woff2' }] } }, 'font.family'],
    ['font without files, from a CDN', { font: { family: 'Inter' } }, 'font.files'],
    ['invalid font weight', { font: { family: 'Brand', files: [{ path: 'fonts/regular.woff2', weight: 450 }] } }, 'font.files[0].weight'],
    ['empty name', { name: '  ' }, 'name'],
    ['name too long', { name: 'x'.repeat(65) }, 'name'],
    ['name with control characters', { name: 'Brand\u0007' }, 'name'],
    ['no version', { version: undefined }, 'version'],
    ['http link', { links: { support: 'http://help.example.test' } }, 'links.support'],
    ['javascript: link', { links: { privacy: 'javascript:alert(1)' } }, 'links.privacy'],
    ['link with credentials', { links: { terms: 'https://u:p@example.test' } }, 'links.terms'],
    ['relative link', { links: { support: '/help' } }, 'links.support'],
  ])('rejects %s', (_name, brand, field) => {
    expect(issuesOf(brandDir(brand))).toEqual([`brand.json:${field}`]);
  });

  it('an http link to a local host only with the testing exception', () => {
    const dir = brandDir({ links: { support: 'http://help.localhost:3000/' } });
    expect(issuesOf(dir)).toEqual(['brand.json:links.support']);
    expect(issuesOf(dir, true)).toEqual([]);
  });
});

describe('brand.json: files', () => {
  it.each([
    ['../brand.json', 'must be a relative path'],
    ['../../../../etc/passwd.svg', 'must be a relative path'],
    ['/etc/passwd.svg', 'must be a relative path'],
    ['fonts/../logo.svg', 'must be a relative path'],
    ['.hidden.svg', 'must be a relative path'],
    ['logo\\..\\x.svg', 'must be a relative path'],
    ['logo.html', 'unsupported extension'],
    ['brand.json', 'unsupported extension'],
    ['missing.svg', 'does not exist'],
  ])('rejects the path %j', (path, reason) => {
    const [issue] = loadBrand(brandDir({ logo: path })).issues;
    expect(issue.variable).toBe('brand.json:logo');
    expect(issue.reason).toContain(reason);
  });

  it('a symlink that leaves the directory is rejected; one that stays inside is not', () => {
    const outside = join(root, 'outside.svg');
    writeFileSync(outside, LOGO);
    const dir = brandDir();
    symlinkSync(outside, join(dir, 'outside.svg'));
    symlinkSync(join(dir, 'logo.svg'), join(dir, 'inside.svg'));
    expect(reasonsOf(brandDir({ logo: 'outside.svg' }))).toEqual(['brand.json:logo does not exist']);
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ version: 1, logo: 'outside.svg' }));
    expect(reasonsOf(dir)).toEqual(['brand.json:logo points outside the brand directory']);
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ version: 1, logo: 'inside.svg' }));
    expect(reasonsOf(dir)).toEqual([]);
  });

  it('each type has a maximum size, and the brand a total one', () => {
    const big = new Uint8Array(257 * 1024);
    expect(reasonsOf(brandDir({ logo: 'large.svg' }, { 'large.svg': big }))).toEqual(['brand.json:logo exceeds the maximum of 256 KB']);
    expect(reasonsOf(brandDir({ favicon: 'icon.ico' }, { 'icon.ico': new Uint8Array(65 * 1024) }))).toEqual(['brand.json:favicon exceeds the maximum of 64 KB']);
    const fonts = Array.from({ length: 8 }, (_, index) => `f${index}.ttf`);
    const font = new Uint8Array(512 * 1024);
    font.set([0, 1, 0, 0]);
    const dir = brandDir({ font: { family: 'Brand', files: fonts.map((path) => ({ path })) } }, Object.fromEntries(fonts.map((path) => [path, font])));
    expect(reasonsOf(dir)).toEqual(['brand.json:logo the brand exceeds the total maximum of 4 MB']);
  });

  it('the content must be what the extension says', () => {
    expect(reasonsOf(brandDir({ logo: 'logo.png' }, { 'logo.png': LOGO }))).toEqual(['brand.json:logo is not a valid png file']);
    expect(reasonsOf(brandDir({ font: { family: 'Brand', files: [{ path: 'fake.woff2' }] } }, { 'fake.woff2': 'hello' }))).toEqual(['brand.json:font.files[0].path is not a valid woff2 file']);
    expect(reasonsOf(brandDir({ logo: 'text.svg' }, { 'text.svg': 'not an svg' }))).toEqual(['brand.json:logo is not an SVG']);
  });

  it.each([
    ['<script>', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>x</p></foreignObject></svg>'],
    ['a remote image', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://foreign.test/x.png"/></svg>'],
    ['a remote url()', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://foreign.test/p)"/></svg>'],
    ['an entity', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['javascript:', '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><rect/></a></svg>'],
  ])('an SVG with %s is rejected', (_name, svg) => {
    const [issue] = loadBrand(brandDir({ logo: 'bad.svg' }, { 'bad.svg': svg })).issues;
    expect(issue.variable).toBe('brand.json:logo');
  });

  it('no directory, no brand.json, invalid or oversized JSON', () => {
    expect(issuesOf(join(root, 'missing'))).toEqual(['VAULT_BRAND_DIR']);
    const empty = mkdtempSync(join(root, 'empty-'));
    expect(reasonsOf(empty)).toEqual(['brand.json is missing from the brand directory']);
    writeFileSync(join(empty, 'brand.json'), '{ "version": 1, ');
    expect(reasonsOf(empty)).toEqual(['brand.json is not valid JSON']);
    writeFileSync(join(empty, 'brand.json'), JSON.stringify({ version: 1, name: 'x'.repeat(70 * 1024) }));
    expect(reasonsOf(empty)).toEqual(['brand.json exceeds the maximum of 64 KB']);
  });

  it('public names are the content fingerprint', () => {
    const { brand } = loadBrand(EXAMPLE_BRAND);
    for (const asset of [...brand.fonts.map((font) => font.asset), brand.logo!.light, brand.favicon!]) expect(asset.name).toMatch(BRAND_ASSET_NAME);
    expect(new Set(brand.fonts.map((font) => font.asset.name)).size).toBe(4);
  });
});

describe('brand name: precedence', () => {
  const before = { ...process.env };
  afterEach(() => {
    process.env = { ...before };
    resetBrandCache();
  });

  it('VAULT_BRAND_NAME, then the name in brand.json, otherwise "Vault"', () => {
    resetBrandCache();
    delete process.env.VAULT_BRAND_DIR;
    delete process.env.VAULT_BRAND_NAME;
    expect(brandName()).toBe('Vault');
    expect(currentBrand().custom).toBe(false);

    resetBrandCache();
    process.env.VAULT_BRAND_DIR = EXAMPLE_BRAND;
    expect(brandName()).toBe('Acme Wallet');
    expect(publicRuntimeConfig().brand).toBe('Acme Wallet');
    process.env.VAULT_BRAND_NAME = 'My wallet';
    expect(brandName()).toBe('My wallet');
    expect(currentBrand().logo).not.toBeNull();
  });
});

describe('build-static-recovery with --brand-dir', () => {
  const run = (out: string, ...extra: string[]) =>
    spawnSync(process.execPath, ['scripts/build-static-recovery.mjs', '--rp-id', 'vault.example.test', '--manifest-pubkey', 'ab'.repeat(32), '--out', out, ...extra], { encoding: 'utf8' });

  it('takes the brand from the same brand.json, with its files next to the HTML, and the CSP only allows its own origin', () => {
    const out = join(root, 'static');
    const result = run(out, '--brand-dir', EXAMPLE_BRAND);
    expect(result.status, result.stderr).toBe(0);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="./brand.css">');
    expect(html).toMatch(/<img class="brand-logo" src="\.\/brand-[0-9a-f]{16}\.svg" alt=""\/>/);
    expect(html).toContain('data-brand="Acme Wallet"');
    expect(html).toContain("img-src 'self'; font-src 'self'");
    expect(html).toContain("connect-src 'none'");
    const files = readdirSync(out);
    expect(files.filter((name) => name.endsWith('.woff2'))).toHaveLength(4);
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toContain('  brand.css');
    expect(readFileSync(join(out, 'brand.css'), 'utf8')).toMatch(/url\("\.\/brand-[0-9a-f]{16}\.woff2"\)/);

    // Same brand.json, same bytes.
    const again = join(root, 'static-2');
    expect(run(again, '--brand-dir', EXAMPLE_BRAND).status).toBe(0);
    expect(readFileSync(join(again, 'SHA256SUMS'), 'utf8')).toBe(readFileSync(join(out, 'SHA256SUMS'), 'utf8'));
  });

  it('without a brand, the neutral one; --brand replaces the name and is escaped', () => {
    const out = join(root, 'static-neutral');
    expect(run(out, '--brand', 'My "wallet" <x>').status).toBe(0);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toContain('brand.css');
    expect(html).toContain('data-brand="My &quot;wallet&quot; &lt;x&gt;"');
    expect(html).toContain('<span class="brand-name">My &quot;wallet&quot; &lt;x&gt;</span>');
  });

  it('an invalid brand generates nothing', () => {
    const dir = brandDir({ colors: { light: { muted: '#cccccc' } } });
    const result = run(join(root, 'static-bad'), '--brand-dir', dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid brand: brand.json:colors.light.muted contrast');
    expect(() => execFileSync('ls', [join(root, 'static-bad')], { stdio: 'pipe' })).toThrow();
  });
});
