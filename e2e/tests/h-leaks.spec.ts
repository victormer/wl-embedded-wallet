import { CHAIN_A } from '../support/env.ts';
import { expect, test } from '../support/harness.ts';

test.describe('H · secrets in the console', () => {
  test('the detector works: it captures page and worker, and finds a secret', async ({ h }) => {
    const canary = 'secret-canary-e2e';
    h.registerSecret(canary);
    expect(h.findLeaks()).toEqual([]);

    await h.app.evaluate((value) => console.log(`text ${value.toUpperCase()} text`), canary);
    await expect.poll(() => h.findLeaks()).toEqual([canary]);
    h.consoleLines.length = 0;

    await h.app.evaluate((value) => {
      const source = `console.warn(${JSON.stringify(value)}); postMessage('ok');`;
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      return new Promise((done) => (worker.onmessage = done));
    }, canary);
    await expect.poll(() => h.findLeaks()).toEqual([canary]);
    h.consoleLines.length = 0;
  });

  test('full sign-up, signing and recovery without any secret in the console', async ({ h }) => {
    const account = await h.activate(await h.register());

    // The suite has checked these values against the manifest: they are the real secrets.
    expect(account.shares.A).toMatch(/^[0-9a-f]+$/);
    expect(account.shares.B).not.toBe(account.shares.A);
    expect(account.seed.split(' ')).toHaveLength(12);

    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();
    await h.signFromForm('sign-message-submit', 'message');
    await h.T('unlock-button').click();
    await h.P('unlock-start').click();
    await expect(h.T('action-success')).toBeVisible();

    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await expect(h.P('recover-ac-result')).toBeVisible();
    await h.P('recover-skip').click();
    await expect(h.T('action-success')).toBeVisible();

    // With a wrong code, the error message does not reveal anything either.
    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(`${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`);
    await h.P('recover-ac-submit').click();
    await expect(h.P('flow-error')).toBeVisible();
    const page = await h.popup.content();
    expect(page).not.toContain(account.seed);
    expect(page).not.toContain(account.shares.A);
    expect(page).not.toContain(account.shares.C);

    expect(h.findLeaks()).toEqual([]);
  });

  test('this Chromium supports hasPrf in the virtual authenticator', async ({ h, browser }) => {
    const account = await h.activate(await h.register());
    console.log(`[prf] Chromium ${browser.version()} accepts hasPrf and returns real PRF output`);
    const prf = await h.readPrf(account.kit.credentialId);
    expect(prf).toHaveLength(32);
    expect(await h.readPrf(account.kit.credentialId)).toEqual(prf);
  });
});
