import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '../../app/brand/[file]/route';
import { brandFiles, currentBrand, resetBrandCache } from '../../server/brand';

const EXAMPLE_BRAND = resolve('../../brands/example');
const get = (file: string) => GET(new Request(`http://vault.test/brand/${encodeURIComponent(file)}`), { params: Promise.resolve({ file }) });

describe('GET /brand/[file]', () => {
  const before = { ...process.env };
  beforeAll(() => {
    process.env.VAULT_BRAND_DIR = EXAMPLE_BRAND;
    resetBrandCache();
  });
  afterAll(() => {
    process.env = before;
    resetBrandCache();
  });

  it('serves each brand file by its fingerprint, with its type, nosniff, immutable caching and a sandbox CSP', async () => {
    const brand = currentBrand();
    const assets = [...brandFiles(brand), brand.stylesheet!];
    expect(assets.map((asset) => asset.contentType).sort()).toEqual(['font/woff2', 'font/woff2', 'font/woff2', 'font/woff2', 'image/svg+xml', 'image/svg+xml', 'text/css; charset=utf-8']);
    for (const asset of assets) {
      const response = await get(asset.name);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(asset.contentType);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(response.headers.get('content-security-policy')).toMatch(/^default-src 'none';.*sandbox$/);
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(asset.bytes))).toBe(true);
    }
    const svg = await get(brand.logo!.light.name);
    // The SVG opened directly: no scripts and nothing external.
    expect(svg.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });

  it.each([
    'brand.json',
    'logo.svg',
    'fonts/Inter-Regular.woff2',
    '../brand.json',
    '..%2Fbrand.json',
    '../../../../etc/passwd',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '0000000000000000.svg',
    '0000000000000000.html',
    '',
  ])('%j is a 404, without touching the disk', async (file) => {
    const response = await get(file);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('Not found.');
  });

  it('a valid fingerprint in uppercase, or with another extension, is not the same file', async () => {
    const { name } = currentBrand().logo!.light;
    expect((await get(name.toUpperCase())).status).toBe(404);
    expect((await get(name.replace('.svg', '.css'))).status).toBe(404);
  });

  it('a file changed on disk after startup is not served: the brand is read once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-brand-route-'));
    try {
      writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
      writeFileSync(join(dir, 'brand.json'), JSON.stringify({ version: 1, logo: 'logo.svg' }));
      process.env.VAULT_BRAND_DIR = dir;
      resetBrandCache();
      const { name, bytes } = currentBrand().logo!.light;
      writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
      const response = await get(name);
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      process.env.VAULT_BRAND_DIR = EXAMPLE_BRAND;
      resetBrandCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with the neutral brand there are no files', async () => {
    delete process.env.VAULT_BRAND_DIR;
    resetBrandCache();
    try {
      expect(currentBrand().stylesheet).toBeNull();
      expect((await get('0123456789abcdef.css')).status).toBe(404);
    } finally {
      process.env.VAULT_BRAND_DIR = EXAMPLE_BRAND;
      resetBrandCache();
    }
  });
});
