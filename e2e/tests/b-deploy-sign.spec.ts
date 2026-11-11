import { balanceOf, codeAt, ERC1271_MAGIC, erc1271, paymasterDeposit } from '../support/chain.ts';
import { APP, CHAIN_A, VAULT } from '../support/env.ts';
import { expect, test } from '../support/harness.ts';

const FORM_MESSAGE = 'I authorize this operation.';

test.describe('B · deployment and signing', () => {
  test('signing blocked until deployed, deployment with paymaster and verified signatures', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');

    // Blocked in the UI.
    await expect(h.T('sign-blocked')).toBeVisible();
    await expect(h.T('sign-message-input')).toHaveCount(0);
    await expect(h.T('sign-userop-submit')).toHaveCount(0);

    // And actually blocked in the vault, bypassing the UI.
    const blocked = await h.direct('sign', { kind: 'sign', chain: { chainId: CHAIN_A }, request: { kind: 'message', message: 'not deployed' } }, CHAIN_A);
    expect(blocked).toMatchObject({ ok: false, code: 'WALLET_NOT_DEPLOYED' });
    expect(await codeAt(CHAIN_A, account.safe)).toBeUndefined();

    const depositBefore = await paymasterDeposit(CHAIN_A);
    await h.T('deploy-button').click();
    await h.P('deploy-approve').waitFor();
    await expect(h.P('review-chain')).toContainText(String(CHAIN_A));
    await expect(h.P('review-rpc-host')).toContainText('38545');
    await expect(h.P('deploy-cost')).toHaveAttribute('data-sponsored', 'true');
    await h.shot(h.popup, 'deploy-review');
    await h.P('deploy-approve').click();
    await h.P('deploy-tx').waitFor();
    await expect(h.T('wallet-deployed')).toHaveAttribute('data-deployed', 'true');

    // Real contract deployed, paid for by the paymaster, without touching the Safe balance.
    expect((await codeAt(CHAIN_A, account.safe))?.length).toBeGreaterThan(2);
    expect(await paymasterDeposit(CHAIN_A)).toBeLessThan(depositBefore);
    expect(await balanceOf(CHAIN_A, account.safe)).toBe(0n);

    // The proxy, from the vault page itself: the same signed deployment gets its hash back without being forwarded (the
    // bundler would now reject it), any other one is refused, and the methods that let the page shape it are gone.
    const sent = h.traffic.find((entry) => entry.method === 'POST' && entry.url === `${VAULT}/api/aa/rpc` && entry.body.includes('"eth_sendUserOperation"'));
    expect(sent).toBeDefined();
    const proxy = await h.popup.evaluate(
      async ({ body, app, chainHex }) => {
        const call = async (payload: unknown) => {
          const response = await fetch('/api/aa/rpc', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Vault-App-Origin': app },
            body: JSON.stringify(payload),
          });
          return { status: response.status, body: await response.json() };
        };
        const original = JSON.parse(body) as { method: string; params: [Record<string, string>, string] };
        const [operation, entryPoint] = original.params;
        return {
          again: await call(original),
          againToo: await call(original),
          greedy: await call({ method: original.method, params: [{ ...operation, maxFeePerGas: '0x174876e800' }, entryPoint] }),
          prepare: await call({ method: 'vault_prepareDeployment', params: [] }),
          paymaster: await call({ method: 'pm_getPaymasterData', params: [operation, entryPoint, chainHex, {}] }),
          gasPrice: await call({ method: 'eth_gasPrice', params: [] }),
        };
      },
      { body: sent!.body, app: APP, chainHex: `0x${CHAIN_A.toString(16)}` },
    );
    expect(proxy.again).toMatchObject({ status: 200, body: { result: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    expect(proxy.againToo).toEqual(proxy.again);
    expect(proxy.greedy).toEqual({ status: 409, body: { error: 'ALREADY_SPONSORED' } });
    expect(proxy.prepare).toEqual({ status: 409, body: { error: 'ALREADY_DEPLOYED' } });
    expect(proxy.paymaster).toEqual({ status: 403, body: { error: 'METHOD_NOT_ALLOWED' } });
    expect(proxy.gasPrice).toEqual({ status: 403, body: { error: 'METHOD_NOT_ALLOWED' } });

    // Message: server-side verification and, separately, a direct query to the contract.
    const message = await h.signFromForm('sign-message-submit', 'message');
    expect(message).toMatchObject({ valid: 'true', erc1271: 'true' });
    expect(await erc1271(CHAIN_A, account.safe, FORM_MESSAGE, message.signature as `0x${string}`)).toBe(ERC1271_MAGIC);
    expect(await erc1271(CHAIN_A, account.safe, 'another message', message.signature as `0x${string}`)).not.toBe(ERC1271_MAGIC);

    const typed = await h.signFromForm('sign-typed-submit', 'typedData');
    expect(typed).toMatchObject({ valid: 'true', erc1271: 'true' });

    await h.T('sign-userop-submit').click();
    await h.P('sign-approve').waitFor();
    await expect(h.P('sign-address')).toHaveText(account.safe);
    await expect(h.P('review-chain')).toContainText(String(CHAIN_A));
    await expect(h.P('sign-userop-to')).toHaveCount(1);
    await expect(h.P('sign-authority')).toContainText('Safe');
    await h.shot(h.popup, 'sign-review');
    await h.P('sign-approve').click();
    await expect(h.T('sign-result')).toHaveAttribute('data-kind', 'userOperation');
    await expect(h.T('sign-verified')).toHaveAttribute('data-valid', 'true');
    await expect(h.T('chain-notice')).toBeVisible();
    await h.shot(h.app, 'demo-signature-verified');

    // A tampered signature is not accepted.
    const altered = await h.app.evaluate(async ({ chainId, signature, message }) => {
      const flipped = `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`;
      const response = await fetch('/api/signatures/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId, signature: flipped, request: { kind: 'message', message } }),
      });
      return response.json();
    }, { chainId: CHAIN_A, signature: message.signature, message: FORM_MESSAGE });
    expect(altered.valid).toBe(false);

    // If it is already deployed, nothing is signed or sent.
    const again = await h.direct('deploy', { kind: 'deploy', chain: { chainId: CHAIN_A } }, CHAIN_A);
    expect(again).toMatchObject({ ok: true, address: account.safe });
    expect(again.transactionHash).toBeUndefined();
  });

  test('rejecting in the review returns USER_REJECTED and no signature', async ({ h }) => {
    await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    await h.T('sign-message-submit').click();
    await h.P('sign-reject').click();
    await expect(h.T('sign-error')).toHaveAttribute('data-code', 'USER_REJECTED');
    await expect(h.T('sign-result')).toHaveCount(0);
    await expect(h.P('sign-rejected')).toBeVisible();

    await h.T('deploy-button').waitFor({ state: 'detached' });
    const rejected = await Promise.all([
      h.direct('sign', { kind: 'sign', chain: { chainId: CHAIN_A }, request: { kind: 'message', message: 'rejected' } }, CHAIN_A),
      h.P('sign-reject').click(),
    ]);
    expect(rejected[0]).toMatchObject({ ok: false, code: 'USER_REJECTED' });
    expect(rejected[0].signature).toBeUndefined();
  });

  test('rejecting the deployment deploys nothing', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.T('deploy-button').click();
    await h.P('deploy-reject').click();
    await expect(h.T('action-error')).toHaveAttribute('data-code', 'USER_REJECTED');
    expect(await codeAt(CHAIN_A, account.safe)).toBeUndefined();
    await expect(h.T('wallet-deployed')).toHaveAttribute('data-deployed', 'false');
  });
});
