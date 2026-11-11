import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_BRAND_DIR } from './env.ts';

export const TEST_BRAND = {
  name: 'Test brand',
  accent: '#1f7a4d',
  family: 'Test Sans',
  links: { support: 'https://help.example.test/', privacy: 'https://example.test/privacy', terms: 'https://example.test/terms' },
};

const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24"><rect width="24" height="24" rx="6" fill="${fill}"/><rect x="32" y="7" width="84" height="10" rx="5" fill="${fill}"/></svg>`;

/** A brand different from the example one, mounted from an arbitrary directory: used by the second startup. */
export function writeTestBrand(dir: string, overrides: Record<string, unknown> = {}): string {
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'logo.svg'), svg('#1f7a4d'));
  writeFileSync(join(dir, 'logo-dark.svg'), svg('#7fd8a8'));
  writeFileSync(join(dir, 'icon.svg'), svg('#1f7a4d'));
  copyFileSync(join(EXAMPLE_BRAND_DIR, 'fonts/Inter-Bold.woff2'), join(dir, 'fonts/test.woff2'));
  const brand = {
    version: 1,
    name: TEST_BRAND.name,
    colors: {
      light: { accent: TEST_BRAND.accent, accentText: '#ffffff', background: '#f2f7f4', surface: '#ffffff', text: '#0e1a14', muted: '#4d5d55', border: '#d3e2da' },
      dark: { accent: '#7fd8a8', accentText: '#0e1a14', background: '#0c1410', surface: '#14211a', text: '#e8f2ec', muted: '#9db3a7', border: '#26382e' },
    },
    radius: 4,
    font: { family: TEST_BRAND.family, files: [{ path: 'fonts/test.woff2', weight: 400 }] },
    logo: { light: 'logo.svg', dark: 'logo-dark.svg' },
    favicon: 'icon.svg',
    links: TEST_BRAND.links,
    ...overrides,
  };
  writeFileSync(join(dir, 'brand.json'), JSON.stringify(brand, null, 2));
  return dir;
}
