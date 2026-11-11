import { existsSync, readFileSync } from 'node:fs';
import { mnemonicToAccount } from 'viem/accounts';
import { expect, test, type Harness } from '../support/harness.ts';

/** Records the messages the app receives. That is what the SDK would see and what an XSS could read. */
async function recordAppMessages(h: Harness): Promise<void> {
  await h.app.evaluate(() => {
    const store: string[] = [];
    (window as unknown as { __messages: string[] }).__messages = store;
    window.addEventListener('message', (event) => store.push(JSON.stringify(event.data)));
  });
}

const appMessages = (h: Harness) => h.app.evaluate(() => (window as unknown as { __messages: string[] }).__messages);

async function assertSeedAbsent(h: Harness, seed: string): Promise<void> {
  const firstWords = seed.split(' ').slice(0, 3).join(' ');
  for (const page of [h.app, h.popup]) {
    const content = await page.content();
    const text = await page.locator('body').innerText();
    expect(content.includes(seed) || content.includes(firstWords)).toBe(false);
    expect(text.includes(firstWords)).toBe(false);
    const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(storage.includes(firstWords)).toBe(false);
  }
  expect(h.consoleLines.join('\n').includes(firstWords)).toBe(false);
  await h.trafficSettled();
  const leaked = h.traffic.filter(({ url, body }) => url.includes(firstWords) || body.includes(firstWords));
  expect(leaked.map(({ url }) => url)).toEqual([]);
}

test.describe('F · seed export', () => {
  test('on activation: optional, requires confirmation and the passkey, and the seed never leaves the file', async ({ h }) => {
    h.captureResponseBodies();
    const account = await h.activate(await h.register());

    // Nothing is downloaded unless asked for: it is optional and requires ticking the checkbox.
    await expect(h.P('export-warning')).toBeVisible();
    await expect(h.P('export-start')).toBeDisabled();
    await expect(h.P('export-already')).toHaveCount(0);
    await h.P('export-confirm').check();
    await expect(h.P('export-start')).toBeEnabled();

    // If the user cancels the passkey, there is no seed.
    await h.refusePasskey();
    let downloads = 0;
    const count = () => void (downloads += 1);
    h.popup.on('download', count);
    await h.P('export-start').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'CANCELLED');
    expect(downloads).toBe(0);
    await expect(h.P('export-done')).toHaveCount(0);
    h.popup.off('download', count);
    await h.allowPasskey();

    // The export really goes through the passkey.
    const assertions: unknown[] = [];
    h.cdp.on('WebAuthn.credentialAsserted', (event) => assertions.push(event));

    // Capture control: the recorded traffic includes the API responses.
    await h.trafficSettled();
    expect(h.traffic.some(({ method, url }) => method === 'RESPONSE' && url.includes('/api/shares'))).toBe(true);

    const downloading = h.popup.waitForEvent('download');
    await h.P('export-start').click();
    const download = await downloading;
    expect(assertions).toHaveLength(1);
    expect(download.suggestedFilename()).toMatch(/^wl-embedded-wallet-seed-[0-9a-f]{8}\.txt$/);
    const path = await download.path();
    const text = readFileSync(path, 'utf8');
    const seed = text.split('\n').find((line) => line.trim().split(/\s+/).length === 12) as string;
    expect(seed).toBe(account.seed);
    expect(mnemonicToAccount(seed).address).toBe(account.owner);
    expect(text).toContain(account.owner);

    await expect(h.P('export-done')).toBeVisible();
    await expect(h.P('export-already')).toBeVisible();
    await expect(h.P('export-confirm')).not.toBeChecked();
    await assertSeedAbsent(h, seed);

    await download.delete();
    expect(existsSync(path)).toBe(false);
  });

  test('from the app: the result only carries addresses and is recorded', async ({ h }) => {
    h.captureResponseBodies();
    const account = await h.activate(await h.register());
    await recordAppMessages(h);

    await h.T('export-button').click();
    await h.P('export-confirm').check();
    const downloading = h.popup.waitForEvent('download');
    await h.P('export-start').click();
    const download = await downloading;
    const path = await download.path();
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(account.seed);
    await h.P('export-done').waitFor();
    await expect(h.T('action-success')).toBeVisible();

    const messages = await appMessages(h);
    const result = messages.map((message) => JSON.parse(message)).find((message) => message.type === 'result');
    expect(result).toMatchObject({ ok: true, address: account.safe, owner: account.owner });
    expect(Object.keys(result).sort()).toEqual(['address', 'id', 'ok', 'owner', 'protocol', 'type']);
    expect(messages.join('\n')).not.toContain(account.seed);
    await assertSeedAbsent(h, account.seed);

    await download.delete();
    expect(existsSync(path)).toBe(false);

    // The next time, the vault shows that it was already exported.
    await h.T('export-button').click();
    await expect(h.P('export-already')).toBeVisible();
  });

  test('without a wallet, the app receives NO_WALLET instead of waiting for the popup to close', async ({ h }) => {
    await h.register();
    expect(await h.direct('export', { kind: 'export' })).toMatchObject({ ok: false, code: 'NO_WALLET' });
  });
});
