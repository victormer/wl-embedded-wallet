import { APP, APP2, CHAIN_A, VAULT } from '../support/env.ts';
import { expect, type Harness, test } from '../support/harness.ts';

const SIGN = { kind: 'sign', chain: { chainId: CHAIN_A }, request: { kind: 'message', message: 'hello' } };
const EVIL = 'http://other-site.localhost:4300';

async function tokenFromApp(h: Harness): Promise<string> {
  return h.app.evaluate(async (chainId) => {
    const response = await fetch('/api/vault/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId }),
    });
    return ((await response.json()) as { token: string }).token;
  }, CHAIN_A);
}

/** Opens the popup from the current page with a given token, and returns everything it receives. */
async function askWithToken(h: Harness, token: string, path = 'sign', action: unknown = SIGN): Promise<Record<string, unknown>[]> {
  return h.app.evaluate(
    async ({ vault, token, path, action }) => {
      const messages: Record<string, unknown>[] = [];
      const popup = window.open(`${vault}/${path}`, 'wl-embedded-wallet-vault', 'popup') as Window;
      return new Promise<Record<string, unknown>[]>((resolve) => {
        const timer = setTimeout(() => resolve(messages), 15_000);
        window.addEventListener('message', (event) => {
          if (event.origin !== vault) return;
          messages.push(event.data);
          if (event.data.type === 'ready') popup.postMessage({ protocol: 'wl-embedded-wallet/protocol/v1', type: 'request', id: 'test', token, action }, vault);
          if (event.data.type === 'result') {
            clearTimeout(timer);
            resolve(messages);
          }
        });
      });
    },
    { vault: VAULT, token, path, action },
  );
}

test.describe('K · several apps with the same login', () => {
  test('the same user sees the same Safe in both apps, and signs from the second with the same passkey', async ({ h }) => {
    const email = await h.register();
    const account = await h.activate(email);
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    await h.navigateApp(`${APP2}/`);
    await h.login(email);
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    await expect(h.T('wallet-owner')).toHaveText(account.owner);
    await h.selectChain(CHAIN_A, 'true');

    await h.T('sign-message-submit').click();
    await h.P('sign-review').waitFor();
    await expect(h.P('sign-origin')).toHaveText(APP2);
    await h.P('sign-approve').click();
    await expect(h.T('sign-verified')).toHaveAttribute('data-valid', 'true');
    await expect(h.T('sign-erc1271')).toHaveAttribute('data-valid', 'true');
  });

  test('an app1 token sent from app2 yields ORIGIN_MISMATCH and no data', async ({ h }) => {
    const email = await h.register();
    await h.activate(email);
    const token = await tokenFromApp(h);

    await h.navigateApp(`${APP2}/`);
    h.tolerate(/403/);
    const messages = await askWithToken(h, token);
    expect(messages).toEqual([
      { protocol: 'wl-embedded-wallet/protocol/v1', type: 'ready' },
      { protocol: 'wl-embedded-wallet/protocol/v1', type: 'result', id: 'test', ok: false, code: 'ORIGIN_MISMATCH' },
    ]);
    await expect(h.P('sign-review')).toHaveCount(0);
  });

  test.describe('a third-party page', () => {
    test.beforeEach(async ({ h }) => {
      await h.context.route(`${EVIL}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>other</title>' }));
    });

    test('without a valid token it gets no session, review or result', async ({ h }) => {
      await h.activate(await h.register());
      const before = (await h.context.cookies(VAULT)).find(({ name }) => name === '__Host-vault_session')?.value;

      await h.navigateApp(`${EVIL}/`);
      h.tolerate(/401/);
      const messages = await askWithToken(h, 'not-a-token');
      expect(messages).toEqual([
        { protocol: 'wl-embedded-wallet/protocol/v1', type: 'ready' },
        { protocol: 'wl-embedded-wallet/protocol/v1', type: 'result', id: 'test', ok: false, code: 'UNAUTHORIZED' },
      ]);
      await expect(h.P('sign-review')).toHaveCount(0);

      // Not with a live session either: without a token nothing is shown, not even the export.
      await h.navigateApp(`${EVIL}/other`);
      const opened = await h.app.evaluate(async (vault) => {
        const messages: unknown[] = [];
        window.addEventListener('message', (event) => messages.push(event.data));
        window.open(`${vault}/export`, 'wl-embedded-wallet-vault', 'popup');
        await new Promise((done) => setTimeout(done, 2000));
        return messages;
      }, VAULT);
      expect(opened).toEqual([{ protocol: 'wl-embedded-wallet/protocol/v1', type: 'ready' }]);
      await expect(h.P('gate-connecting')).toBeVisible();
      await expect(h.P('export-panel')).toHaveCount(0);
      expect((await h.context.cookies(VAULT)).find(({ name }) => name === '__Host-vault_session')?.value).toBe(before);
    });

    test('it does not intercept the result of someone else\'s operation, even if the opener navigates to it', async ({ h }) => {
      h.tolerate(/postMessage/);
      await h.activate(await h.register());
      await h.selectChain(CHAIN_A, 'false');
      await h.deploy();

      const pending = h.direct('sign', SIGN, CHAIN_A).catch(() => null);
      await h.P('sign-review').waitFor();
      await expect(h.P('sign-origin')).toHaveText(APP);

      await h.navigateApp(`${EVIL}/`);
      await pending;
      await h.app.evaluate(() => {
        const store = window as unknown as { received: unknown[] };
        store.received = [];
        window.addEventListener('message', (event) => store.received.push(event.data));
      });
      await h.P('sign-approve').click();
      await h.P('sign-done').waitFor();
      await h.popup.waitForTimeout(500);
      expect(await h.app.evaluate(() => (window as unknown as { received: unknown[] }).received)).toEqual([]);
    });
  });

  test('a session bound to the app1 origin cannot be used from app2 without a new exchange', async ({ h }) => {
    const account = await h.activate(await h.register());
    const session = (await h.context.cookies(VAULT)).find(({ name }) => name === '__Host-vault_session');
    const url = `${VAULT}/api/shares/a?setId=${account.kit.manifest.setId}`;
    const read = (appOrigin?: string) =>
      fetch(url, { headers: { Cookie: `${session?.name}=${session?.value}`, ...(appOrigin ? { 'X-Vault-App-Origin': appOrigin } : {}) } });

    expect((await read(APP)).status).toBe(200);
    for (const other of [APP2, undefined]) {
      const response = await read(other);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ORIGIN_MISMATCH' });
    }
  });
});
