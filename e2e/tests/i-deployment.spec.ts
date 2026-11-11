import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_BRAND, writeTestBrand } from '../support/brand';
import { expect, test } from '../support/harness';
import { IMAGE_MODE, spawnImage } from '../support/image';
import { APP, APP2, HANDOFF_PUBKEY, MANIFEST_PUBKEY, MANIFEST_SIGNING_KEY, ROOT, RP_ID, RUN_DIR, SERVICE_TOKEN, VAULT, VAULT_STANDALONE } from '../support/env';

const SECOND_PORT = 4303;
const SECOND_HOST = 'other.localhost';
const SECOND_ORIGIN = `http://${SECOND_HOST}:${SECOND_PORT}`;
const SECOND_KEY = 'cd'.repeat(32);
const SECOND_PUBKEY = Buffer.from(ed25519.getPublicKey(Buffer.from(SECOND_KEY, 'hex'))).toString('hex');
const BRAND = TEST_BRAND.name;
const EXIT_TIMEOUT_MS = 30_000;

const BASE_ENV = {
  MASTER_KEY: 'ab'.repeat(32),
  MANIFEST_SIGNING_KEY: SECOND_KEY,
  // The alternative without JWKS: a fixed key. The tokens are the same as the demo's.
  HANDOFF_PUBLIC_KEY: HANDOFF_PUBKEY,
  HANDOFF_ISSUER: APP,
  HANDOFF_AUDIENCE: VAULT,
  VAULT_SERVICE_TOKEN: SERVICE_TOKEN,
  ALLOWED_APP_ORIGINS: APP,
  ORIGIN: SECOND_ORIGIN,
  RP_ID: SECOND_HOST,
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'production',
  PORT: String(SECOND_PORT),
  HOSTNAME: '::',
};

// Valid in production except for what each test changes.
const PRODUCTION_ENV = { ...BASE_ENV, ORIGIN: 'https://other.localhost', ALLOWED_APP_ORIGINS: 'https://app.example.test' };

// With `pnpm test:e2e:image`, these tests boot the real image.
function bootVault(env: Record<string, string>) {
  if (IMAGE_MODE) return spawnImage(env, SECOND_PORT);
  // As in the image: the peer-address preload is required in production.
  return spawn(process.execPath, ['--require', join(ROOT, 'apps/vault/scripts/peer-address.cjs'), 'server.js'], { cwd: VAULT_STANDALONE, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Boots and requires it to exit on its own, with an error code. */
function expectExit(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = bootVault(env);
    let output = '';
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The vault started with an invalid configuration'));
    }, EXIT_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

test.describe('I · deployment', () => {
  test('/api/health responds without revealing anything, also from another origin', async () => {
    const response = await fetch(`${VAULT}/api/health`, { headers: { Origin: 'https://foreign.test' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  test('the HTML delivers the public configuration and no secret', async () => {
    const html = await (await fetch(`${VAULT}/recover`)).text();
    expect(html).toContain(`data-rp-id="${RP_ID}"`);
    expect(html).toContain(`data-manifest-pubkey="${MANIFEST_PUBKEY}"`);
    expect(html).not.toContain(MANIFEST_SIGNING_KEY);
    expect(html).not.toContain(SERVICE_TOKEN);
  });

  const invalid: [string, Record<string, string>, string, string][] = [
    ['no database', {}, 'DATABASE_URL', ''],
    ['an invalid master key', { MASTER_KEY: 'invalid-secret-key', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/v' }, 'MASTER_KEY', 'invalid-secret-key'],
    ['SQLite in production', { DATABASE_URL: 'sqlite:/tmp/must-not-be-created.db' }, 'DATABASE_URL', '/tmp/must-not-be-created.db'],
    ['AA_CHAINS that is not JSON', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/v', AA_CHAINS: '{secret' }, 'AA_CHAINS', '{secret'],
  ];
  for (const [name, overrides, variable, value] of invalid) {
    test(`does not start with ${name}, and names the variable without its value`, async () => {
      const { code, output } = await expectExit({ ...PRODUCTION_ENV, ...overrides });
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(output).toContain(variable);
      if (value) expect(output).not.toContain(value);
    });
  }

  test('does not start if the database does not respond, and does not reveal the password', async () => {
    const { code, output } = await expectExit({
      ...PRODUCTION_ENV,
      DATABASE_URL: 'postgres://vault:password-that-must-not-leak@127.0.0.1:1/vault',
    });
    expect(code).not.toBe(0);
    expect(output).toContain('DATABASE_URL');
    expect(output).not.toContain('password-that-must-not-leak');
  });

  test('does not start with a brand lacking AA contrast or containing CSS, and names each field', async () => {
    const dir = writeTestBrand(mkdtempSync(join(tmpdir(), 'vault-bad-brand-')), { css: 'body { display: none }' });
    const brand = JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8'));
    brand.colors.light.muted = '#9aa59f';
    writeFileSync(join(dir, 'brand.json'), JSON.stringify(brand));
    try {
      const { code, output } = await expectExit({ ...PRODUCTION_ENV, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/v', VAULT_BRAND_DIR: dir });
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(output).toContain('brand.json:colors.light.muted contrast');
      expect(output).toContain('brand.json:css unsupported key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same build works with another RP ID, another key and another brand, without rebuilding', async ({ h }) => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-second-'));
    // Another brand, in a mounted directory: with the image, a read-only volume at /brand.
    const brandDir = writeTestBrand(mkdtempSync(join(tmpdir(), 'vault-brand-')));
    const log: string[] = [];
    const second = bootVault({ ...BASE_ENV, ALLOW_INSECURE_LOCAL: '1', DATABASE_URL: `sqlite:${join(dir, 'vault.db')}`, VAULT_BRAND_DIR: brandDir });
    second.stdout!.on('data', (chunk) => log.push(String(chunk)));
    second.stderr!.on('data', (chunk) => log.push(String(chunk)));
    try {
      await expect.poll(() => fetch(`${SECOND_ORIGIN}/api/health`).then((response) => response.status, () => 0), { timeout: 30_000 }).toBe(200);

      const html = await (await fetch(`${SECOND_ORIGIN}/recover`)).text();
      expect(html).toContain(`data-rp-id="${SECOND_HOST}"`);
      expect(html).toContain(`data-manifest-pubkey="${SECOND_PUBKEY}"`);
      expect(html).toContain(BRAND);
      expect(await (await fetch(`${VAULT}/recover`)).text()).not.toContain(BRAND);

      // The brand files are served by the vault itself, by their hash, with safe headers. Nothing else.
      const stylesheet = /<link rel="stylesheet" href="(\/brand\/[0-9a-f]{16}\.css)"/.exec(html)?.[1];
      const logo = /<img class="brand-logo" src="(\/brand\/[0-9a-f]{16}\.svg)"/.exec(html)?.[1];
      expect(stylesheet).toBeDefined();
      expect(logo).toBeDefined();
      const css = await (await fetch(`${SECOND_ORIGIN}${stylesheet}`)).text();
      expect(css).toContain(`--accent:${TEST_BRAND.accent}`);
      expect(css).not.toMatch(/caution|danger|success/);
      const logoResponse = await fetch(`${SECOND_ORIGIN}${logo}`);
      expect(logoResponse.status).toBe(200);
      expect(logoResponse.headers.get('content-type')).toBe('image/svg+xml');
      expect(logoResponse.headers.get('x-content-type-options')).toBe('nosniff');
      expect(logoResponse.headers.get('content-security-policy')).toContain('sandbox');
      for (const path of ['/brand/brand.json', '/brand/logo.svg', '/brand/..%2Fbrand.json', '/brand/..%2F..%2F..%2Fetc%2Fpasswd', `/brand/${'0'.repeat(16)}.svg`]) {
        expect((await fetch(`${SECOND_ORIGIN}${path}`)).status, path).toBe(404);
      }

      // Real enrollment on the second instance: passkey with its RP ID and manifest signed with its key.
      await h.register();
      const opened = h.context.waitForEvent('page');
      const result = h.direct('activate', { kind: 'activate' }, undefined, SECOND_ORIGIN);
      h.popup = await opened;
      await h.addAuthenticator();
      const { recovery, kit } = await h.enrollSteps();
      await h.P('done-panel').waitFor();
      expect(await result).toMatchObject({ ok: true });
      expect(kit.rpId).toBe(SECOND_HOST);
      await expect(h.popup.locator('.brand')).toHaveText(BRAND);

      // Brand tokens in the popup, with the strict CSP; security warnings keep their fixed scale.
      const look = await h.popup.evaluate(async () => {
        await document.fonts.ready;
        const style = (testId: string) => getComputedStyle(document.querySelector(`[data-testid="${testId}"]`) as Element);
        return {
          button: style('back-to-app').backgroundColor,
          font: getComputedStyle(document.body).fontFamily,
          fontLoaded: [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'Test Sans' && face.status === 'loaded'),
          logo: (document.querySelector('.brand-logo') as HTMLImageElement).naturalWidth,
          favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '',
          warning: [style('export-warning').color, style('export-warning').backgroundColor],
          links: [...document.querySelectorAll('[data-testid^="brand-link-"]')].map((link) => (link as HTMLAnchorElement).href),
        };
      });
      expect(look.button).toBe('rgb(31, 122, 77)');
      expect(look.font).toContain(TEST_BRAND.family);
      expect(look.fontLoaded).toBe(true);
      expect(look.logo).toBeGreaterThan(0);
      expect(look.favicon).toMatch(/^\/brand\/[0-9a-f]{16}\.svg$/);
      expect(look.warning).toEqual(['rgb(89, 75, 0)', 'rgb(254, 251, 227)']);
      expect(look.links).toEqual([TEST_BRAND.links.support, TEST_BRAND.links.privacy, TEST_BRAND.links.terms]);

      // This instance has ALLOWED_APP_ORIGINS: a valid token from another origin is rejected.
      const email = h.currentEmail();
      await h.navigateApp(`${APP2}/`);
      await h.login(email);
      await h.T('wallet-empty').waitFor();
      const refused = await h.direct('unlock', { kind: 'unlock' }, undefined, SECOND_ORIGIN);
      expect(refused).toEqual({ protocol: 'wl-embedded-wallet/protocol/v1', type: 'result', id: expect.any(String), ok: false, code: 'ORIGIN_NOT_ALLOWED' });
      await expect(h.P('unlock-start')).toHaveCount(0);

      // The other instance, with its own configuration, does not accept that kit: neither by RP ID nor by key.
      await h.popup.evaluate(() => {
        window.opener = null;
      });
      await h.popup.goto(`${VAULT}/recover`);
      await h.P('recover-bc').waitFor();
      await expect(h.popup.locator('.brand')).toHaveText('Acme Wallet');
      await h.recoverWithKit(kit, recovery);
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'WRONG_RP');
      expect(readFileSync(join(RUN_DIR, 'vault.log'), 'utf8')).not.toContain(recovery);
    } finally {
      second.kill();
      rmSync(dir, { recursive: true, force: true });
      rmSync(brandDir, { recursive: true, force: true });
    }
    expect(log.join('')).not.toContain(SECOND_KEY);
  });
});
