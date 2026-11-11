import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { combineMnemonic, splitMnemonic } from '@tetherto/wdk-utils';
import { describe, expect, it } from 'vitest';

const POLICY = { shares: 3, threshold: 2 };

describe('Shamir 2-of-3', () => {
  it('any pair recovers the same seed', async () => {
    const mnemonic = generateMnemonic(wordlist, 128);
    const [a, b, c] = await splitMnemonic(mnemonic, POLICY);
    expect(await combineMnemonic([a, b])).toBe(mnemonic);
    expect(await combineMnemonic([a, c])).toBe(mnemonic);
    expect(await combineMnemonic([b, c])).toBe(mnemonic);
  });

  it('a single share fails', async () => {
    const [a] = await splitMnemonic(generateMnemonic(wordlist, 128), POLICY);
    await expect(combineMnemonic([a])).rejects.toThrow();
  });

  it('mixing shares from two splitMnemonic calls fails, even with the same seed', async () => {
    const mnemonic = generateMnemonic(wordlist, 128);
    const [a1] = await splitMnemonic(mnemonic, POLICY);
    const [, b2] = await splitMnemonic(mnemonic, POLICY);
    await expect(combineMnemonic([a1, b2])).rejects.toThrow();
  });
});
