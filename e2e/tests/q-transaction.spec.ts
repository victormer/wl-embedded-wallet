import { encodeFunctionData, erc20Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { balanceOf, paymasterDeposit, setBalance, transactionStatus } from '../support/chain.ts';
import { CHAIN_A, CHAIN_B } from '../support/env.ts';
import { expect, test } from '../support/harness.ts';

const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const newAddress = () => privateKeyToAccount(generatePrivateKey()).address;

test.describe('Q · sending transactions', () => {
  test('a sponsored call on A: reviewed in the vault, sent on-chain, hashes back in the app', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();
    await h.openTab('transaction');
    await expect(h.T('tx-fee')).toHaveAttribute('data-sponsored', 'true');

    const recipient = newAddress();
    const depositBefore = await paymasterDeposit(CHAIN_A);
    const safeBefore = await balanceOf(CHAIN_A, account.safe);
    await h.T('tx-to').fill(recipient);
    await h.T('tx-value').fill('0');
    await h.T('tx-submit').click();
    await h.P('tx-approve').waitFor();
    await expect(h.P('tx-safe')).toHaveText(account.safe);
    await expect(h.P('tx-to')).toHaveText(recipient);
    await expect(h.P('tx-value')).toHaveText('0 ETH');
    await expect(h.P('tx-data')).toHaveText('No data');
    await expect(h.P('review-chain')).toContainText(String(CHAIN_A));
    await expect(h.P('tx-cost')).toHaveAttribute('data-sponsored', 'true');
    await expect(h.P('tx-max-fee')).toHaveCount(0);
    await h.shotVariants(h.popup, 'vault-tx-review-sponsored');
    await h.P('tx-approve').click();
    await h.P('tx-done').waitFor({ timeout: 180_000 });

    await expect(h.T('tx-result')).toHaveAttribute('data-status', 'sent');
    const transactionHash = (await h.T('tx-hash').innerText()) as `0x${string}`;
    const userOpHash = await h.T('tx-userop-hash').innerText();
    expect(transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(h.P('tx-hash')).toHaveText(transactionHash);
    expect(await transactionStatus(CHAIN_A, transactionHash)).toBe('success');
    // The paymaster paid the fee: its deposit went down, the Safe's balance did not move.
    expect(await paymasterDeposit(CHAIN_A)).toBeLessThan(depositBefore);
    expect(await balanceOf(CHAIN_A, account.safe)).toBe(safeBefore);
    await h.shotVariants(h.app, 'demo-tx-sent');

    // The other tabs keep their own (empty) result.
    await h.openTab('message');
    await expect(h.T('tx-result')).toHaveCount(0);
    await expect(h.T('sign-result')).toHaveCount(0);
    await h.openTab('transaction');
    await expect(h.T('tx-result')).toHaveAttribute('data-status', 'sent');
  });

  test('an unsponsored value transfer on B is paid by the Safe, with its maximum fee shown', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_B, 'false');
    await h.deploy();
    await setBalance(CHAIN_B, account.safe, 10n ** 18n);
    await h.openTab('transaction');
    await expect(h.T('tx-fee')).toHaveAttribute('data-sponsored', 'false');

    const recipient = newAddress();
    await h.T('tx-to').fill(recipient);
    await h.T('tx-value').fill('0.01');
    await h.T('tx-submit').click();
    await h.P('tx-approve').waitFor();
    await expect(h.P('tx-value')).toHaveText('0.01 ETH');
    await expect(h.P('tx-cost')).toHaveAttribute('data-sponsored', 'false');
    await expect(h.P('tx-max-fee')).toContainText('ETH');
    await h.shotVariants(h.popup, 'vault-tx-review-unsponsored');
    await h.P('tx-approve').click();
    await expect(h.T('tx-result')).toHaveAttribute('data-status', 'sent', { timeout: 180_000 });
    expect(await balanceOf(CHAIN_B, recipient)).toBe(10n ** 16n);
    expect(await balanceOf(CHAIN_B, account.safe)).toBeLessThan(10n ** 18n - 10n ** 16n);
  });

  test('an ERC-20 transfer is decoded in the review', async ({ h }) => {
    await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();
    const recipient = newAddress();
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 1000n] });
    await h.openTab('transaction');
    await h.T('tx-to').fill(newAddress());
    await h.T('tx-data').fill(data);
    await h.T('tx-submit').click();
    await h.P('tx-approve').waitFor();
    await expect(h.P('tx-decoded')).toHaveAttribute('data-function', 'transfer');
    await expect(h.P('tx-decoded-target')).toHaveText(recipient);
    await expect(h.P('tx-decoded-amount')).toHaveText('1000');
    await expect(h.P('tx-data-warning')).toHaveCount(0);
    await h.shotVariants(h.popup, 'vault-tx-review-erc20');
    // Sent to an account without code, the call succeeds: it is still a real transaction.
    await h.P('tx-approve').click();
    await expect(h.T('tx-result')).toHaveAttribute('data-status', 'sent', { timeout: 180_000 });
  });

  test('error paths: rejected, not deployed, self-call, no funds, reverted call', async ({ h }) => {
    const account = await h.activate(await h.register());

    // Not deployed: the vault refuses before preparing anything.
    const notDeployed = await h.direct('transaction', { kind: 'transaction', chain: { chainId: CHAIN_A }, transaction: { to: newAddress(), value: '0' } }, CHAIN_A);
    expect(notDeployed).toMatchObject({ ok: false, code: 'WALLET_NOT_DEPLOYED' });

    await h.selectChain(CHAIN_B, 'false');
    await h.deploy();
    // B does not sponsor transactions: without a balance every review would stop at INSUFFICIENT_FUNDS.
    await setBalance(CHAIN_B, account.safe, 10n ** 18n);
    await h.openTab('transaction');

    // Rejected in the review: nothing signed or sent.
    await h.T('tx-to').fill(newAddress());
    await h.T('tx-submit').click();
    await h.P('tx-reject').click();
    await expect(h.T('tx-error')).toHaveAttribute('data-code', 'USER_REJECTED');
    await expect(h.P('tx-rejected')).toBeVisible();

    // A call with data to the Safe itself could change its owners: never prepared.
    await h.T('tx-to').fill(account.safe);
    await h.T('tx-data').fill('0x12345678');
    await h.T('tx-submit').click();
    await expect(h.T('tx-error')).toHaveAttribute('data-code', 'CALL_NOT_ALLOWED');
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'CALL_NOT_ALLOWED');
    await expect(h.P('tx-approve')).toHaveCount(0);

    // Now the Safe holds nothing.
    await setBalance(CHAIN_B, account.safe, 0n);
    await h.T('tx-to').fill(newAddress());
    await h.T('tx-data').fill('');
    await h.T('tx-value').fill('0.5');
    await h.T('tx-submit').click();
    await expect(h.T('tx-error')).toHaveAttribute('data-code', 'INSUFFICIENT_FUNDS');
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'INSUFFICIENT_FUNDS');
    await h.shotVariants(h.popup, 'vault-tx-insufficient-funds');

    // A call that reverts on-chain: included, fee paid, the app gets TRANSACTION_REVERTED and the popup the hashes.
    await setBalance(CHAIN_B, account.safe, 10n ** 18n);
    await h.T('tx-to').fill(ENTRY_POINT);
    await h.T('tx-value').fill('0');
    await h.T('tx-data').fill('0xdeadbeef');
    await h.T('tx-submit').click();
    await h.P('tx-approve').waitFor();
    await expect(h.P('tx-data-warning')).toBeVisible();
    await h.P('tx-approve').click();
    await expect(h.T('tx-error')).toHaveAttribute('data-code', 'TRANSACTION_REVERTED', { timeout: 180_000 });
    await expect(h.P('tx-unconfirmed')).toBeVisible();
    const hash = (await h.P('tx-hash').innerText()) as `0x${string}`;
    expect(await transactionStatus(CHAIN_B, hash)).toBe('success');
    await expect(h.T('tx-result')).toHaveCount(0);
  });
});
