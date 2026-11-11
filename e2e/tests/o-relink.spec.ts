import { APP, CHAIN_A, VAULT } from '../support/env.ts';
import { expect, test, type Account, type Harness } from '../support/harness.ts';

/** An account with a wallet, and the user who loses their login and signs in with a new account. */
async function loseLogin(h: Harness): Promise<{ account: Account; oldEmail: string; newEmail: string }> {
  const oldEmail = await h.register();
  const account = await h.activate(oldEmail);
  await h.logout();
  const newEmail = await h.register();
  await h.T('wallet-empty').waitFor();
  await expect(h.T('relink-button')).toBeVisible();
  return { account, oldEmail, newEmail };
}

async function confirmRelink(h: Harness, account: Account, email: string): Promise<void> {
  await h.P('relink-review').waitFor();
  await expect(h.P('wallet-address')).toHaveText(account.safe);
  await expect(h.P('wallet-owner')).toHaveText(account.owner);
  await expect(h.P('relink-account')).toHaveText(email);
  await h.P('relink-confirm').click();
  await h.P('relink-done').waitFor();
  await expect(h.T('action-success')).toBeVisible();
  await expect(h.T('wallet-address')).toHaveText(account.safe);
  await expect(h.T('wallet-owner')).toHaveText(account.owner);
}

test.describe('O · link the wallet to another account', () => {
  test('with kit and code: the new account uses it with its passkey, can rotate, and the old one loses access', async ({ h }) => {
    const { account, oldEmail, newEmail } = await loseLogin(h);

    await h.T('relink-button').click();
    await h.P('relink').waitFor();
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-backup-submit').click();
    await confirmRelink(h, account, newEmail);

    // The passkey and share A still work, even though they were encrypted with the previous `sub`.
    await h.T('unlock-button').click();
    await h.P('unlock-start').click();
    await expect(h.T('action-success')).toContainText(account.safe);

    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();
    expect(await h.signFromForm('sign-message-submit', 'message')).toMatchObject({ valid: 'true', erc1271: 'true' });

    // Rotate under the new account: the next set is encrypted with its `sub`.
    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await h.P('re-enroll-start').click();
    const { kit, recovery } = await h.enrollSteps();
    await h.P('re-enrolled').waitFor();
    expect(kit.manifest.userId).not.toBe(account.kit.manifest.userId);
    expect(kit.manifest.smartAccount.address).toBe(account.safe);
    const proven = await h.provenSecrets(kit, recovery, account.owner);
    expect(proven.seed).toBe(account.seed);

    await h.logout();
    await h.login(oldEmail);
    await h.T('wallet-empty').waitFor();
    await expect(h.T('wallet-address')).toHaveCount(0);
  });

  test('with B+C (kit, passkey and code), and then without a kit (passkey and code) to yet another account', async ({ h }) => {
    const { account, oldEmail, newEmail } = await loseLogin(h);

    await h.T('relink-button').click();
    await h.P('relink').waitFor();
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-bc-submit').click();
    await confirmRelink(h, account, newEmail);

    await h.logout();
    const third = await h.register();
    await h.T('relink-button').click();
    await h.P('relink-tab-passkey').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-passkey-submit').click();
    await confirmRelink(h, account, third);

    for (const email of [oldEmail, newEmail]) {
      await h.logout();
      await h.login(email);
      await h.T('wallet-empty').waitFor();
    }
  });

  test('an account that has a wallet cannot link another', async ({ h }) => {
    const first = await h.activate(await h.register());
    await h.logout();
    const second = await h.activate(await h.register());
    await expect(h.T('relink-button')).toHaveCount(0);

    expect(await h.direct('relink', { kind: 'relink' })).toMatchObject({ ok: false, code: 'WALLET_ALREADY_EXISTS' });
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'WALLET_ALREADY_EXISTS');
    await expect(h.T('wallet-address')).toHaveText(second.safe);
    expect(first.safe).not.toBe(second.safe);
  });

  test('a failed relink reaches the app with its code, the popup only offers to go back, and the app can retry', async ({ h }) => {
    const { account, newEmail } = await loseLogin(h);
    const nonceUrl = (url: URL) => url.origin === VAULT && url.pathname === '/api/relink/nonce';
    const relinkUrl = (url: URL) => url.origin === VAULT && url.pathname === '/api/relink';
    let relinkPosts = 0;
    h.context.on('request', (request) => {
      if (request.method() === 'POST' && relinkUrl(new URL(request.url()))) relinkPosts += 1;
    });

    async function failRelink(code: string): Promise<void> {
      await h.T('relink-button').click();
      await h.P('relink').waitFor();
      await h.recoverWithKit(account.kit, account.recovery);
      await h.P('recover-backup-submit').click();
      await h.P('relink-review').waitFor();
      await h.P('relink-confirm').click();
      // The app's promise settles with the code; it does not wait for the popup to be closed.
      await expect(h.T('action-error')).toHaveAttribute('data-code', code);
      await expect(h.P('flow-error')).toHaveAttribute('data-code', code);
      await expect(h.P('relink-confirm')).toHaveCount(0);
      await expect(h.P('back-to-app')).toBeVisible();
      await expect(h.T('wallet-empty')).toBeVisible();
    }

    // A challenge for another account is never signed.
    await h.context.route(nonceUrl, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...((await response.json()) as object), newSub: 'someone-else' } });
    });
    await failRelink('RELINK_REJECTED');
    expect(relinkPosts).toBe(0);
    await h.context.unroute(nonceUrl);

    // The server fails the final step.
    await h.context.route(relinkUrl, (route) => route.fulfill({ status: 500, json: { error: 'INTERNAL' } }));
    await failRelink('INTERNAL');
    expect(relinkPosts).toBe(1);
    await h.context.unroute(relinkUrl);

    // Nothing changed on the server: the app can start again and link the wallet.
    await h.T('relink-button').click();
    await h.P('relink').waitFor();
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-backup-submit').click();
    await confirmRelink(h, account, newEmail);
  });

  test('a valid token without the owner signature does not link, and without the code signing is never reached', async ({ h }) => {
    h.tolerate(/403/);
    const { account, oldEmail } = await loseLogin(h);
    await h.T('relink-button').click();
    await h.P('relink').waitFor();

    await h.recoverWithKit(account.kit, `${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`);
    await h.P('recover-backup-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'DECRYPT_FAILED');
    await expect(h.P('relink-review')).toHaveCount(0);

    // What an XSS would do with the new account's session.
    const attempt = await h.popup.evaluate(
      async ({ safe, owner, app }) => {
        const headers = { 'Content-Type': 'application/json', 'X-Vault-App-Origin': app };
        const nonce = await fetch('/api/relink/nonce', { method: 'POST', headers, body: JSON.stringify({ safe, owner }) });
        const challenge = (await nonce.json()) as { nonce: string };
        const relink = await fetch('/api/relink', { method: 'POST', headers, body: JSON.stringify({ nonce: challenge.nonce, signature: `0x${'11'.repeat(65)}` }) });
        return { nonce: nonce.status, relink: relink.status, body: await relink.json() };
      },
      { safe: account.safe, owner: account.owner, app: APP },
    );
    expect(attempt).toEqual({ nonce: 200, relink: 403, body: { error: 'RELINK_REJECTED' } });

    await h.logout();
    await h.login(oldEmail);
    await expect(h.T('wallet-address')).toHaveText(account.safe);
  });
});
