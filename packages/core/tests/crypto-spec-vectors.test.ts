// Checks every vector in docs/CRYPTO-SPEC.md section 22 against the code. The values are parsed from the document
// rather than copied here, so that an edit to either the document or the code that breaks a vector fails this suite.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { argon2id } from 'hash-wasm';
import { hashTypedData } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64urlDecode, b64urlEncode, hexDecode, hexEncode, sha256Hex, utf8 } from '../src/encoding';
import { buildAad, hkdfAesKey, openShareB, sealEnvelope, sealShareB } from '../src/envelope';
import { buildManifest, canonicalize, shareDigest, signManifest, verifyManifest } from '../src/manifest';
import { deriveOwner } from '../src/offline';
import { PRF_SALT_LABEL, passkeyUserHandle, prfSalt } from '../src/prf';
import { DEFAULT_ARGON2_PARAMS, generateRecoveryCode, normalizeRecoveryCode, recoveryCodeToBytes, sealShareC } from '../src/recovery-code';
import { relinkTypedData } from '../src/relink';
import { predictSafeAddress, requestHash, safeMessageTypedData } from '../src/safe';
import { openSeedBackup, sealSeedBackup, seedBackupAad } from '../src/seed-backup';
import type { Argon2Params, Envelope } from '../src/types';

const docPath = (name: string) => fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url));
const SPEC = readFileSync(docPath('CRYPTO-SPEC.md'), 'utf8');

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`section not found: ${start}`);
  return text.slice(from + start.length, to);
}

const SECTION = between(SPEC, '## 22. Test vectors', '\n## 23.');

/** The first code block under `### title` in section 22. */
function block(title: string): string {
  return between(between(SECTION, `\n### ${title}\n`, '\n### '), '```\n', '\n```');
}

/** Every `= value` for a label: the rest of its line plus the continuation lines that start with `=`. */
function values(text: string, label: string): string[] {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.trimStart().startsWith(label) && /^\s*(=|$)/.test(line.trimStart().slice(label.length)));
  if (index < 0) throw new Error(`label not found: ${label}`);
  const found = [lines[index]!.trimStart().slice(label.length)];
  for (const line of lines.slice(index + 1)) {
    if (!line.trimStart().startsWith('=')) break;
    found.push(line);
  }
  return found.map((line) => line.trim().replace(/^=\s*/, '')).filter(Boolean);
}

const value = (text: string, label: string) => values(text, label).at(-1)!;
const token = (text: string, label: string) => value(text, label).split(/\s+/)[0]!;

function match(text: string, pattern: RegExp): RegExpMatchArray {
  const found = text.match(pattern);
  if (!found) throw new Error(`no match for ${pattern}`);
  return found;
}

const quoted = (text: string) => match(text, /"([^"]*)"/)[1]!;

/** `02 * 16 -> "AgIC..."`: the bytes, checked against the base64url the document shows next to them. */
function repeated(text: string): Uint8Array<ArrayBuffer> {
  const [, byte, count] = match(text, /^([0-9a-f]{2}) \* (\d+)/);
  const bytes = new Uint8Array(Number(count)).fill(Number.parseInt(byte!, 16));
  const shown = text.match(/->\s*"([^"]*)"/);
  if (shown) expect(b64urlEncode(bytes)).toBe(shown[1]);
  return bytes;
}

const argon2Params = (text: string): Argon2Params => {
  const [, m, t, p, len] = match(text, /Argon2id\(m=(\d+), t=(\d+), p=(\d+), len=(\d+)\)/);
  return { memorySize: Number(m), iterations: Number(t), parallelism: Number(p), hashLength: Number(len) };
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Common inputs, from the prose at the top of section 22.
const USER_ID = match(SECTION, /`userId = "([^"]+)"`/)[1]!;
const SET_ID = match(SECTION, /`setId = "([^"]+)"`/)[1]!;
const SHARE = hexDecode(match(SECTION, /share plaintext bytes \(hex\) `([0-9a-f]+)`/)[1]!);
const IDS = { userId: USER_ID, setId: SET_ID };

/**
 * Salts, IVs and the code entropy come from `crypto.getRandomValues` (`randomBytes`); the vectors substitute fixed
 * values. Any random draw beyond the expected ones fails the test instead of silently using real randomness.
 */
function fixRandom(...draws: Uint8Array[]): void {
  const queue = [...draws];
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    const next = queue.shift();
    if (!next || !array || next.length !== array.byteLength) throw new Error('unexpected random draw');
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(next);
    return array;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Raw HKDF output: `hkdfAesKey` returns a non-extractable key, so the same derivation is redone with `deriveBits`. */
async function hkdfRaw(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', ikm as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  return hexEncode(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: utf8(info) }, base, 256)));
}

/** Raw Argon2id output: `deriveRecoveryKey` also returns a non-extractable key, so hash-wasm is called directly, as it does. */
async function argon2Raw(password: Uint8Array, salt: Uint8Array, params: Argon2Params): Promise<string> {
  return hexEncode(await argon2id({ password, salt, ...params, outputType: 'binary' }));
}

/** Decrypting the documented `ct` with the documented key and AAD shows the three are consistent with each other. */
async function decryptWith(rawKeyHex: string, iv: Uint8Array, aad: string, ct: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', hexDecode(rawKeyHex), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: utf8(aad) }, key, b64urlDecode(ct)));
}

describe('CRYPTO-SPEC section 22 test vectors', () => {
  it('PRF input and user handle', async () => {
    const text = block('PRF input and user handle');
    const [prfInput, prfHex] = values(text, 'PRF_SALT');
    expect(quoted(prfInput!)).toBe(PRF_SALT_LABEL);
    expect(hexEncode(await prfSalt())).toBe(prfHex);

    const [handleInput, handleHex] = values(text, 'user.id');
    expect(quoted(handleInput!)).toBe(`${USER_ID}|${SET_ID}`);
    expect(hexEncode(await passkeyUserHandle(USER_ID, SET_ID))).toBe(handleHex);
  });

  it('share B envelope', async () => {
    const text = block('Share B envelope');
    const prf = repeated(value(text, 'prf'));
    const salt = repeated(value(text, 'salt'));
    const iv = repeated(value(text, 'iv'));
    const info = quoted(value(text, 'info'));
    const aad = quoted(value(text, 'AAD'));
    const ct = quoted(value(text, 'ct'));

    expect(await hkdfRaw(prf, salt, info)).toBe(value(text, 'AES key (HKDF)'));
    expect(decode(buildAad({ ...IDS, share: 'B' }))).toBe(aad);
    expect(await decryptWith(value(text, 'AES key (HKDF)'), iv, aad, ct)).toEqual(SHARE);

    fixRandom(salt, iv);
    const envelope = await sealShareB(SHARE, prf, IDS);
    expect(envelope).toMatchObject({ salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct });
    vi.restoreAllMocks();
    expect(await openShareB(envelope, prf, IDS)).toEqual(SHARE);
  });

  it('share A envelope', async () => {
    const text = block('Share A envelope');
    const [, first, last] = match(value(text, 'MASTER_KEY'), /bytes 0x([0-9a-f]{2})\.\.0x([0-9a-f]{2})/);
    const masterKey = Uint8Array.from({ length: Number.parseInt(last!, 16) - Number.parseInt(first!, 16) + 1 }, (_, i) => Number.parseInt(first!, 16) + i);
    const salt = repeated(value(text, 'salt'));
    const iv = repeated(value(text, 'iv'));
    const info = quoted(value(text, 'info'));
    const aad = quoted(value(text, 'AAD'));
    const ct = quoted(value(text, 'ct'));

    // `sealShareA` lives in apps/vault/server/kms.ts (it reads MASTER_KEY from the environment); it is exactly this
    // composition of core primitives, so the vector is checked with them, and the info template is checked in its source.
    const kms = readFileSync(fileURLToPath(new URL('../../../apps/vault/server/kms.ts', import.meta.url)), 'utf8');
    expect(kms).toContain('`wl-embedded-wallet/share-a/kms/v1|${slot.userId}|${slot.setId}`');
    expect(info).toBe(`wl-embedded-wallet/share-a/kms/v1|${USER_ID}|${SET_ID}`);

    expect(await hkdfRaw(masterKey, salt, info)).toBe(value(text, 'AES key (HKDF)'));
    expect(decode(buildAad({ ...IDS, share: 'A' }))).toBe(aad);
    expect(await decryptWith(value(text, 'AES key (HKDF)'), iv, aad, ct)).toEqual(SHARE);

    fixRandom(salt, iv);
    const envelope = await sealEnvelope({
      slot: { ...IDS, share: 'A' },
      kdf: 'kms',
      kdfParams: {},
      plaintext: SHARE,
      deriveKey: (s) => hkdfAesKey(masterKey, s, info),
    });
    expect(envelope).toMatchObject({ salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct });
  });

  it('recovery code', () => {
    const text = block('Recovery code');
    const entropy = hexDecode(value(text, 'entropy'));
    const code = value(text, 'code');
    const grouped = value(text, 'grouped');
    const [, typed, normalized] = match(text, /normalize\("([^"]+)"\)\s*=\s*(\S+)/);

    fixRandom(entropy);
    expect(generateRecoveryCode()).toBe(grouped);
    vi.restoreAllMocks();
    expect(normalizeRecoveryCode(grouped)).toBe(code);
    expect(normalizeRecoveryCode(typed!)).toBe(normalized);
    expect(normalized).toBe(code);
  });

  it('share C envelope', async () => {
    const text = block('Share C envelope');
    const password = quoted(value(text, 'password'));
    const salt = repeated(value(text, 'salt'));
    const iv = repeated(value(text, 'iv'));
    const params = argon2Params(text);
    const derived = value(text, match(text, /Argon2id\([^)]*\)/)[0]);
    const aad = quoted(value(text, 'AAD'));
    const ct = quoted(value(text, 'ct'));

    expect(params).toEqual(DEFAULT_ARGON2_PARAMS);
    expect(recoveryCodeToBytes(password)).toEqual(utf8(password));
    expect(await argon2Raw(utf8(password), salt, params)).toBe(derived);
    expect(decode(buildAad({ ...IDS, share: 'C' }))).toBe(aad);
    expect(await decryptWith(derived, iv, aad, ct)).toEqual(SHARE);

    fixRandom(salt, iv);
    const envelope: Envelope = await sealShareC(SHARE, recoveryCodeToBytes(password), IDS);
    expect(envelope).toMatchObject({ kdfParams: params, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct });
  });

  it('seed backup', async () => {
    const text = block('Seed backup');
    const mnemonic = quoted(value(text, 'mnemonic'));
    const owner = token(text, 'owner');
    const aad = quoted(value(text, 'AAD'));
    const password = quoted(value(text, 'password'));
    const salt = repeated(value(text, 'salt'));
    const iv = repeated(value(text, 'iv'));
    const derived = value(text, 'Argon2id(defaults)');
    const ct = quoted(value(text, 'ct'));

    expect(deriveOwner(mnemonic)).toBe(owner);
    expect(decode(seedBackupAad(owner))).toBe(aad);
    expect(await argon2Raw(utf8(password), salt, DEFAULT_ARGON2_PARAMS)).toBe(derived);
    expect(decode(await decryptWith(derived, iv, aad, ct))).toBe(mnemonic);

    fixRandom(salt, iv);
    const backup = await sealSeedBackup(mnemonic, recoveryCodeToBytes(password), owner);
    expect(backup).toEqual({ v: 1, kdf: 'argon2id', kdfParams: DEFAULT_ARGON2_PARAMS, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct });
    vi.restoreAllMocks();
    expect(await openSeedBackup(backup, recoveryCodeToBytes(password), owner)).toBe(mnemonic);
  });

  it('Safe address', () => {
    const text = block('Safe address');
    expect(predictSafeAddress(token(text, 'owner'))).toBe(token(text, 'Safe (defaults)'));
  });

  it('manifest signature', async () => {
    const prose = between(SECTION, '\n### Manifest signature\n', '```');
    const text = block('Manifest signature');
    const [, a, b, c] = match(prose, /dummy shares `([0-9a-f]+)`, `([0-9a-f]+)`, `([0-9a-f]+)`/);
    const owner = token(block('Safe address'), 'owner');

    expect(await shareDigest(a!)).toBe(value(text, `shareDigest("${a}")`));
    const manifest = buildManifest({
      ...IDS,
      shareDigests: { A: await shareDigest(a!), B: await shareDigest(b!), C: await shareDigest(c!) },
      expectedAddress: owner,
      wdkUtilsVersion: match(prose, /`wdkUtilsVersion = "([^"]+)"`/)[1]!,
      createdAt: match(prose, /`createdAt = "([^"]+)"`/)[1]!,
    });
    const canonical = canonicalize(manifest);
    expect(canonical).toBe(value(text, 'canonical JSON'));
    expect(manifest.smartAccount.address).toBe(token(block('Safe address'), 'Safe (defaults)'));
    expect(await sha256Hex(utf8(canonical))).toBe(value(text, 'SHA-256(canonical)'));

    const signingKey = hexEncode(repeated(value(text, 'signing key')));
    const publicKey = value(text, 'public key');
    expect(hexEncode(ed25519.getPublicKey(hexDecode(signingKey)))).toBe(publicKey);
    const signature = quoted(value(text, 'signature'));
    expect(signManifest(manifest, signingKey).signature).toBe(signature);
    expect(() => verifyManifest({ manifest, signature }, publicKey)).not.toThrow();
  });

  it('SafeMessage hash', () => {
    const text = block('SafeMessage hash');
    const hash = requestHash({ kind: 'message', message: quoted(value(text, 'message')) });
    expect(hash).toBe(value(text, 'requestHash'));
    const [, chainId, safe] = match(text, /chainId\s*=\s*(\d+),\s*Safe\s*=\s*(0x[0-9a-fA-F]{40})/);
    expect(hashTypedData(safeMessageTypedData(safe as `0x${string}`, Number(chainId), hash))).toBe(value(text, 'SafeMessage hash'));
  });

  it('relink typed data hash', () => {
    const text = block('Relink typed data hash');
    const fields = Object.fromEntries(
      [...between(text, '{', '}').matchAll(/(\w+):\s*("[^"]*"|[^,\s]+)/g)].map(([, key, raw]) => [key!, raw!.replace(/^"|"$/g, '')]),
    );
    const challenge = {
      safe: fields.safe as `0x${string}`,
      owner: fields.owner as `0x${string}`,
      newSub: fields.newSub!,
      issuer: fields.issuer!,
      vaultOrigin: fields.vaultOrigin!,
      nonce: fields.nonce!,
      expiresAt: Number(fields.expiresAt),
    };
    expect(Object.keys(fields).sort()).toEqual(Object.keys(challenge).sort());
    expect(hashTypedData(relinkTypedData(challenge))).toBe(value(text, 'EIP-712 hash'));

    // Section 19 states the domain and purpose that the hash above commits to.
    const spec = between(SPEC, '\n## 19. Relink authorization\n', '\n## 20.');
    const typed = relinkTypedData(challenge);
    expect(typed.domain).toEqual({ name: match(spec, /domain\s*=\s*\{ name: "([^"]+)"/)[1], version: match(spec, /version: "([^"]+)" \}/)[1] });
    expect(typed.message.purpose).toBe(match(spec, /name: "purpose",.*\/\/ "([^"]+)"/)[1]);
  });
});
