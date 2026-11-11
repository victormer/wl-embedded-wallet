import { recoverSafeOperationSigner } from '../../packages/core/src/safe.ts';
import { erc1271, erc1271Typed, ERC1271_MAGIC } from '../support/chain.ts';
import { CHAIN_A, STATIC_RECOVERY, STATIC_RECOVERY_FOREIGN, STATIC_RECOVERY_SUBDOMAIN, VAULT } from '../support/env.ts';
import { expect, test, type Harness } from '../support/harness.ts';

const TYPED_DATA = {
  domain: { name: 'Test', version: '1', chainId: CHAIN_A },
  types: { Payment: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Payment',
  message: { amount: '5' },
};

async function signRecovered(h: Harness, kind: string, chainId: number, input: string): Promise<`0x${string}`> {
  await h.P('recovered-sign-kind').selectOption(kind);
  await h.P('recovered-sign-chain').fill(String(chainId));
  await h.P('recovered-sign-input').fill(input);
  await h.P('recovered-sign-review').click();
  await h.P('recovered-sign-preview').waitFor();
  await h.P('recovered-sign-approve').click();
  await h.P('recovered-signature').waitFor();
  return (await h.P('recovered-signature').innerText()) as `0x${string}`;
}

async function signAll(h: Harness, safe: `0x${string}`, owner: string, smartAccount: never): Promise<void> {
  const message = 'Signed with B+C only.';
  const signature = await signRecovered(h, 'message', CHAIN_A, message);
  expect(await erc1271(CHAIN_A, safe, message, signature)).toBe(ERC1271_MAGIC);
  expect(await erc1271(CHAIN_A, safe, 'another message', signature)).not.toBe(ERC1271_MAGIC);

  const typed = await signRecovered(h, 'typedData', CHAIN_A, JSON.stringify(TYPED_DATA));
  expect(await erc1271Typed(CHAIN_A, safe, TYPED_DATA, typed)).toBe(ERC1271_MAGIC);

  const userOperation = { calls: [{ to: owner, value: '1' }], nonce: '0', callGasLimit: '100000', verificationGasLimit: '100000', preVerificationGas: '50000', maxFeePerGas: '10', maxPriorityFeePerGas: '1' };
  await signRecovered(h, 'userOperation', CHAIN_A, JSON.stringify(userOperation));
  const signed = JSON.parse(await h.P('recovered-userop').innerText());
  expect(signed.sender).toBe(safe);
  expect(signed.factory).toBeNull();
  expect(await recoverSafeOperationSigner(signed, CHAIN_A, smartAccount)).toBe(owner);
}

test.describe('M · operational B+C and static page', () => {
  test('from the vault, without the API: signs a message, EIP-712 and a UserOperation, and exports the seed', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    await h.T('recover-button').click();
    await h.P('recover-tab-bc').click();
    const from = h.traffic.length;

    await test.step('wrong code and cancelled passkey', async () => {
      await h.recoverWithKit(account.kit, `${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`);
      await h.P('recover-bc-submit').click();
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'DECRYPT_FAILED');
      await h.recoverWithKit(account.kit, account.recovery);
      await h.refusePasskey();
      await h.P('recover-bc-submit').click();
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'CANCELLED');
      await h.allowPasskey();
    });

    await h.P('recover-bc-submit').click();
    await h.P('done-panel').waitFor();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
    await signAll(h, account.safe, account.owner, account.kit.manifest.smartAccount as never);

    await h.P('recovered-export-confirm').check();
    const text = await h.nextDownload(() => h.P('recovered-export-start').click());
    expect(text).toContain(account.seed);
    await h.P('recovered-export-done').waitFor();
    expect(await h.popup.content()).not.toContain(account.seed);

    // The demo refreshes its own API; what matters is that nobody calls the vault's.
    expect(h.apiRequests(from).filter((request) => request.includes(VAULT))).toEqual([]);
  });

  test('static page with the backend down: kit, passkey and code, on the same host as the RP ID', async ({ h }) => {
    h.tolerate(/Content Security Policy/);
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    // Control: it responds from the vault. Then everything except the page itself is blocked.
    await h.context.route((url) => url.port !== new URL(STATIC_RECOVERY).port, (route) => route.abort());
    const from = h.traffic.length;
    await h.popup.goto(`${STATIC_RECOVERY}/`);
    await h.P('recover-bc').waitFor();
    await expect(h.P('recover-tab-ac')).toHaveCount(0);

    // The brand was fixed at build time, with the same brand.json as the vault: logo and fonts from the page itself.
    await expect(h.popup.locator('.brand')).toHaveText('Acme Wallet');
    const brand = await h.popup.evaluate(async () => {
      await document.fonts.ready;
      return {
        logo: (document.querySelector('.brand-logo') as HTMLImageElement).naturalWidth,
        font: [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'Inter' && face.status === 'loaded'),
        stylesheet: document.querySelector('link[href="./brand.css"]') !== null,
      };
    });
    expect(brand).toEqual({ logo: expect.any(Number), font: true, stylesheet: true });
    expect(brand.logo).toBeGreaterThan(0);

    // The page CSP does not allow talking to anyone.
    const reached = await h.popup.evaluate((vault) => fetch(`${vault}/api/health`).then(() => 'escaped', () => 'blocked'), VAULT);
    expect(reached).toBe('blocked');

    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-bc-submit').click();
    await h.P('done-panel').waitFor();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
    await signAll(h, account.safe, account.owner, account.kit.manifest.smartAccount as never);

    await h.P('recovered-export-confirm').check();
    const text = await h.nextDownload(() => h.P('recovered-export-start').click());
    expect(text).toContain(account.seed);

    const urls = h.traffic.slice(from).map(({ url }) => url);
    expect(urls.filter((url) => new URL(url).port !== new URL(STATIC_RECOVERY).port && !url.startsWith('blob:') && !url.includes('/api/health'))).toEqual([]);
    expect(urls.filter((url) => new URL(url).pathname.startsWith('/api/') && !url.includes('/api/health'))).toEqual([]);

    await test.step('tampered kit, here too', async () => {
      await h.popup.goto(`${STATIC_RECOVERY}/`);
      const bytes = Buffer.from(account.kit.signature, 'base64url');
      bytes[0] ^= 1;
      await h.recoverWithKit({ ...account.kit, signature: bytes.toString('base64url') }, account.recovery);
      await h.P('recover-bc-submit').click();
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'MANIFEST_INVALID');
    });
  });

  test('the real RP ID boundary: a subdomain works, another domain does not, and there only kit and code remain', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.context.route((url) => url.port !== new URL(STATIC_RECOVERY).port, (route) => route.abort());

    await test.step('subdomain of the RP ID: the passkey works', async () => {
      await h.popup.goto(`${STATIC_RECOVERY_SUBDOMAIN}/`);
      await h.recoverWithKit(account.kit, account.recovery);
      await h.P('recover-bc-submit').click();
      await h.P('done-panel').waitFor();
      await expect(h.P('wallet-address')).toHaveText(account.safe);
    });

    await test.step('another domain, as if the vault domain had been lost: the passkey cannot be used', async () => {
      await h.popup.goto(`${STATIC_RECOVERY_FOREIGN}/`);
      await h.recoverWithKit(account.kit, account.recovery);
      await h.P('recover-bc-submit').click();
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'WEBAUTHN_FAILED');
      await expect(h.P('done-panel')).toHaveCount(0);
      // The seed backup does not depend on the domain.
      await h.P('recover-backup-submit').click();
      await h.P('done-panel').waitFor();
      await expect(h.P('wallet-owner')).toHaveText(account.owner);
    });
  });

  test('with a session, re-enrolls from the kit: same Safe, and the new passkey signs', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    await h.T('recover-button').click();
    await h.P('recover-tab-rekit').click();
    await h.P('recover-rekit').waitFor();
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-bc-submit').click();
    const { kit, recovery } = await h.enrollSteps();
    await h.P('re-enrolled').waitFor();
    await expect(h.T('action-success')).toBeVisible();

    expect(kit.manifest.setId).not.toBe(account.kit.manifest.setId);
    expect(kit.manifest.smartAccount.address).toBe(account.safe);
    const proven = await h.provenSecrets(kit, recovery, account.owner);
    expect(proven.seed).toBe(account.seed);
    expect(proven.shares.A).not.toBe(account.shares.A);

    const signed = await h.signFromForm('sign-message-submit', 'message');
    expect(signed).toMatchObject({ valid: 'true', erc1271: 'true' });
  });

  test('a kit from another user does not re-enroll this wallet', async ({ h }) => {
    const first = await h.activate(await h.register());
    await h.logout();
    await h.activate(await h.register());
    await h.T('recover-button').click();
    await h.P('recover-tab-rekit').click();
    await h.P('recover-rekit').waitFor();
    await h.recoverWithKit(first.kit, first.recovery);
    await h.P('recover-backup-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'ADDRESS_MISMATCH');
    await expect(h.P('passkey-create')).toHaveCount(0);
  });
});
