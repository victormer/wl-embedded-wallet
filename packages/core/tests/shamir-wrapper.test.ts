import { splitMnemonic } from '@tetherto/wdk-utils';
import { describe, expect, it, vi } from 'vitest';
import { recoverMnemonic, verifyRecovery } from '../src/shamir';

const MNEMONIC = 'test test test test test test test test test test test junk';
const yes = () => true;

describe('recoverMnemonic', () => {
  it('returns the seed if every check passes', async () => {
    const [a, b] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    await expect(recoverMnemonic([a, b], { threshold: 2, verifyShare: yes, matchesExpectedWallet: yes })).resolves.toBe(MNEMONIC);
  });

  it('requires strict true from verifyShare and matchesExpectedWallet', async () => {
    const [a, b] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    const wallet = vi.fn(yes);
    await expect(recoverMnemonic([a, b], { threshold: 2, verifyShare: (() => 1) as never, matchesExpectedWallet: wallet })).rejects.toThrowError('SHARE_TAMPERED');
    expect(wallet).not.toHaveBeenCalled();
    await expect(recoverMnemonic([a, b], { threshold: 2, verifyShare: yes, matchesExpectedWallet: (() => 'true') as never })).rejects.toThrowError('ADDRESS_MISMATCH');
  });

  it('a throwing callback does not let it through', async () => {
    const [a, b] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    const thrower = () => {
      throw new Error('x');
    };
    await expect(recoverMnemonic([a, b], { threshold: 2, verifyShare: thrower, matchesExpectedWallet: yes })).rejects.toThrowError('SHARE_TAMPERED');
    await expect(recoverMnemonic([a, b], { threshold: 2, verifyShare: yes, matchesExpectedWallet: thrower })).rejects.toThrowError('ADDRESS_MISMATCH');
  });

  it('rejects fewer shares than the threshold and invalid thresholds', async () => {
    const [a, b] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    const options = { verifyShare: yes, matchesExpectedWallet: yes };
    await expect(recoverMnemonic([a], { ...options, threshold: 2 })).rejects.toThrowError('COMBINE_FAILED');
    await expect(recoverMnemonic([a, b], { ...options, threshold: 1 })).rejects.toThrowError('COMBINE_FAILED');
    await expect(recoverMnemonic([a, b], { ...options, threshold: 1.5 })).rejects.toThrowError('COMBINE_FAILED');
    await expect(recoverMnemonic(new Array(256).fill(a), { ...options, threshold: 2 })).rejects.toThrowError('COMBINE_FAILED');
  });
});

describe('verifyRecovery', () => {
  it('passes with a correct subset', async () => {
    const [a, , c] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    await expect(verifyRecovery(MNEMONIC, [a, c], { threshold: 2, verifyShare: yes })).resolves.toBeUndefined();
  });

  it('fails if the reconstructed seed is not the expected one', async () => {
    const [a, b] = await splitMnemonic(MNEMONIC, { shares: 3, threshold: 2 });
    const other = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await expect(verifyRecovery(other, [a, b], { threshold: 2, verifyShare: yes })).rejects.toThrowError('COMBINE_FAILED');
  });
});
