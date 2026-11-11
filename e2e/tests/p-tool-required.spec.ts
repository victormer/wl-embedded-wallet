import type { Download } from '@playwright/test';
import { STATIC_RECOVERY } from '../support/env.ts';
import { expect, test, type Harness, type Kit } from '../support/harness.ts';

const TOOL_ROUTE = '**/recovery-tool';

const oldKit = (kit: Kit): Kit => {
  const { seedBackup: _backup, ...rest } = kit;
  return { ...rest, v: 1 };
};

/** Counts the popup downloads: with the kit locked, none must happen. */
function countDownloads(h: Harness): Download[] {
  const seen: Download[] = [];
  h.popup.on('download', (download) => seen.push(download));
  return seen;
}

/** Two steps in order, the kit step locked, and the reason visible. */
async function expectKitLocked(h: Harness, kitButton: string): Promise<void> {
  const steps = h.P('kit-delivery').locator(':scope > li');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveAttribute('data-testid', 'delivery-tool');
  await expect(steps.nth(1)).toHaveAttribute('data-testid', 'delivery-kit');
  await expect(h.P('delivery-tool')).toContainText('the kit cannot be opened if this service disappears');
  await expect(h.P('delivery-tool')).toHaveAttribute('data-done', 'false');
  await expect(h.P('delivery-kit')).toHaveAttribute('data-locked', 'true');
  await expect(h.P('kit-locked')).toBeVisible();
  await expect(h.P(kitButton)).toBeDisabled();
}

/** A failure fetching the tool: visible error, no hash, no download, and the kit stays locked. */
async function expectToolFailure(h: Harness, kitButton: string, fail: Parameters<Harness['popup']['route']>[1]): Promise<void> {
  await h.popup.route(TOOL_ROUTE, fail);
  try {
    await h.P('tool-download').click();
    await expect(h.P('tool-error')).toBeVisible();
    await expect(h.P('tool-error')).toContainText('Could not download the tool');
    await expect(h.P('tool-download')).toHaveText('Retry the download');
    await expect(h.P('tool-download')).toBeEnabled();
    await expect(h.P('tool-hash')).toHaveCount(0);
    await expectKitLocked(h, kitButton);
  } finally {
    await h.popup.unroute(TOOL_ROUTE);
  }
}

test.describe('P · the tool is required before every kit', () => {
  test('activation: the kit is not downloaded until the tool is, and a failure fetching it keeps it locked', async ({ h }) => {
    await h.register();
    await h.openPopup(() => h.T('activate-button').click());
    await h.reachKitStep();
    const downloads = countDownloads(h);
    await expectKitLocked(h, 'kit-download');

    await test.step('no network to the tool', async () => {
      await expectToolFailure(h, 'kit-download', (route) => route.abort());
    });
    await test.step('the server responds with an error', async () => {
      await expectToolFailure(h, 'kit-download', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Tool not available in this deployment.' }));
    });
    await test.step('responds 200, but not with the tool', async () => {
      await expectToolFailure(h, 'kit-download', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Maintenance' }));
    });
    // Not even removing `disabled` by hand releases the kit or starts the drill.
    await h.P('kit-download').evaluate((button) => {
      button.removeAttribute('disabled');
      (button as HTMLButtonElement).click();
    });
    await expect(h.P('enroll-step')).toHaveAttribute('data-step', 'kit');
    await expect(h.P('delivery-kit')).toHaveAttribute('data-locked', 'true');
    expect(downloads).toHaveLength(0);

    // On retry with the server healthy, it unlocks and enrollment finishes as usual.
    await h.downloadToolStep();
    await expect(h.P('tool-error')).toHaveCount(0);
    await expect(h.P('kit-locked')).toHaveCount(0);
    const kit = await h.downloadKit();
    expect(kit.v).toBe(2);
    await h.P('done-panel').waitFor();
    expect(downloads.map((download) => download.suggestedFilename())).toEqual(['wl-embedded-wallet-recovery.html', expect.stringMatching(/\.json$/)]);
  });

  test('re-enrollment: rotating requires the tool again, even if it was already downloaded at enrollment', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await h.P('re-enroll-start').click();
    await h.reachKitStep();
    await expectKitLocked(h, 'kit-download');
    await expectToolFailure(h, 'kit-download', (route) => route.abort());
    await h.downloadToolStep();
    const kit = await h.downloadKit();
    await h.P('re-enrolled').waitFor();
    expect(kit.manifest.setId).not.toBe(account.kit.manifest.setId);
  });

  test('new kit for a wallet with an old kit: unlock, activate again and B+C', async ({ h }) => {
    const account = await h.activate(await h.register());

    await test.step('from unlock, with A+B', async () => {
      await h.T('unlock-button').click();
      await h.P('unlock-start').click();
      await h.P('kit-upgrade').waitFor();
      await h.P('kit-upgrade-code').fill(account.recovery);
      await expectKitLocked(h, 'kit-upgrade-start');
      await expectToolFailure(h, 'kit-upgrade-start', (route) => route.fulfill({ status: 500, body: '' }));
      await h.downloadToolStep();
      const fresh = JSON.parse(await h.nextDownload(() => h.P('kit-upgrade-start').click())) as Kit;
      await h.P('kit-upgrade-done').waitFor();
      expect(fresh.v).toBe(2);
    });

    await test.step('when asked to activate again: a single tool step, the one for the new kit', async () => {
      const again = await h.direct('activate', { kind: 'activate' });
      expect(again).toMatchObject({ ok: true, address: account.safe });
      await h.P('kit-upgrade').waitFor();
      await expect(h.P('tool-download')).toHaveCount(1);
      await expect(h.P('recovery-tool')).toHaveCount(0);
      await h.P('kit-upgrade-code').fill(account.recovery);
      await expectKitLocked(h, 'kit-upgrade-start');
      await h.downloadToolStep();
      await expect(h.P('kit-upgrade-start')).toBeEnabled();
    });

    await test.step('after recovering with B+C and the old kit', async () => {
      await h.openStandaloneRecover();
      await h.recoverWithKit(oldKit(account.kit), account.recovery);
      await h.P('kit-old').waitFor();
      await h.P('recover-bc-submit').click();
      await h.P('done-panel').waitFor();
      await h.P('kit-upgrade-code').fill(account.recovery);
      await expectKitLocked(h, 'kit-upgrade-start');
      await h.downloadToolStep();
      const fresh = JSON.parse(await h.nextDownload(() => h.P('kit-upgrade-start').click())) as Kit;
      expect(fresh.v).toBe(2);
    });
  });

  test('static page: it cannot fetch the tool, so it offers no kit', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.context.route((url) => url.port !== new URL(STATIC_RECOVERY).port, (route) => route.abort());
    try {
      await h.popup.goto(`${STATIC_RECOVERY}/`);
      await h.recoverWithKit(oldKit(account.kit), account.recovery);
      await h.P('kit-old').waitFor();
      await h.P('recover-bc-submit').click();
      await h.P('done-panel').waitFor();
      await expect(h.P('kit-upgrade-unavailable')).toContainText('this page cannot download it');
      await expect(h.P('kit-upgrade')).toHaveCount(0);
      await expect(h.P('kit-upgrade-start')).toHaveCount(0);
      await expect(h.P('tool-download')).toHaveCount(0);
    } finally {
      await h.context.unroute((url) => url.port !== new URL(STATIC_RECOVERY).port).catch(() => undefined);
    }
  });
});
