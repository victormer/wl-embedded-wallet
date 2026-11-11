import { generate } from 'otplib';
import decodeQR from 'qr/decode.js';
import { PASSWORD } from '../support/env.ts';
import { expect, Harness, newEmail, test } from '../support/harness.ts';

test.describe('A · account', () => {
  test('the login QR code can be read from the screen and yields a valid TOTP code', async ({ h, context }) => {
    await h.startRegistration();
    const secret = await h.T('totp-secret').innerText();
    h.registerSecret(secret);

    // Read from a real screenshot: checks what the phone sees, with the CSS applied.
    const png = (await h.T('totp-qr').screenshot()).toString('base64');
    const decoder = await context.newPage();
    const image = await decoder.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const draw = canvas.getContext('2d')!;
      draw.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, data: Array.from(draw.getImageData(0, 0, bitmap.width, bitmap.height).data) };
    }, png);
    await decoder.close();

    const uri = new URL(decodeQR({ width: image.width, height: image.height, data: Uint8Array.from(image.data) }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(uri.searchParams.get('secret')).toBe(secret);

    await h.T('totp-input').fill(await generate({ secret: uri.searchParams.get('secret')! }));
    await h.T('totp-submit').click();
    await expect(h.T('activate-button')).toBeVisible();
  });

  test('sign-up, full activation and the same Safe when signing in again', async ({ h }) => {
    await h.shot(h.app, 'demo-sign-up');
    const email = await h.register();
    await expect(h.T('user-email')).toContainText(email);
    await expect(h.T('wallet-address')).toHaveCount(0);
    await expect(h.T('activate-button')).toBeVisible();

    const account = await h.activate(email, { screenshot: true, wrongConfirmation: true });

    expect(account.safe).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(account.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(account.safe).not.toBe(account.owner);

    // The kit does not carry share A, and its public data matches what is shown.
    expect(JSON.stringify(account.kit)).not.toContain(account.shares.A);
    expect(account.kit).not.toHaveProperty('encA');
    expect(account.kit.manifest.smartAccount.address).toBe(account.safe);
    expect(account.kit.manifest.expectedAddress).toBe(account.owner);
    await expect(h.P('export-panel')).toBeVisible();

    await h.shot(h.app, 'demo-wallet-activated');

    await h.logout();
    await h.login(email);
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    await expect(h.T('wallet-owner')).toHaveText(account.owner);
    await expect(h.T('activate-button')).toHaveCount(0);

    // Asking to activate again returns the same wallet: a second one is never created.
    const again = await h.direct('activate', { kind: 'activate' });
    expect(again).toMatchObject({ ok: true, address: account.safe, owner: account.owner });
  });

  test('another user gets a different Safe and a different owner', async ({ h, browser }) => {
    const first = await h.activate(await h.register());
    const context = await browser.newContext({ acceptDownloads: true });
    const other = new Harness(context);
    await other.start();
    const second = await other.activate(await other.register(newEmail()));
    expect(second.safe).not.toBe(first.safe);
    expect(second.owner).not.toBe(first.owner);
    expect(second.seed).not.toBe(first.seed);
    other.assertClean();
    await context.close();
  });

  test('a wrong password grants no access and a duplicate email is rejected', async ({ h }) => {
    const email = await h.register();
    await h.logout();
    await h.T('auth-tab-login').click();
    await h.T('auth-email').fill(email);
    await h.T('auth-password').fill('another-long-password');
    await h.T('auth-submit').click();
    await expect(h.T('auth-error')).toBeVisible();
    await expect(h.T('wallet-empty')).toHaveCount(0);

    await h.T('auth-tab-register').click();
    await h.T('auth-email').fill(email);
    await h.T('auth-password').fill(PASSWORD);
    await h.T('auth-submit').click();
    await expect(h.T('auth-error')).toBeVisible();
  });
});
