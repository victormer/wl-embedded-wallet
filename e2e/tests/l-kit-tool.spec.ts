import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { RECOVERY_TOOL_DIST, ROOT, VAULT } from '../support/env.ts';
import { expect, test, type Harness, type Kit } from '../support/harness.ts';

const TOOL = resolve(RECOVERY_TOOL_DIST, 'wl-embedded-wallet-recovery.html');
const CLI = resolve(RECOVERY_TOOL_DIST, 'wl-embedded-wallet-recovery.mjs');
const NO_NETWORK = resolve(ROOT, 'packages/recovery-tool/tests/no-network.mjs');

function flipB64(value: string): string {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

const oldKit = (kit: Kit): Kit => {
  const { seedBackup: _backup, ...rest } = kit;
  return { ...rest, v: 1 };
};

/** Opens the tool from `file://`, as someone who has it saved would. */
async function openTool(h: Harness, path = TOOL): Promise<{ page: Page; requests: string[] }> {
  const page = await h.context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(pathToFileURL(path).href);
  await page.getByTestId('offline-tool').waitFor();
  return { page, requests };
}

async function submitTool(page: Page, kit: unknown, code: string): Promise<void> {
  await page.getByTestId('offline-kit-file').setInputFiles({ name: 'kit.json', mimeType: 'application/json', buffer: Buffer.from(typeof kit === 'string' ? kit : JSON.stringify(kit)) });
  await page.getByTestId('offline-code').fill(code);
  await page.getByTestId('offline-submit').click();
}

async function expectToolError(page: Page, kit: unknown, code: string, expected: string): Promise<void> {
  await submitTool(page, kit, code);
  await expect(page.getByTestId('offline-error'), `expected ${expected}`).toHaveAttribute('data-code', expected);
  await expect(page.getByTestId('offline-result')).toBeHidden();
  await expect(page.getByTestId('offline-seed')).toBeHidden();
}

async function expectToolRecovers(page: Page, kit: unknown, code: string, safe: string, owner: string, seed: string): Promise<void> {
  await submitTool(page, kit, code);
  await expect(page.getByTestId('offline-verdict')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('offline-owner')).toHaveText(owner);
  await expect(page.getByTestId('offline-owner-check')).toHaveAttribute('data-matches', 'true');
  await expect(page.getByTestId('offline-safe')).toHaveText(safe);
  await expect(page.getByTestId('offline-safe-check')).toHaveAttribute('data-matches', 'true');
  // Only after an explicit action.
  await expect(page.getByTestId('offline-seed')).toBeHidden();
  expect(await page.content()).not.toContain(seed);
  await page.getByTestId('offline-reveal').click();
  await expect(page.getByTestId('offline-seed')).toHaveText(seed);
  await page.getByTestId('offline-hide').click();
  await expect(page.getByTestId('offline-seed')).toBeHidden();
  expect(await page.content()).not.toContain(seed);
}

function runCli(kitPath: string, code: string, flags: string[] = []) {
  return spawnSync(process.execPath, ['--import', NO_NETWORK, CLI, kitPath, '--code-stdin', ...flags], { input: `${code}\n`, encoding: 'utf8' });
}

test.describe('L · kit with seed backup and offline tool', () => {
  test('the backup never leaves the browser, and neither does the plaintext seed', async ({ h }) => {
    h.captureResponseBodies();
    const account = await h.activate(await h.register());
    await h.trafficSettled();
    const { kit, seed } = account;
    expect(kit.v).toBe(2);
    const backup = kit.seedBackup!;

    // The tool is downloaded during activation and its code mentions `seedBackup`. It is exactly the public build,
    // byte for byte, so it carries nothing from the user and only that response is excluded.
    const isTool = ({ method, url }: { method: string; url: string }) => method === 'RESPONSE' && new URL(url).pathname === '/recovery-tool';
    const tool = h.traffic.filter(isTool);
    expect(tool).toHaveLength(1);
    expect(tool[0].body).toBe(readFileSync(TOOL, 'utf8'));
    const sent = h.traffic
      .filter((entry) => !isTool(entry))
      .map(({ url, body }) => `${url}\n${body}`)
      .join('\n');
    // Control: the capture sees all activation traffic, including what the worker sends, and B and C do travel.
    expect(h.traffic.some(({ method, url }) => method === 'POST' && url.endsWith('/api/shares'))).toBe(true);
    expect(sent).toContain(kit.encC.ct);
    expect(sent).toContain(kit.encB.ct);

    for (const value of [backup.ct, backup.salt, backup.iv]) expect(sent).not.toContain(value);
    expect(sent).not.toContain('seedBackup');
    expect(sent).not.toContain(seed);
    expect(sent).not.toContain(seed.split(' ').slice(0, 3).join(' '));

    // The kit carries the encrypted backup, with its own salt and nonce, never the plaintext seed.
    expect(JSON.stringify(kit)).not.toContain(seed);
    expect(backup.salt).not.toBe(kit.encC.salt);
    expect(backup.kdfParams).toEqual(kit.encC.kdfParams);

    // The server does not have it to return.
    const stored = await h.popup.evaluate(async (appOrigin) => (await fetch('/api/shares', { headers: { 'X-Vault-App-Origin': appOrigin } })).text(), new URL(h.app.url()).origin);
    expect(stored).toContain(kit.encC.ct);
    expect(stored).not.toContain(backup.ct);
    expect(stored).not.toContain('seedBackup');
  });

  test('worst case: with no backend or network, kit and code recover the seed from file:// and with the CLI', async ({ h }) => {
    const account = await h.activate(await h.register());
    const dir = mkdtempSync(join(tmpdir(), 'tool-'));
    try {
      // It is downloaded before the service disappears, and it is exactly the reproducible build.
      const tool = await h.downloadTool(dir);
      const downloaded = readFileSync(tool.path);
      expect(tool.hash).toBe(createHash('sha256').update(downloaded).digest('hex'));
      expect(readFileSync(resolve(RECOVERY_TOOL_DIST, 'SHA256SUMS'), 'utf8')).toContain(`${tool.hash}  wl-embedded-wallet-recovery.html`);

      const kitPath = join(dir, 'kit.json');
      writeFileSync(kitPath, JSON.stringify(account.kit));

      await h.context.route((url) => url.protocol !== 'file:', (route) => route.abort());
      await h.context.setOffline(true);
      const { page, requests } = await openTool(h, tool.path);
      await expectToolError(page, account.kit, `${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`, 'DECRYPT_FAILED');
      await expectToolRecovers(page, account.kit, account.recovery, account.safe, account.owner, account.seed);
      expect(requests.every((url) => url.startsWith('file:'))).toBe(true);
      expect(requests).toHaveLength(1);
      await page.close();

      const plain = runCli(kitPath, account.recovery);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain(`Owner: ${account.owner} (matches the kit)`);
      expect(plain.stdout).toContain(`Safe: ${account.safe} (matches the kit)`);
      expect(plain.stdout + plain.stderr).not.toContain(account.seed);
      const shown = runCli(kitPath, account.recovery, ['--show-seed']);
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain(`Seed: ${account.seed}`);
    } finally {
      await h.context.unroute((url) => url.protocol !== 'file:').catch(() => undefined);
      await h.context.setOffline(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the tool CSP blocks any outbound traffic, even with network', async ({ h }) => {
    h.tolerate(/Content Security Policy/);
    const { page } = await openTool(h);
    const answered: string[] = [];
    page.on('response', (response) => answered.push(response.url()));
    const outcome = await page.evaluate(async (target) => {
      const blocked: string[] = [];
      document.addEventListener('securitypolicyviolation', (event) => blocked.push(event.violatedDirective));
      const viaFetch = await fetch(`${target}/api/health`).then(() => 'escaped', () => 'blocked');
      const image = new Image();
      image.src = `${target}/leak.png`;
      await new Promise((done) => setTimeout(done, 200));
      return { viaFetch, blocked };
    }, VAULT);
    expect(outcome.viaFetch).toBe('blocked');
    expect(outcome.blocked).toEqual(expect.arrayContaining(['connect-src', 'img-src']));
    // Chromium reports the image before blocking it: what matters is that nothing got a response.
    expect(answered).toEqual([]);
  });

  test('wrong code, tampered kit, a kit from another user and an old kit: it says so and gives nothing', async ({ h }) => {
    const first = await h.activate(await h.register());
    await h.logout();
    const second = await h.activate(await h.register());
    const { page } = await openTool(h);
    const { kit, recovery } = first;
    const backup = kit.seedBackup!;

    await expectToolRecovers(page, kit, recovery, first.safe, first.owner, first.seed);
    await expectToolError(page, kit, second.recovery, 'DECRYPT_FAILED');
    await expectToolError(page, kit, 'ABC', 'BAD_RECOVERY_CODE');
    await expectToolError(page, second.kit, recovery, 'DECRYPT_FAILED');
    await expectToolError(page, { ...kit, seedBackup: { ...backup, ct: flipB64(backup.ct) } }, recovery, 'DECRYPT_FAILED');
    await expectToolError(page, { ...kit, seedBackup: { ...backup, salt: flipB64(backup.salt) } }, recovery, 'DECRYPT_FAILED');
    await expectToolError(page, { ...kit, seedBackup: second.kit.seedBackup }, second.recovery, 'DECRYPT_FAILED');
    await expectToolError(page, { ...kit, manifest: { ...kit.manifest, expectedAddress: second.owner } }, recovery, 'DECRYPT_FAILED');
    await expectToolError(page, { ...kit, seedBackup: { ...backup, kdfParams: { ...backup.kdfParams, memorySize: 4_000_000 } } }, recovery, 'KDF_PARAMS_INVALID');
    await expectToolError(page, '{"v":2}', recovery, 'INVALID_KIT');

    await expectToolError(page, oldKit(kit), recovery, 'NO_SEED_BACKUP');
    await expect(page.getByTestId('offline-error')).toContainText('kit is old');

    // The kit's Safe does not derive from this owner: decryption works, but the seed is not offered.
    await submitTool(page, { ...kit, manifest: { ...kit.manifest, smartAccount: { ...kit.manifest.smartAccount, address: second.safe } } }, recovery);
    await expect(page.getByTestId('offline-verdict')).toHaveAttribute('data-state', 'mismatch');
    await expect(page.getByTestId('offline-verdict')).toContainText('MISMATCH');
    await expect(page.getByTestId('offline-safe-check')).toHaveAttribute('data-matches', 'false');
    await expect(page.getByTestId('offline-owner-check')).toHaveAttribute('data-matches', 'true');
    await expect(page.getByTestId('offline-reveal')).toBeHidden();
    expect(await page.content()).not.toContain(first.seed);
  });

  test('kit and code in the vault, without passkey: it can operate and export', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.context.clearCookies();
    await h.openStandaloneRecover();
    await h.recoverWithKit(account.kit, `${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`);
    await h.P('recover-backup-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'DECRYPT_FAILED');

    const from = h.traffic.length;
    await h.refusePasskey();
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-backup-submit').click();
    await h.P('done-panel').waitFor();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
    await expect(h.P('wallet-owner')).toHaveText(account.owner);
    await h.P('recovered-export-confirm').check();
    const text = await h.nextDownload(() => h.P('recovered-export-start').click());
    expect(text).toContain(account.seed);
    expect(h.apiRequests(from)).toEqual([]);
  });

  test('wallet with an old kit: generates a new one with A+B and with B+C, asking for the code', async ({ h }) => {
    const account = await h.activate(await h.register());
    const old = oldKit(account.kit);
    const wrongCode = `${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`;

    await test.step('A+B, from unlock', async () => {
      await h.T('unlock-button').click();
      await h.P('unlock-start').click();
      await h.P('kit-upgrade').waitFor();
      await h.P('kit-upgrade-code').fill(wrongCode);
      await expect(h.P('kit-upgrade-start')).toBeDisabled();
      await h.downloadToolStep();
      await h.P('kit-upgrade-start').click();
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'DECRYPT_FAILED');
      await expect(h.P('kit-upgrade-done')).toHaveCount(0);

      await h.P('kit-upgrade-code').fill(account.recovery);
      const fresh = JSON.parse(await h.nextDownload(() => h.P('kit-upgrade-start').click())) as Kit;
      await h.P('kit-upgrade-done').waitFor();
      expect(fresh.v).toBe(2);
      expect(fresh.manifest.setId).toBe(account.kit.manifest.setId);
      expect(fresh.seedBackup?.salt).not.toBe(account.kit.seedBackup?.salt);
      const { page } = await openTool(h);
      await expectToolRecovers(page, fresh, account.recovery, account.safe, account.owner, account.seed);
      await page.close();
    });

    await test.step('B+C, with the old kit', async () => {
      await h.openStandaloneRecover();
      await h.recoverWithKit(old, account.recovery);
      await h.P('kit-old').waitFor();
      await expect(h.P('recover-backup-submit')).toHaveCount(0);
      await h.P('recover-bc-submit').click();
      await h.P('done-panel').waitFor();
      await h.P('kit-upgrade-code').fill(account.recovery);
      await expect(h.P('kit-upgrade-start')).toBeDisabled();
      await h.downloadToolStep();
      const fresh = JSON.parse(await h.nextDownload(() => h.P('kit-upgrade-start').click())) as Kit;
      expect(fresh.v).toBe(2);
      const { page } = await openTool(h);
      await expectToolRecovers(page, fresh, account.recovery, account.safe, account.owner, account.seed);
    });
  });

  test('after rotating, the old kit still opens with the old code: this is the documented limit', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await h.P('re-enroll-start').click();
    const { kit, recovery } = await h.enrollSteps();
    await h.P('re-enrolled').waitFor();
    await expect(h.P('re-enrolled')).toContainText('old kit still opens');
    expect(kit.v).toBe(2);

    const { page } = await openTool(h);
    await expectToolRecovers(page, kit, recovery, account.safe, account.owner, account.seed);
    await expectToolRecovers(page, account.kit, account.recovery, account.safe, account.owner, account.seed);
    await expectToolError(page, account.kit, recovery, 'DECRYPT_FAILED');
    await expectToolError(page, kit, account.recovery, 'DECRYPT_FAILED');
  });

  test('the tool and the warning are offered during activation, before downloading the kit', async ({ h }) => {
    await h.register();
    await h.openPopup(() => h.T('activate-button').click());
    await h.P('passkey-create').click();
    await h.P('recovery-code').waitFor();
    await expect(h.P('step-code')).toContainText('Whoever has your kit and your code gets your seed');
    const recovery = await h.P('recovery-code').innerText();
    h.registerSecret(recovery);
    await h.P('code-saved').click();
    const groups = recovery.split('-');
    for (const input of await h.popup.locator('[data-group]').all()) await input.fill(groups[Number(await input.getAttribute('data-group'))]);
    await h.P('confirm-submit').click();
    await h.P('kit-download').waitFor();
    await expect(h.P('step-kit')).toContainText('store them separately');
    const dir = mkdtempSync(join(tmpdir(), 'tool-'));
    try {
      const tool = await h.downloadTool(dir);
      expect(tool.hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
