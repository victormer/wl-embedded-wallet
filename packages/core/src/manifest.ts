import { ed25519 } from '@noble/curves/ed25519.js';
import { predictSafeAddress, SAFE_ACCOUNT_TYPE, SAFE_MODULES_VERSION, smartAccountFor, type SmartAccountInfo } from './safe';
import { DERIVATION_PATH, deriveOwner } from './offline';
import { b64urlDecode, b64urlEncode, hexDecode, sha256Hex, utf8 } from './encoding';
import { WalletError, type Manifest, type ShareName, type SignedManifest } from './types';

export const WDK_UTILS_VERSION = '1.0.0-beta.16';
export const MANIFEST_FORMAT = 'bip39-en/wdk-utils-hex';
export { DERIVATION_PATH };
export const SHARES_N = 3;
export const SHARES_K = 2;

/** JSON with keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('value is not serializable');
  return json;
}

export function buildManifest(input: {
  userId: string;
  setId: string;
  shareDigests: Record<ShareName, string>;
  expectedAddress: string;
  wdkUtilsVersion: string;
  // Preserved by a rotation, even if the defaults change.
  smartAccount?: SmartAccountInfo;
  createdAt?: string;
}): Manifest {
  return {
    v: 1,
    userId: input.userId,
    setId: input.setId,
    n: SHARES_N,
    k: SHARES_K,
    format: MANIFEST_FORMAT,
    wdkUtilsVersion: input.wdkUtilsVersion,
    shareDigests: input.shareDigests,
    expectedAddress: input.expectedAddress,
    derivationPath: DERIVATION_PATH,
    smartAccount: input.smartAccount ?? smartAccountFor(input.expectedAddress),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** Server only. */
export function signManifest(manifest: Manifest, signingKeyHex: string): SignedManifest {
  const signature = ed25519.sign(utf8(canonicalize(manifest)), hexDecode(signingKeyHex));
  return { manifest, signature: b64urlEncode(signature) };
}

export function verifyManifest(signed: SignedManifest, publicKeyHex: string): void {
  let valid = false;
  try {
    valid = ed25519.verify(
      b64urlDecode(signed.signature),
      utf8(canonicalize(signed.manifest)),
      hexDecode(publicKeyHex),
      { zip215: false },
    );
  } catch {
    throw new WalletError('MANIFEST_INVALID');
  }
  if (!valid) throw new WalletError('MANIFEST_INVALID');
}

export function assertManifestFormat(manifest: Manifest): void {
  if (
    manifest.v !== 1 ||
    manifest.format !== MANIFEST_FORMAT ||
    manifest.n !== SHARES_N ||
    manifest.k !== SHARES_K ||
    manifest.derivationPath !== DERIVATION_PATH
  ) {
    throw new WalletError('FORMAT_UNSUPPORTED');
  }
}

/** The Safe is recomputed from the owner: a manifest alone never decides which address to show. */
export function assertSmartAccount(manifest: Manifest): void {
  const { smartAccount } = manifest;
  if (smartAccount?.type !== SAFE_ACCOUNT_TYPE || smartAccount.safeModulesVersion !== SAFE_MODULES_VERSION) {
    throw new WalletError('FORMAT_UNSUPPORTED');
  }
  let predicted: string;
  try {
    predicted = predictSafeAddress(manifest.expectedAddress, smartAccount);
  } catch {
    throw new WalletError('ADDRESS_MISMATCH');
  }
  if (predicted.toLowerCase() !== smartAccount.address.toLowerCase()) throw new WalletError('ADDRESS_MISMATCH');
}

/** SHA-256 of the share bytes, as lowercase hex. */
export function shareDigest(share: string): Promise<string> {
  return sha256Hex(hexDecode(share));
}

export async function verifyShare(share: string, name: ShareName, manifest: Manifest): Promise<boolean> {
  return (await shareDigest(share)) === manifest.shareDigests[name];
}

export function deriveAddress(mnemonic: string): string {
  return deriveOwner(mnemonic);
}

/** Compares the full address, never a fingerprint. */
export function matchesExpectedWallet(mnemonic: string, manifest: Manifest): boolean {
  return deriveAddress(mnemonic).toLowerCase() === manifest.expectedAddress.toLowerCase();
}
