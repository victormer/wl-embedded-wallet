import { openShareB } from '../../packages/core/src/envelope.ts';
import { APP, CHAIN_A, VAULT } from '../support/env.ts';
import { expect, test } from '../support/harness.ts';

const statusOf = (h: { popup: import('@playwright/test').Page }, path: string) =>
  h.popup.evaluate(async ({ url, appOrigin }) => (await fetch(url, { headers: { 'X-Vault-App-Origin': appOrigin } })).status, { url: path, appOrigin: APP });

test.describe('D · recovery flows', () => {
  test('normal unlock A+B', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.T('unlock-button').click();
    await h.P('unlock-start').click();
    await expect(h.T('action-success')).toContainText(account.safe);
    await expect(h.P('done-panel')).toBeVisible();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
  });

  test('lost device A+C: re-enrollment with the same Safe and the previous set revoked', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    await h.loseAuthenticator();
    await h.addAuthenticator();

    // The previous passkey no longer exists on this device.
    expect(await h.passkeyAvailable(account.kit.credentialId)).toBe(false);

    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await expect(h.P('recover-ac-result')).toBeVisible();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
    await h.P('re-enroll-start').click();
    const { recovery, kit } = await h.enrollSteps();
    await h.P('re-enrolled').waitFor();
    await expect(h.T('action-success')).toBeVisible();
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    await expect(h.P('wallet-address')).toHaveText(account.safe);

    // New set, with new shares, for the same seed.
    expect(kit.manifest.setId).not.toBe(account.kit.manifest.setId);
    expect(kit.manifest.smartAccount.address).toBe(account.safe);
    const proven = await h.provenSecrets(kit, recovery, account.owner);
    expect(proven.seed).toBe(account.seed);
    expect(proven.shares.A).not.toBe(account.shares.A);
    expect(proven.shares.B).not.toBe(account.shares.B);
    expect(proven.shares.C).not.toBe(account.shares.C);

    // The previous set is revoked on the server.
    const oldSet = account.kit.manifest.setId;
    expect(await statusOf(h, `/api/shares/a?setId=${oldSet}`)).toBe(410);
    expect(await statusOf(h, `/api/shares?setId=${oldSet}`)).toBe(410);

    // The new passkey signs, and the Safe, already deployed, validates it.
    const signed = await h.signFromForm('sign-message-submit', 'message');
    expect(signed).toMatchObject({ valid: 'true', erc1271: 'true' });

    // The previous code no longer works; the new one does.
    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'DECRYPT_FAILED');
    await expect(h.P('recover-ac-result')).toHaveCount(0);
    await h.P('recovery-code-input').fill(recovery);
    await h.P('recover-ac-submit').click();
    await expect(h.P('recover-ac-result')).toBeVisible();
  });

  test('after rotating, the previous passkey does not open the new set', async ({ h }) => {
    const account = await h.activate(await h.register());

    // Rotation without losing the authenticator: the previous passkey still exists.
    await h.T('recover-button').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await h.P('re-enroll-start').click();
    const { kit, recovery } = await h.enrollSteps();
    await h.P('re-enrolled').waitFor();
    await h.provenSecrets(kit, recovery, account.owner);

    expect(kit.credentialId).not.toBe(account.kit.credentialId);
    const oldPrf = await h.readPrf(account.kit.credentialId);
    await expect(openShareB(kit.encB, oldPrf, { userId: kit.manifest.userId, setId: kit.manifest.setId })).rejects.toThrow();

    // Known limitation, documented in the README: the server cannot revoke material held outside it.
    // Anyone who keeps the old kit, the old passkey and the old code can still rebuild the same seed.
    await h.openStandaloneRecover();
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-bc-submit').click();
    await expect(h.P('done-panel')).toBeVisible();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
  });

  test('without the server: B+C with kit, passkey and code, no call to /api and no session', async ({ h }) => {
    const account = await h.activate(await h.register());

    // Control: the traffic log does see API calls, including the ones the worker makes.
    const seen = h.apiRequests();
    expect(seen.some((request) => request.startsWith('POST') && request.includes('/api/shares'))).toBe(true);
    expect(seen.some((request) => request.includes('/api/shares/a'))).toBe(true);

    await h.context.clearCookies();
    const from = h.traffic.length;
    await h.openStandaloneRecover();
    await h.recoverWithKit(account.kit, account.recovery);
    await expect(h.P('kit-loaded')).toContainText(account.safe);
    await h.P('recover-bc-submit').click();
    await expect(h.P('done-panel')).toBeVisible();
    await expect(h.P('wallet-address')).toHaveText(account.safe);

    expect(h.apiRequests(from)).toEqual([]);
    expect(h.traffic.slice(from).every(({ url }) => new URL(url).origin === VAULT)).toBe(true);
    expect((await h.context.cookies()).filter(({ domain }) => domain === 'vault.localhost')).toEqual([]);
  });

  test('B+C also from the popup opened by the app', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.T('recover-button').click();
    await h.P('recover-tab-bc').click();
    const from = h.traffic.length;
    await h.recoverWithKit(account.kit, account.recovery);
    await h.P('recover-bc-submit').click();
    await expect(h.P('done-panel')).toBeVisible();
    await expect(h.T('action-success')).toBeVisible();
    // The demo refreshes its own API; what matters is that nothing calls the vault's.
    expect(h.apiRequests(from).filter((request) => request.includes(VAULT))).toEqual([]);
  });
});

