import { codeAt, ERC1271_MAGIC, erc1271 } from '../support/chain.ts';
import { CHAIN_A, CHAIN_B, CHAIN_NO_FACTORY, CHAIN_OUTSIDE, CHAIN_WRONG_RPC } from '../support/env.ts';
import { expect, test } from '../support/harness.ts';

const FORM_MESSAGE = 'I authorize this operation.';
const signAction = (chainId: number) => ({ kind: 'sign', chain: { chainId }, request: { kind: 'message', message: 'attack' } });

test.describe('C · multichain', () => {
  test('same Safe on two chains, with independent deployment and signing', async ({ h }) => {
    const account = await h.activate(await h.register());

    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();
    expect((await codeAt(CHAIN_A, account.safe))?.length).toBeGreaterThan(2);
    expect(await codeAt(CHAIN_B, account.safe)).toBeUndefined();

    const signedOnA = await h.signFromForm('sign-message-submit', 'message');
    expect(signedOnA).toMatchObject({ valid: 'true', erc1271: 'true' });

    // Chain B: same address, and signing still blocked.
    await h.selectChain(CHAIN_B, 'false');
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    await expect(h.T('sign-blocked')).toBeVisible();
    expect(await h.direct('sign', signAction(CHAIN_B), CHAIN_B)).toMatchObject({ ok: false, code: 'WALLET_NOT_DEPLOYED' });

    // The contract on B has not been deployed: deploying on B creates it at the same address.
    await h.deploy();
    const codeA = await codeAt(CHAIN_A, account.safe);
    const codeB = await codeAt(CHAIN_B, account.safe);
    expect(codeB?.length).toBeGreaterThan(2);
    expect(codeB).toBe(codeA);
    await expect(h.T('wallet-address')).toHaveText(account.safe);

    const signedOnB = await h.signFromForm('sign-message-submit', 'message');
    expect(signedOnB).toMatchObject({ valid: 'true', erc1271: 'true' });
    expect(signedOnB.signature).not.toBe(signedOnA.signature);

    // A signature from chain A is not valid on B, but it is on A. The contract itself answers.
    const signature = signedOnA.signature as `0x${string}`;
    expect(await erc1271(CHAIN_A, account.safe, FORM_MESSAGE, signature)).toBe(ERC1271_MAGIC);
    expect(await erc1271(CHAIN_B, account.safe, FORM_MESSAGE, signature)).not.toBe(ERC1271_MAGIC);

    const verify = (chainId: number) =>
      h.app.evaluate(async ({ chainId, signature, message }) => {
        const response = await fetch('/api/signatures/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chainId, signature, request: { kind: 'message', message } }),
        });
        return response.json();
      }, { chainId, signature, message: FORM_MESSAGE });
    expect(await verify(CHAIN_A)).toMatchObject({ valid: true, erc1271: true });
    expect(await verify(CHAIN_B)).toMatchObject({ valid: false, erc1271: false });
  });

  test('invalid chains: rejected without showing a different address', async ({ h }) => {
    const account = await h.activate(await h.register());

    // Chain without a factory: the address would not be guaranteed.
    await h.selectUnsupportedChain(CHAIN_NO_FACTORY, 'CHAIN_NOT_SUPPORTED');
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    await expect(h.T('deploy-button')).toHaveCount(0);
    expect(await h.direct('deploy', { kind: 'deploy', chain: { chainId: CHAIN_NO_FACTORY } }, CHAIN_NO_FACTORY)).toMatchObject({ ok: false, code: 'CHAIN_NOT_SUPPORTED' });

    // The RPC answers with a different `eth_chainId`.
    await h.selectUnsupportedChain(CHAIN_WRONG_RPC, 'CHAIN_MISMATCH');
    expect(await h.direct('sign', signAction(CHAIN_WRONG_RPC), CHAIN_WRONG_RPC)).toMatchObject({ ok: false, code: 'CHAIN_MISMATCH' });

    // Host outside `RPC_ALLOWED_HOSTS`.
    await h.selectUnsupportedChain(CHAIN_OUTSIDE, 'CHAIN_NOT_SUPPORTED');
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    expect(await h.direct('sign', signAction(CHAIN_OUTSIDE), CHAIN_OUTSIDE)).toMatchObject({ ok: false, code: 'CHAIN_NOT_SUPPORTED' });

    // The popup requests a different chain from the one the backend signed.
    expect(await h.direct('sign', signAction(CHAIN_B), CHAIN_A)).toMatchObject({ ok: false, code: 'CHAIN_REQUEST_MISMATCH' });
  });
});
