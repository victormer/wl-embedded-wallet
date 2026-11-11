import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/encoding';
import {
  assertManifestFormat,
  buildManifest,
  canonicalize,
  deriveAddress,
  matchesExpectedWallet,
  shareDigest,
  signManifest,
  verifyManifest,
  verifyShare,
  WDK_UTILS_VERSION,
} from '../src/manifest';
import { flipBit, makeKeys, SET_ID, USER } from './fixtures';

// Public BIP-39 test vector. Not a real seed.
const MNEMONIC = 'test test test test test test test test test test test junk';
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function manifest() {
  return buildManifest({
    userId: USER,
    setId: SET_ID,
    shareDigests: { A: 'aa', B: 'bb', C: 'cc' },
    expectedAddress: ADDRESS,
    wdkUtilsVersion: WDK_UTILS_VERSION,
  });
}

describe('canonicalize', () => {
  it('sorts keys recursively and ignores insertion order', () => {
    expect(canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
});

describe('manifest signature', () => {
  it('verifies even if the key order changes', () => {
    const { signingKey, manifestPubKey } = makeKeys();
    const signed = signManifest(manifest(), signingKey);
    const reordered = JSON.parse(canonicalize(signed.manifest));
    expect(() => verifyManifest({ manifest: reordered, signature: signed.signature }, manifestPubKey)).not.toThrow();
  });

  it('a tampered field invalidates the signature', () => {
    const { signingKey, manifestPubKey } = makeKeys();
    const signed = signManifest(manifest(), signingKey);
    const tampered = { ...signed.manifest, shareDigests: { ...signed.manifest.shareDigests, B: 'ff' } };
    expect(() => verifyManifest({ manifest: tampered, signature: signed.signature }, manifestPubKey)).toThrowError('MANIFEST_INVALID');
    expect(() => verifyManifest({ ...signed, manifest: { ...signed.manifest, expectedAddress: '0x0' } }, manifestPubKey)).toThrowError('MANIFEST_INVALID');
  });

  it('a tampered, missing or foreign-key signature is rejected', () => {
    const { signingKey, manifestPubKey } = makeKeys();
    const signed = signManifest(manifest(), signingKey);
    expect(() => verifyManifest({ ...signed, signature: flipBit(signed.signature) }, manifestPubKey)).toThrowError('MANIFEST_INVALID');
    expect(() => verifyManifest({ ...signed, signature: '' }, manifestPubKey)).toThrowError('MANIFEST_INVALID');
    expect(() => verifyManifest(signed, makeKeys().manifestPubKey)).toThrowError('MANIFEST_INVALID');
    expect(() => verifyManifest(signed, '')).toThrowError('MANIFEST_INVALID');
  });
});

describe('format', () => {
  it.each([
    ['format', { format: 'slip39' }],
    ['n', { n: 5 }],
    ['k', { k: 3 }],
    ['derivationPath', { derivationPath: "m/44'/60'/0'/0/1" }],
    ['v', { v: 2 }],
  ])('a different %s is rejected', (_field, patch) => {
    expect(() => assertManifestFormat({ ...manifest(), ...patch } as never)).toThrowError('FORMAT_UNSUPPORTED');
  });
});

describe('verifyShare and matchesExpectedWallet', () => {
  it('the digest is the SHA-256 of the share bytes, as lowercase hex', async () => {
    const digest = await shareDigest('0a0b');
    expect(digest).toBe(await sha256Hex(new Uint8Array([10, 11])));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const m = { ...manifest(), shareDigests: { A: digest, B: 'x', C: 'y' } };
    expect(await verifyShare('0a0b', 'A', m)).toBe(true);
    expect(await verifyShare('0a0b', 'B', m)).toBe(false);
    expect(await verifyShare('0a0c', 'A', m)).toBe(false);
  });

  it('derives m/44\'/60\'/0\'/0/0 and compares the full address', () => {
    expect(deriveAddress(MNEMONIC)).toBe(ADDRESS);
    expect(matchesExpectedWallet(MNEMONIC, manifest())).toBe(true);
    const lastCharChanged = `${ADDRESS.slice(0, -1)}7`;
    expect(matchesExpectedWallet(MNEMONIC, { ...manifest(), expectedAddress: lastCharChanged })).toBe(false);
  });
});

describe('wdk-utils version', () => {
  it('WDK_UTILS_VERSION matches the installed one and package.json pins it without ranges', () => {
    const installed = JSON.parse(readFileSync('node_modules/@tetherto/wdk-utils/package.json', 'utf8'));
    expect(WDK_UTILS_VERSION).toBe(installed.version);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['@tetherto/wdk-utils']).toBe(WDK_UTILS_VERSION);
    for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version).toMatch(/^(\d|workspace:)/);
    }
  });
});
