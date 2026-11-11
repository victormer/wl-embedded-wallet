# Cryptographic specification

This document specifies every cryptographic format and procedure in `wl-embedded-wallet` 0.1.0 precisely enough to reimplement it. The reference implementation is `packages/core/src/` (`@wl-embedded-wallet/core`); the server-side share A sealing is in `apps/vault/server/kms.ts`, and the browser-side WebAuthn calls are in `apps/vault/lib/prf.ts`. Where this document and the code disagree, the code is authoritative and the disagreement is a documentation bug.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) (where each step runs), [PROTOCOL.md](PROTOCOL.md) (app and vault messages, handoff token), [HTTP-API.md](HTTP-API.md) (what the server accepts and returns), [THREAT-MODEL.md](THREAT-MODEL.md) (what these mechanisms protect against), [RECOVERY.md](RECOVERY.md) (how the formats are used to recover), [DECISIONS.md](DECISIONS.md) (rationale).

## Contents

1. [Overview](#1-overview)
2. [Notation and encodings](#2-notation-and-encodings)
3. [Identifiers](#3-identifiers)
4. [Seed and owner key](#4-seed-and-owner-key)
5. [Shamir secret sharing](#5-shamir-secret-sharing)
6. [Envelopes](#6-envelopes)
7. [Share A: server sealing](#7-share-a-server-sealing)
8. [Share B: passkey PRF](#8-share-b-passkey-prf)
9. [Recovery code](#9-recovery-code)
10. [Share C: recovery code](#10-share-c-recovery-code)
11. [Seed backup](#11-seed-backup)
12. [Manifest](#12-manifest)
13. [Enrollment procedure](#13-enrollment-procedure)
14. [Reconstruction and verification order](#14-reconstruction-and-verification-order)
15. [Emergency kit](#15-emergency-kit)
16. [Exported seed file](#16-exported-seed-file)
17. [Safe smart account](#17-safe-smart-account)
18. [Signatures](#18-signatures)
19. [Relink authorization](#19-relink-authorization)
20. [Other random values](#20-other-random-values)
21. [Versioned labels](#21-versioned-labels)
22. [Test vectors](#22-test-vectors)
23. [Known gaps in this specification](#23-known-gaps-in-this-specification)

## 1. Overview

A 12-word BIP-39 mnemonic (the **seed**) controls a single EOA, the **owner**, which is the only owner of a Safe 4337 smart account (the user's **account address**). The seed is never stored anywhere in one piece. At enrollment it is split 2-of-3 with Shamir secret sharing, and each share is protected by a different factor:

| Share | Stored by | Protected by | Key derivation |
|---|---|---|---|
| A | Vault database | Server master key (`MASTER_KEY`, a stand-in for a KMS) | HKDF-SHA256, AES-256-GCM |
| B | Vault database and Emergency Kit | Passkey: WebAuthn PRF extension output | HKDF-SHA256, AES-256-GCM |
| C | Vault database and Emergency Kit | Recovery code (128 bits) | Argon2id, AES-256-GCM |

Any two shares rebuild the seed, always inside a dedicated Web Worker on the vault origin (or in the offline tool). A **manifest** signed by the vault with Ed25519 binds the set together: the SHA-256 digest of each share, the owner address, the Safe parameters and the format versions. The Emergency Kit additionally carries a **seed backup**, the mnemonic encrypted under the recovery code, so that kit plus code alone recover the seed with no passkey and no server.

All symmetric encryption is AES-256-GCM with a fresh random 16-byte salt (for the KDF) and 12-byte IV per encryption, and an additional authenticated data (AAD) string that binds the ciphertext to its slot.

## 2. Notation and encodings

- `||` is byte concatenation. `"..."` is a UTF-8 string. `{x}` inside a label is substituted with the value of `x` with no quoting or escaping.
- `SHA-256(x)` is FIPS 180-4 SHA-256. `HKDF-SHA256(ikm, salt, info, L)` is RFC 5869 with SHA-256, output length `L` bytes, as implemented by WebCrypto `deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info })` into `{ name: 'AES-GCM', length: 256 }` (so `L = 32`).
- `AES-256-GCM(key, iv, aad, plaintext)` is NIST SP 800-38D with a 96-bit IV and a 128-bit tag, as implemented by WebCrypto. The output is `ciphertext || tag` (the tag is the last 16 bytes); the format never separates them.
- Derived AES keys are imported as non-extractable WebCrypto keys.

### base64url

Binary values in JSON (salts, IVs, ciphertexts, signatures, credential ids, challenges) use **unpadded base64url** (RFC 4648 section 5, alphabet `A-Z a-z 0-9 - _`, no `=`).

Decoding (`b64urlDecode` in `packages/core/src/encoding.ts`) is strict and **canonical**: the input must match `^[A-Za-z0-9_-]*$`, its length must not be `1 (mod 4)`, and re-encoding the decoded bytes must reproduce the input exactly. The last rule rejects encodings with non-zero padding bits, so every byte string has exactly one accepted text form. Any decoding failure is reported as the error of the enclosing operation (for example `DECRYPT_FAILED`), never as a distinct error.

Shape validation (`isB64url` in `schema.ts`) additionally requires a non-empty value of at most 4096 characters by default (1024 for a credential id in the API, 8192 for WebAuthn assertion fields).

### hex

- Shamir shares and share digests are **lowercase** hex with an even number of digits (`^(?:[0-9a-f]{2})+$`; shares at most 256 characters, digests exactly 64).
- Keys in environment variables (`MASTER_KEY`, `MANIFEST_SIGNING_KEY`) and the manifest public key are 32 bytes as 64 hex digits. The manifest public key must be lowercase where it is validated (static page builder, runtime config).
- `hexDecode` itself accepts either case; the lowercase rules above are enforced by the schema checks.
- EVM addresses and hashes use the usual `0x`-prefixed hex. Addresses are compared case-insensitively everywhere in the core; the manifest stores them in EIP-55 checksum form as produced by viem.

### Text

Strings are encoded to bytes as UTF-8 (`TextEncoder`). The seed backup plaintext is decoded with a fatal UTF-8 decoder.

## 3. Identifiers

| Identifier | Format | Source |
|---|---|---|
| `userId` | The integrator's `sub`: `^[A-Za-z0-9_-]{1,64}$` (enforced at token redemption, see [PROTOCOL.md](PROTOCOL.md#claims-and-validation)) | Handoff token |
| `setId` | Lowercase UUID, versions 1 to 8: `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. The vault UI generates it with `crypto.randomUUID()` (version 4). | Browser, at enrollment |
| `credentialId` | base64url of the WebAuthn credential `rawId` | Authenticator |
| share names | `A`, `B`, `C` | Fixed |

Because `userId` cannot contain `|` and `setId` is a UUID, the `|`-separated labels below are unambiguous.

`userId` in the manifest and in the envelopes is the `sub` under which the set was **created**. After a [relink](#19-relink-authorization) the set belongs to a different `sub`, but the manifest and the AADs keep the original value; the server opens share A with the manifest's `userId`, not the session's.

## 4. Seed and owner key

- **Seed:** a BIP-39 English mnemonic of 12 words (128 bits of entropy), generated in the worker with `generateMnemonic(wordlist, 128)` from `@scure/bip39` (English wordlist). Words are separated by single ASCII spaces. No BIP-39 passphrase is ever used.
- **Owner key:** BIP-32 secp256k1 key at derivation path `m/44'/60'/0'/0/0` (`DERIVATION_PATH`), derived with viem's `mnemonicToAccount(mnemonic, { path })`. Its Ethereum address is the **owner address**, stored in the manifest as `expectedAddress`.
- **Account address:** the Safe predicted for that owner ([section 17](#17-safe-smart-account)), stored as `smartAccount.address`.

A rotation (re-enrollment from an existing set) reuses the same seed, so the owner and the Safe never change. See [THREAT-MODEL.md](THREAT-MODEL.md) for what that implies.

## 5. Shamir secret sharing

Splitting and combining are delegated to `@tetherto/wdk-utils` at exactly version **`1.0.0-beta.16`** (pinned without a range in every `package.json`), functions `splitMnemonic` and `combineMnemonic`. The core wrappers `verifyRecovery` and `recoverMnemonic` in `packages/core/src/shamir.ts` follow the WDK guide's examples, which are not package exports.

### Parameters

`n = 3` shares (`SHARES_N`), threshold `k = 2` (`SHARES_K`). The shares are named `A`, `B`, `C` in the order `splitMnemonic` returns them.

### What wdk-utils does (informative)

As read from `@tetherto/wdk-utils@1.0.0-beta.16` (`src/shamir/index.js`), which itself uses `shamir-secret-sharing@0.0.4`:

1. The mnemonic is normalized (trimmed, whitespace collapsed) and decoded to its BIP-39 entropy (16 bytes for 12 words).
2. A 4-byte integrity prefix is attached: `secret = SHA-256(entropy)[0..4] || entropy` (20 bytes).
3. `secret` is split with Shamir over GF(2^8) into `n` shares with threshold `k`. Each share is the 20 evaluated bytes followed by a 1-byte x-coordinate.
4. Each share is returned as lowercase hex: **42 hex characters** (21 bytes) for a 12-word seed.

`combineMnemonic` rejects inputs that are not even-length hex, or whose last byte (the x-coordinate) is `00`, combines, checks the 4-byte prefix and re-encodes the entropy as an English mnemonic. The prefix is error detection, not authentication: a forged share is caught by the manifest digests, not by wdk-utils.

The share hex format is recorded in the manifest as `format: "bip39-en/wdk-utils-hex"` and the library version as `wdkUtilsVersion`. Any change in wdk-utils' share format is a breaking change that requires a new `format` value.

### Share digests

`shareDigest(share) = lowercase_hex(SHA-256(hex_decode(share)))`, the digest of the share **bytes**, not of the hex text. The manifest carries one digest per share name.

### Enrollment self-check

Right after splitting, the worker runs `verifyRecovery(mnemonic, pair, { threshold: 2, verifyShare })` for **each of the three pairs** `(A,B)`, `(A,C)`, `(B,C)`: every share in the pair must match its digest, and combining the pair must return exactly the original mnemonic. Enrollment aborts (`SHARE_TAMPERED` or `COMBINE_FAILED`) if any pair fails.

### Wrapper rules

Both wrappers reject (`COMBINE_FAILED`) when the share list is not an array, has more than 255 entries or fewer than `threshold`, when `threshold` is not an integer in `[2, 255]`, or when no `verifyShare` callback is given. `recoverMnemonic` authenticates **every** share with `verifyShare` before combining (`SHARE_TAMPERED` on any failure or exception), then requires `matchesExpectedWallet(mnemonic)` to be exactly `true` (`ADDRESS_MISMATCH` otherwise) before returning the seed.

## 6. Envelopes

Shares A, B and C are each stored as an **envelope**, a JSON object:

```json
{
  "v": 1,
  "share": "B",
  "userId": "alice",
  "setId": "11111111-1111-4111-8111-111111111111",
  "kdf": "prf-hkdf-sha256",
  "kdfParams": { "hash": "SHA-256", "prfSaltLabel": "wl-embedded-wallet/share-b/prf/v1" },
  "salt": "<base64url, 16 bytes>",
  "iv": "<base64url, 12 bytes>",
  "ct": "<base64url, AES-256-GCM ciphertext || 16-byte tag>"
}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Envelope format version. |
| `share` | `"A"`, `"B"`, `"C"` | Share name. |
| `userId`, `setId` | string | Slot identity, see [section 3](#3-identifiers). |
| `kdf` | `"kms"` (A), `"prf-hkdf-sha256"` (B), `"argon2id"` (C) | Key derivation family. |
| `kdfParams` | object | `{}` for A; `{ "hash": "SHA-256", "prfSaltLabel": "wl-embedded-wallet/share-b/prf/v1" }` for B (informative only, never read when opening); the Argon2id parameters for C ([section 10](#10-share-c-recovery-code)). |
| `salt` | base64url | 16 random bytes (`SALT_BYTES`), the KDF salt. Fresh per encryption. |
| `iv` | base64url | 12 random bytes (`IV_BYTES`), the GCM IV. Fresh per encryption. |
| `ct` | base64url | AES-256-GCM output over the share **bytes** (hex-decoded share). |

### AAD

```
AAD = UTF-8("wl-embedded-wallet/envelope/v1|{userId}|{setId}|{share}")
```

### Sealing

```
salt = random(16); iv = random(12)
key  = derive(salt)                       // per share, sections 7, 8, 10
ct   = AES-256-GCM(key, iv, AAD(slot), share_bytes)
```

### Opening

Opening (`openEnvelope`) takes the envelope **and the expected slot**, which always comes from the signed manifest (`manifest.userId`, `manifest.setId`, the share name), never from the envelope's own fields. Otherwise an attacker could replace a whole envelope and its header together and still pass the AAD check.

1. Reject unless `v === 1`, `share`, `userId`, `setId` equal the expected slot and `kdf` equals the expected KDF for that share.
2. Decode `salt`, `iv`, `ct` (canonical base64url); reject unless `salt` is 16 bytes and `iv` 12 bytes.
3. Derive the key from `salt` and decrypt with the AAD built from the **expected** slot.

Every failure in these steps, including a bad tag, is reported as `DECRYPT_FAILED`, with no further detail. In particular, a wrong passkey, a wrong recovery code and a tampered envelope are indistinguishable.

Shape checks before use (`isEnvelope` in `schema.ts`, applied to kits and to `POST /api/shares`): `v === 1`, the expected `share` and `kdf`, `userId` a string, `setId` a string of at most 64 characters, `kdfParams` an object, and `salt`, `iv`, `ct` non-empty base64url of at most 4096 characters. Extra fields are not rejected by this check.

## 7. Share A: server sealing

Share A travels from the worker to the server **in plaintext hex** inside the TLS-protected `POST /api/shares` body, and the server seals it (`sealShareA` in `apps/vault/server/kms.ts`). This is a stand-in for a real KMS or HSM; see [THREAT-MODEL.md](THREAT-MODEL.md#accepted-risks).

```
MK   = hex_decode(MASTER_KEY)             // exactly 32 bytes, else the operation throws
info = "wl-embedded-wallet/share-a/kms/v1|{userId}|{setId}"
key  = HKDF-SHA256(ikm = MK, salt = envelope.salt, info, L = 32)
envelope.kdf = "kms", envelope.kdfParams = {}
```

The envelope is then sealed and opened exactly as in [section 6](#6-envelopes). The server releases share A as plaintext hex (`GET /api/shares/a`) to an authenticated session; it is not encrypted to the client. The client authenticates it with the manifest digest. A `DECRYPT_FAILED` on the server side (wrong `MASTER_KEY` or corrupted row) is reported to the client as `SERVER_KEY_MISMATCH`.

## 8. Share B: passkey PRF

### Passkey creation

`registerPasskeyWithPrf` (`apps/vault/lib/prf.ts`) calls `navigator.credentials.create` with:

| Option | Value |
|---|---|
| `rp` | `{ id: RP_ID, name: <brand name> }` |
| `user.id` | `SHA-256(UTF-8("{userId}|{setId}"))`, 32 bytes (`passkeyUserHandle`). Per set, so that a new passkey does not overwrite the previous set's passkey in the provider before the new set is verified. |
| `user.name`, `user.displayName` | `userId` |
| `challenge` | 32 bytes issued by `POST /api/webauthn/challenge` (or 32 random bytes if no server challenge is available, in which case no public key is registered) |
| `pubKeyCredParams` | COSE `-8` (EdDSA), `-7` (ES256), `-257` (RS256), in that order |
| `authenticatorSelection` | `residentKey: "required"`, `requireResidentKey: true`, `userVerification: "required"` |
| `timeout` | 60 000 ms |
| `extensions` | `{ credProps: true, prf: { eval: { first: PRF_SALT } } }` |

If the PRF output is returned by `create` it is used; otherwise, if `prf.enabled === true`, a `get` assertion with the same PRF input is performed immediately. If neither yields an output, enrollment aborts (`PRF_UNSUPPORTED` or `PRF_NOT_RETURNED`). **There is no fallback for authenticators without PRF.**

The registration JSON sent to the server is copied field by field (`id`, `rawId`, `type`, `clientDataJSON`, `attestationObject`, `transports`, and `credProps.rk` only), so that the PRF output, which a browser's `toJSON()` might include, never leaves the browser.

### PRF input and output

```
PRF_SALT = SHA-256(UTF-8("wl-embedded-wallet/share-b/prf/v1"))     // 32 bytes, fixed and public
prf      = clientExtensionResults.prf.results.first                 // must be exactly 32 bytes
```

The PRF input is the same for every user and credential; the per-credential secret is supplied by the authenticator. This is what allows a discoverable passkey to produce the PRF output in the same assertion that identifies it to the server ([kit-free recovery](RECOVERY.md)). Per the WebAuthn Level 3 PRF extension, the client further hashes the input with the `"WebAuthn PRF"` context before it reaches the authenticator's `hmac-secret`; this is browser behavior, not code in this repository.

An output that is missing or not 32 bytes is rejected (`PRF_NOT_RETURNED`). Assertions use `userVerification: "required"` and a 60 s timeout; when the credential is known, `allowCredentials` contains only that credential id.

### Key derivation

```
info = "wl-embedded-wallet/share-b/aes/v1|{userId}|{setId}"
key  = HKDF-SHA256(ikm = prf, salt = envelope.salt, info, L = 32)
envelope.kdf = "prf-hkdf-sha256"
envelope.kdfParams = { "hash": "SHA-256", "prfSaltLabel": "wl-embedded-wallet/share-b/prf/v1" }
```

The PRF output buffer is transferred to the worker (`postMessage` transfer list), so it is detached from the main thread, and the worker overwrites it with zeros after the operation.

## 9. Recovery code

### Generation

`generateRecoveryCode()`:

1. `entropy = random(16)` (128 bits, `crypto.getRandomValues`).
2. Encode with Crockford base32, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, packing bits most significant first, 5 bits per character; the final partial group (3 bits) is left-shifted into the high bits of the last character (2 zero padding bits). Result: **26 characters**.
3. Display grouped by 4 characters with `-`: `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX` (6 groups of 4 and one of 2).

The code is shown once and never stored by the vault.

### Normalization

`normalizeRecoveryCode(input)`:

1. Uppercase.
2. Remove every whitespace character and `-`.
3. Map `I` and `L` to `1`, and `O` to `0`.
4. Require exactly 26 characters, all in the alphabet; otherwise `BAD_RECOVERY_CODE`. (`U` is not in the alphabet and is rejected.)

The **key material is the 26 ASCII bytes of the normalized code**, not the decoded 128-bit entropy. A reimplementation must therefore derive keys from the normalized text. The padding bits of the last character are not checked, so a typed code whose last character differs only in those bits is a different (wrong) code.

The code is passed to the worker as those 26 bytes in a transferable buffer, and the worker overwrites it after the operation. Every function that consumes code bytes first checks that they are exactly 26 alphabet characters (`assertRecoveryCodeBytes`).

### Confirmation

During enrollment the user re-types two randomly chosen groups (indices `0..6`, from `pickConfirmationGroups(2)`). Answers are normalized like the code. This is a usability check only; it has no cryptographic role.

## 10. Share C: recovery code

```
password = ASCII(normalized code)            // 26 bytes
key      = Argon2id(password, salt = envelope.salt, params)    // 32 bytes, used directly as the AES-256 key
envelope.kdf = "argon2id"
envelope.kdfParams = { memorySize, iterations, parallelism, hashLength }
```

Argon2id is computed with `hash-wasm@4.12.0` (`argon2id`, binary output; hash-wasm implements Argon2 version 0x13). There is no HKDF step: the Argon2id output is imported directly as a non-extractable AES-GCM key and the raw output buffer is zeroed.

### Parameters

| Parameter | Default (`DEFAULT_ARGON2_PARAMS`) | Accepted when opening (`parseArgon2Params`) |
|---|---|---|
| `memorySize` (KiB) | 65536 (64 MiB) | integer in `[8 * parallelism, 1048576]` |
| `iterations` | 3 | integer in `[1, 10]` |
| `parallelism` | 1 | integer in `[1, 4]` |
| `hashLength` | 32 | exactly 32 |

`kdfParams` is read from the envelope, which is untrusted when it comes from a kit: the bounds stop a tampered kit from forcing a denial-of-service through huge parameters (`KDF_PARAMS_INVALID`). Parameters inside the bounds but different from the ones used at sealing simply produce a wrong key and `DECRYPT_FAILED`. New sets are always sealed with the defaults.

## 11. Seed backup

The seed backup is the mnemonic encrypted under the recovery code. It exists **only in the Emergency Kit** (kit `v: 2`). The server never receives it: `POST /api/shares` rejects any body that contains a `seedBackup` key, and the e2e suite intercepts all enrollment traffic to check it.

### Format

```json
{
  "v": 1,
  "kdf": "argon2id",
  "kdfParams": { "memorySize": 65536, "iterations": 3, "parallelism": 1, "hashLength": 32 },
  "salt": "<base64url, 16 bytes>",
  "iv": "<base64url, 12 bytes>",
  "ct": "<base64url, AES-256-GCM ciphertext || tag>"
}
```

Shape check (`isSeedBackup`): exactly these keys and no others (an extra key invalidates the kit), `v === 1`, `kdf === "argon2id"`, `kdfParams` an object, `salt`, `iv`, `ct` base64url.

### Sealing and opening

```
AAD       = UTF-8("wl-embedded-wallet/seed-backup/v1|{lowercase(owner)}")
key       = Argon2id(ASCII(normalized code), salt, params)          // own salt, never the salt of C
ct        = AES-256-GCM(key, iv, AAD, UTF-8(mnemonic))
```

- `owner` is the owner address as **expected from the signed manifest** (`manifest.expectedAddress`), lowercased, including the `0x` prefix. It is never taken from the backup itself. A backup moved into another user's kit therefore fails to decrypt.
- The label differs from the envelope AAD, so a seed backup cannot be confused with share C even though both use the same code and the same Argon2id parameters.
- Each backup has its own salt and IV; its key never equals C's key.
- `params` are C's parameters (`parseArgon2Params(encC.kdfParams)`), bounded as in [section 10](#10-share-c-recovery-code) when opening.
- Plaintext is decoded as strict UTF-8. All failures, including a wrong code, a tampered field, out-of-range sizes and a wrong owner, are `DECRYPT_FAILED` (except out-of-bounds Argon2id parameters, `KDF_PARAMS_INVALID`, and a malformed code, `BAD_RECOVERY_CODE`).
- After sealing, the worker immediately opens the backup again and requires the original mnemonic back (`INTERNAL` otherwise) before anything is sent to the server.

After decrypting, the consumer must still check that the mnemonic derives the manifest's owner (and the offline tool also that the owner yields the kit's Safe), see [section 14](#14-reconstruction-and-verification-order).

## 12. Manifest

### Fields

| Field | Type | Value |
|---|---|---|
| `v` | number | `1` |
| `userId` | string | `sub` at creation |
| `setId` | string | UUID of the set |
| `n` | number | `3` |
| `k` | number | `2` |
| `format` | string | `"bip39-en/wdk-utils-hex"` |
| `wdkUtilsVersion` | string | Version of wdk-utils used to split, `^[0-9A-Za-z.+-]{1,64}$` (`"1.0.0-beta.16"` in this release) |
| `shareDigests` | object | `{ "A": hex64, "B": hex64, "C": hex64 }`, SHA-256 of each share's bytes |
| `expectedAddress` | string | Owner address (EIP-55) |
| `derivationPath` | string | `"m/44'/60'/0'/0/0"` |
| `smartAccount` | object | Safe parameters plus `address` ([section 17](#17-safe-smart-account)) |
| `createdAt` | string | ISO 8601 timestamp from the server clock |

The manifest is **built and signed by the server** from the values the worker submits (`buildManifest`, `signManifest` in `POST /api/shares`). The server cannot verify that `expectedAddress` corresponds to the shares, because it never sees B or C; it checks that share A matches its digest, that the Safe parameters are the current defaults for that owner (or exactly the active set's parameters on a rotation), and that the owner does not already belong to another user. The worker then checks that the returned manifest is exactly what it submitted ([section 13](#13-enrollment-procedure)).

### Canonical JSON

`canonicalize(value)`:

- Arrays: `[` + elements canonicalized in their original order, joined by `,` + `]`.
- Objects: entries whose value is `undefined` are dropped; the remaining keys are sorted by JavaScript string comparison (UTF-16 code unit order); output `{` + `JSON.stringify(key):canonicalize(value)` joined by `,` + `}`.
- Everything else: `JSON.stringify(value)` (throws if not serializable).
- No whitespace anywhere.

Example (from `packages/core/tests/manifest.test.ts`):

```
canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })
  = {"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}
```

For the values a manifest contains (ASCII strings, small integers, nested objects), this matches RFC 8785 (JCS) output. It is not claimed to be a complete JCS implementation for arbitrary input (for example it does not reject lone surrogates).

### Signature

```
message   = UTF-8(canonicalize(manifest))
signature = Ed25519-Sign(MANIFEST_SIGNING_KEY, message)       // RFC 8032, 64 bytes
signed    = { "manifest": manifest, "signature": base64url(signature) }
```

- `MANIFEST_SIGNING_KEY` is a 32-byte Ed25519 private key (seed) in hex, held by the vault server.
- The public key is derived from it at runtime and delivered to the browser inside the vault HTML (`data-manifest-pubkey` on `#vault-config`, see `apps/vault/lib/runtime-config.ts`). The static recovery page has it baked in at build time (`--manifest-pubkey`). It is **not** pinned in the JavaScript bundle.
- Verification uses `@noble/curves` `ed25519.verify(sig, msg, pub, { zip215: false })`: strict RFC 8032 verification, not the more permissive ZIP-215 rules. Any decoding or verification failure is `MANIFEST_INVALID`.

### Structural checks after the signature

- `assertManifestFormat`: `v === 1`, `format === "bip39-en/wdk-utils-hex"`, `n === 3`, `k === 2`, `derivationPath === "m/44'/60'/0'/0/0"`; otherwise `FORMAT_UNSUPPORTED`.
- `assertSmartAccount`: `smartAccount.type === "safe-4337"` and `smartAccount.safeModulesVersion === "0.3.0"` (`FORMAT_UNSUPPORTED` otherwise); the Safe address recomputed from `expectedAddress` and the manifest's own Safe parameters must equal `smartAccount.address` (`ADDRESS_MISMATCH` otherwise). A manifest alone therefore never decides which address is shown.
- `wdkUtilsVersion` different from the running library's version is **not** an error: the response carries `wdkVersionMismatch: true` and the UI shows a warning.

The kit parser and the API apply a looser shape check first (`isSignedManifest`): base64url `signature`, string `userId`, `setId`, `expectedAddress`, object `shareDigests` and `smartAccount`, string `smartAccount.address`.

## 13. Enrollment procedure

The worker operation `enroll` (`packages/core/src/signer.ts`). Inputs: `userId`, `setId`, `credentialId`, the PRF output, the code bytes, and optionally a `source` (an existing set to rotate, see below), `linkedOwner` and the passkey `registration`.

1. If `source` is present and its manifest's `userId` differs from `userId`, reject (`MANIFEST_INVALID`) unless its `expectedAddress` equals `linkedOwner` (the owner the server says this session's account holds, which covers sets moved by a relink).
2. Seed: with `source`, reconstruct it from the source ([section 14](#14-reconstruction-and-verification-order)); otherwise generate a new 12-word mnemonic.
3. `expectedAddress = owner(seed)`. `smartAccount` = the source manifest's `smartAccount` on a rotation (so the Safe never changes even if defaults change), else `smartAccountFor(expectedAddress)` with the current defaults.
4. `[A, B, C] = splitMnemonic(seed, { shares: 3, threshold: 2 })`; compute the three digests.
5. `verifyRecovery` on each of the three pairs ([section 5](#enrollment-self-check)).
6. `encB = sealShareB(B, prf, { userId, setId })`, `encC = sealShareC(C, code, { userId, setId })` with the default Argon2id parameters. The share byte buffers are zeroed.
7. `seedBackup = sealSeedBackup(seed, code, expectedAddress, params(encC))`, then re-open it and compare.
8. `POST /api/shares` with `{ setId, credentialId, shareA: A, encB, encC, shareDigests, expectedAddress, smartAccount, wdkUtilsVersion, registration? }` (never the seed backup). The server seals A and returns the signed manifest.
9. Verify the returned signed manifest: signature, format, Safe recomputation, and exact equality of `userId`, `setId`, `expectedAddress`, `canonicalize(smartAccount)` and `canonicalize(shareDigests)` with what was sent (`MANIFEST_INVALID` otherwise).
10. Return `{ signed, encB, encC, seedBackup }` to the vault page, which builds the kit ([section 15](#15-emergency-kit)).

The set is stored as `pending`. The vault page then requires the user to download the recovery tool and the kit, performs a **drill**: a fresh passkey assertion, a re-read of the set from the server and a full A+B reconstruction that must yield the same Safe address, and only then activates the set (`PATCH /api/shares`), which revokes any previous active set and deletes its encrypted shares.

## 14. Reconstruction and verification order

Every worker operation that needs the seed calls `recoverSeed` with one of four combinations. The order is fixed:

1. **Manifest signature** (`verifyManifest`, `MANIFEST_INVALID`).
2. **Manifest format** (`assertManifestFormat`, `FORMAT_UNSUPPORTED`).
3. **Safe recomputation** (`assertSmartAccount`, `FORMAT_UNSUPPORTED` or `ADDRESS_MISMATCH`).
4. Then, by combination:

| Combination | Steps |
|---|---|
| `A+B` | Decrypt B with the PRF output; **then** fetch A from the server (`GET /api/shares/a`). |
| `A+C` | Decrypt C with the code; **then** fetch A. |
| `B+C` | Decrypt B and C. No server call. |
| `kit+code` | Decrypt the seed backup with the code and the manifest's owner as AAD; require `owner(seed) == expectedAddress` (`ADDRESS_MISMATCH`); done. No shares, no server call. |

5. For the share combinations: verify **each** share's digest against `manifest.shareDigests[name]` (`SHARE_TAMPERED`), combine (`COMBINE_FAILED`), and require `owner(seed) == manifest.expectedAddress` compared as full addresses, case-insensitively (`ADDRESS_MISMATCH`).

Local shares are decrypted before share A is requested, so a wrong passkey or code never causes share A to be released.

Operation-specific gates, all inside the worker:

| Operation | Combination | Additional checks |
|---|---|---|
| `recover` | any | none (returns address and owner only) |
| `sign` | A+B | Request shape; chain status fetched by the worker from the server must have the requested `chainId` (`CHAIN_MISMATCH`) and `deployed: true` (`WALLET_NOT_DEPLOYED`), checked **before** reconstruction |
| `deploy` | A+B | Manifest signature and Safe recomputation; chain status not deployed and deployable (`CHAIN_NOT_SUPPORTED`); the UserOperation must be exactly this owner's Safe deployment (`isDeploymentOperation`, `INTERNAL` otherwise); only then reconstruction |
| `export` | A+B | Returns the mnemonic to the vault page |
| `sign-recovered` | B+C or kit+code | `chainId` a positive safe integer; no chain or server check |
| `export-recovered` | B+C or kit+code | Returns the mnemonic to the vault page |
| `sign-relink` | B+C or kit+code | Challenge `owner` and `safe` must equal the manifest's (`ADDRESS_MISMATCH`) before reconstruction |
| `upgrade-kit` | A+B or B+C | After reconstruction, also decrypts the given `encC` with the code and checks its digest (`SHARE_TAMPERED`), then seals a new seed backup |
| `enroll` | none, or A+C, B+C, kit+code as `source` | [Section 13](#13-enrollment-procedure) |

The worker never throws: it returns `{ ok: false, code }` with only an error code. A successful response carries the Safe address, the owner address, `wdkVersionMismatch` and, depending on the operation, a signature, a UserOperation, the enrollment output or a new seed backup. **Only `export` and `export-recovered` return the mnemonic.** Each operation runs in a new worker that replies once and closes; secret input buffers (PRF output, code bytes) are transferred in and zeroed in a `finally` block. JavaScript strings (the mnemonic, hex shares) cannot be wiped.

## 15. Emergency Kit

The kit is a JSON file the user downloads at enrollment, at rotation, and when upgrading an old kit. It **never contains share A**.

### Version 2 (current)

```json
{
  "v": 2,
  "rpId": "vault.example.com",
  "credentialId": "<base64url>",
  "encB": { "...": "share B envelope" },
  "encC": { "...": "share C envelope" },
  "manifest": { "...": "manifest" },
  "signature": "<base64url Ed25519 signature of the manifest>",
  "seedBackup": { "...": "seed backup" }
}
```

### Version 1 (legacy, still readable)

The same without `seedBackup`. A `v: 1` kit cannot recover without the passkey: it supports B+C (and A+C through the vault, which reads C from the server). The vault offers to generate a `v: 2` kit (operation `upgrade-kit`) after an A+B unlock or a B+C recovery; the new kit contains the same `encB`, `encC` and manifest and a new seed backup under the same code.

`buildKit` emits `v: 2` exactly when a seed backup is supplied, else `v: 1`. The vault always supplies one for new sets.

### Parse rules (`parseKit`)

The input is rejected (returns `null`, surfaced as `INVALID_KIT`) unless:

1. It parses as JSON and is an object (not an array).
2. `rpId` is a string and `credentialId` is valid base64url.
3. If `v === 1`, the object has **no** `seedBackup` key. Otherwise `v` must be exactly `2` and `seedBackup` must pass the strict seed backup shape check.
4. `encB` is an envelope shape with `share: "B"`, `kdf: "prf-hkdf-sha256"`; `encC` with `share: "C"`, `kdf: "argon2id"`.
5. `{ manifest, signature }` passes the signed manifest shape check.

Other top-level keys are ignored. Parsing checks shape only: authenticity comes from decryption and, inside the vault, from the manifest signature. The vault additionally requires `kit.rpId` to equal its own `RP_ID` before using a kit (`WRONG_RP`). The offline tool does not check `rpId` and **does not verify the manifest signature**; see [RECOVERY.md](RECOVERY.md).

The vault writes the kit with `JSON.stringify(kit, null, 2)` as `wl-embedded-wallet-kit-{first 8 characters of setId}.json`, MIME type `application/json`.

## 16. Exported seed file

`export` and `export-recovered` download a plain-text file, generated in memory and not kept in any state (`apps/vault/lib/seed-file.ts`):

```
Your wallet seed

<mnemonic>

Address: <owner address>
Derivation path: m/44'/60'/0'/0/0

Whoever has this file controls your funds. Store it offline and do not share it.
Rotating the shares does not change this seed: if it leaks, create a new wallet and move the funds.
```

File name: `wl-embedded-wallet-seed-{owner address characters 2..10, lowercase}.txt`. The address in the file is the **owner**, not the Safe. The vault records only the export time (`POST /api/shares/exported`), never the content.

## 17. Safe smart account

The account is a Safe with the Safe 4337 module, modules version **0.3.0**, EntryPoint **v0.7**, with a single owner (the owner address) and threshold 1, created through the Safe proxy factory with `CREATE2`. Address prediction and calldata use `abstractionkit@0.4.0` (`SafeAccountV0_3_0`), in `packages/core/src/safe.ts`.

### Parameters (`DEFAULT_SAFE_PARAMS`)

| Field | Value |
|---|---|
| `type` | `safe-4337` |
| `safeModulesVersion` | `0.3.0` |
| `entryPoint` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (abstractionkit `ENTRYPOINT_V7`) |
| `factory` | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| `singleton` | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| `singletonInitHash` | `0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee` |
| `safe4337Module` | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` |
| `safeModuleSetup` | `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` |
| `multisend` | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` |
| `saltNonce` | `0x69b348339eea4ed93f9d11931c3b894c8f9d8c7663a053024b11cb7eb4e5a1f6` |

The prediction is `SafeAccountV0_3_0.createAccountAddress([owner], overrides)` with `c2Nonce = saltNonce` and the addresses above. The Safe parameters contain nothing chain-specific, so **the account has the same address on every EVM chain** where these contracts exist at these addresses and `CREATE2` behaves as on Ethereum. Chains with different `CREATE2` semantics (for example zkSync) are not supported.

The parameters and the resulting address are signed into each manifest (`smartAccount`). Changing the defaults in a later release never changes an existing wallet's address: rotations reuse the manifest's parameters.

### Cross-checks

- The core's defaults are checked in tests to give the same address as `predictSafeAddress` in `@tetherto/wdk-wallet-evm-erc-4337@1.0.0-beta.24`.
- For a new wallet the server requires `smartAccount` to equal `smartAccountFor(expectedAddress)` canonically **and** the address to equal WDK's `WalletAccountReadOnlyEvmErc4337.predictSafeAddress(owner, { safeModulesVersion: "0.3.0" })` (`apps/vault/server/safe-check.ts`).
- Before declaring a chain deployable, the server checks that every contract has code and simulates the factory call with `eth_call`, requiring it to return exactly the predicted address ([HTTP-API.md](HTTP-API.md#get-apiaastatus)).

### Deployment UserOperation

`buildDeploymentOperation(owner, fees, params)`: `sender` = predicted Safe, `nonce = 0`, `factory` and `factoryData` from `SafeAccountV0_3_0.createFactoryAddressAndData([owner], overrides)`, `callData` = the Safe 4337 module's execute call for a single empty zero-value call to the Safe itself (`deploymentCalls`), paymaster fields unset, and abstractionkit's dummy signature for estimation. `isDeploymentOperation` accepts an operation only if `sender`, `factory`, `factoryData`, `callData` match exactly and `nonce` is 0 (quantities in decimal or hex). Gas and paymaster fields are not constrained by this check.

## 18. Signatures

All signatures are produced by the owner key in the worker.

### Messages and typed data (ERC-1271)

For `{ kind: "message", message }` and `{ kind: "typedData", typedData }`:

```
hash      = requestHash(request)
          = EIP-191 personal_sign hash of message      (viem hashMessage)
          | EIP-712 hash of typedData                  (viem hashTypedData)
signature = owner.signTypedData({
              domain:      { chainId, verifyingContract: safeAddress },
              types:       { SafeMessage: [{ name: "message", type: "bytes" }] },
              primaryType: "SafeMessage",
              message:     { message: hash }
            })                                          // 65-byte r || s || v
```

This is Safe's `SafeMessage` scheme: a verifier calls `isValidSignature(bytes32 hash, bytes signature)` on the deployed Safe and expects `0x1626ba7e` (`ERC1271_MAGIC_VALUE`). Off-chain, `recoverSafeMessageSigner(safe, chainId, hash, signature)` recovers the owner. The signature is bound to the Safe and the chain; the vault refuses to sign on a chain where the Safe is not deployed, except in the recovered modes (B+C, kit+code), which cannot check the chain. Message length and typed-data limits are in [INTEGRATION.md](INTEGRATION.md#methods) and enforced by `parseSignRequest`.

### UserOperations

For `{ kind: "userOperation", userOperation }` (a deployed Safe only; the request schema has no `factory` field):

1. `operation = buildUserOperation(safe, request, params)`: `sender = safe`, `factory`/`factoryData` null, `callData` = `executeUserOp` for one call or a `multiSend` batch (up to 16 calls) through `multisend`, the requested nonce and gas fields, paymaster fields null.
2. The owner signs the Safe 4337 module's EIP-712 `SafeOp` hash (`safeOperationHash`, abstractionkit `getUserOperationEip712Hash`), whose domain is `{ chainId, verifyingContract: safe4337Module }` and whose type is `SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)`.
3. The UserOperation signature is `validAfter (6 bytes) || validUntil (6 bytes) || ECDSA signature (65 bytes)`, 77 bytes in total, with `validAfter = validUntil = 0` (abstractionkit `signUserOperationWithSigners`).

The vault returns both the signature and the full UserOperation it signed. A verifier must check `userOperationMatches(operation, request, safe)` (same sender, no factory, same callData, same nonce and gas quantities, no paymaster) and `recoverSafeOperationSigner(operation, chainId)` (which strips the first 12 bytes) equals the owner. Nothing is submitted to a bundler by the vault for these signatures; only the Safe deployment is sent.

`userOperationHash` (the ERC-4337 EntryPoint hash) and `toRpcUserOperation` (ERC-7769 JSON-RPC shape with hex quantities) are also exported for integrators.

### Deployment

The deployment operation is signed the same way (SafeOp EIP-712), after the vault's own client filled in paymaster data and gas limits through the server proxy, and is sent to the bundler by the vault.

## 19. Relink authorization

Moving a wallet to a new integrator account (`sub`) requires a direct EIP-712 signature by the **owner EOA** (not a Safe signature), so that it can be verified without any chain:

```
domain      = { name: "wl-embedded-wallet/relink-wallet", version: "1" }   // no chainId, no verifyingContract
primaryType = "WalletRelink"
types.WalletRelink = [
  { name: "purpose",     type: "string"  },   // "wl-embedded-wallet/relink-wallet/v1"
  { name: "safe",        type: "address" },
  { name: "owner",       type: "address" },
  { name: "newSub",      type: "string"  },
  { name: "issuer",      type: "string"  },   // HANDOFF_ISSUER
  { name: "vaultOrigin", type: "string"  },   // vault ORIGIN
  { name: "nonce",       type: "string"  },   // base64url, 32 random bytes
  { name: "expiresAt",   type: "uint256" }    // Unix seconds, issued + 300
]
```

The server issues the challenge (`POST /api/relink/nonce`), stores it, and on `POST /api/relink` **rebuilds the typed data from its own stored values** (`relinkTypedData`), recovers the signer with viem `recoverTypedDataAddress`, and requires it to be the stored owner. The browser supplies only the signature. Before signing, the vault page checks that the challenge's `vaultOrigin` is its own origin and `newSub` its session's user, and the worker checks that `owner` and `safe` are the manifest's. Server-side rules are in [HTTP-API.md](HTTP-API.md#post-apirelink).

## 20. Other random values

| Value | Size | Encoding | Source |
|---|---|---|---|
| Session token (`__Host-vault_session` cookie) | 32 bytes | base64url | Server |
| WebAuthn challenges (register, recover) | 32 bytes | base64url | Server |
| Relink nonce | 32 bytes | base64url | Server |
| Envelope and seed backup salts | 16 bytes | base64url | Worker (A: server) |
| GCM IVs | 12 bytes | base64url | Worker (A: server) |
| Recovery code entropy | 16 bytes | Crockford base32 | Vault page |
| `setId` | UUID v4 | text | Vault page (`crypto.randomUUID`) |

Browser-side randomness is `crypto.getRandomValues`; server-side randomness is Node's WebCrypto or `node:crypto`. IVs are random per encryption with a fresh key derivation per envelope (each envelope has its own salt), so GCM nonce reuse under one key would require a salt collision.

## 21. Versioned labels

| Label | Use |
|---|---|
| `wl-embedded-wallet/envelope/v1\|{userId}\|{setId}\|{share}` | Envelope AAD (A, B, C) |
| `wl-embedded-wallet/share-a/kms/v1\|{userId}\|{setId}` | HKDF info, share A |
| `wl-embedded-wallet/share-b/prf/v1` | Hashed with SHA-256 to give the PRF input |
| `wl-embedded-wallet/share-b/aes/v1\|{userId}\|{setId}` | HKDF info, share B |
| `wl-embedded-wallet/seed-backup/v1\|{lowercase owner}` | Seed backup AAD |
| `bip39-en/wdk-utils-hex` | Manifest `format` |
| `wl-embedded-wallet/relink-wallet/v1` | Relink `purpose` field |
| `wl-embedded-wallet/relink-wallet` | Relink EIP-712 domain `name` (version `1`) |
| `wl-embedded-wallet/protocol/v1` | `postMessage` protocol tag ([PROTOCOL.md](PROTOCOL.md)) |

Format versions: envelope `v: 1`, seed backup `v: 1`, manifest `v: 1`, kit `v: 1` and `v: 2`.

## 22. Test vectors

The vectors below were **computed with the reference implementation of this release** (functions from `packages/core/src`, WebCrypto in Node 22, `hash-wasm@4.12.0`), with fixed salts, IVs and code entropy substituted for the random ones. Every vector in this section is asserted by `packages/core/tests/crypto-spec-vectors.test.ts`, which parses the values from this document (so an edit to the document or to the code that breaks a vector fails `pnpm --filter @wl-embedded-wallet/core test`) and recomputes them with the same public functions, fixing `crypto.getRandomValues` for the salts, IVs and entropy. Some values are checked with the underlying primitives instead: the raw HKDF and Argon2id keys (the code only produces non-extractable keys) and share A, whose `sealShareA` lives in the vault server (the test composes the same core functions and checks the info template in `apps/vault/server/kms.ts`).

Common inputs: `userId = "alice"`, `setId = "11111111-1111-4111-8111-111111111111"`, share plaintext bytes (hex) `0102030405060708090a0b0c0d0e0f101112131415` (21 bytes).

### PRF input and user handle

```
PRF_SALT          = SHA-256("wl-embedded-wallet/share-b/prf/v1")
                  = 2a34f0d8317ae7ec6cdbcdce341b8d4e5083297e9b9d00d2c821efaa5514e2ac
user.id           = SHA-256("alice|11111111-1111-4111-8111-111111111111")
                  = 15f14b63f4fec0d1915da06a8d0740cba2b78627f7b29169c37505250e7f7b03
```

### Share B envelope

```
prf               = 01 * 32
salt              = 02 * 16          -> "AgICAgICAgICAgICAgICAg"
iv                = 03 * 12          -> "AwMDAwMDAwMDAwMD"
info              = "wl-embedded-wallet/share-b/aes/v1|alice|11111111-1111-4111-8111-111111111111"
AES key (HKDF)    = 188b1f6f49a1a61f7dc49539a6e40493347f8467e1b2c2a432c9a9b5826f08b6
AAD               = "wl-embedded-wallet/envelope/v1|alice|11111111-1111-4111-8111-111111111111|B"
ct                = "UIlNmLNTon-W4EL-OAFN8wxlUn-NGJV5mcoSKtqzlsw9meLRbw"
```

### Share A envelope

```
MASTER_KEY        = 000102...1f (bytes 0x00..0x1f)
salt              = 04 * 16          -> "BAQEBAQEBAQEBAQEBAQEBA"
iv                = 05 * 12          -> "BQUFBQUFBQUFBQUF"
info              = "wl-embedded-wallet/share-a/kms/v1|alice|11111111-1111-4111-8111-111111111111"
AES key (HKDF)    = ee6b539a3aa8a17da9ca1099ad7a7a14ef42a743071a247f90cb74e0342d5d42
AAD               = "wl-embedded-wallet/envelope/v1|alice|11111111-1111-4111-8111-111111111111|A"
ct                = "XBq4M4og0NURD4c60_7hs5IrLHO8fFvEnyNo-EDsg028BEen-A"
```

### Recovery code

```
entropy           = 000102030405060708090a0b0c0d0e0f
code              = 000G40R40M30E209185GR38E1W
grouped           = 000G-40R4-0M30-E209-185G-R38E-1W
normalize("ooog-4or4-om3o-e2o9-l85g-r38e-lw") = 000G40R40M30E209185GR38E1W
```

### Share C envelope

```
password          = ASCII("000G40R40M30E209185GR38E1W")
salt              = 06 * 16          -> "BgYGBgYGBgYGBgYGBgYGBg"
iv                = 07 * 12          -> "BwcHBwcHBwcHBwcH"
Argon2id(m=65536, t=3, p=1, len=32)
                  = 31c0cfb9bc36257b43302c322cb26cc21e72fbafca6f5e33a383954aaa3106d7
AAD               = "wl-embedded-wallet/envelope/v1|alice|11111111-1111-4111-8111-111111111111|C"
ct                = "qEv2TI7CHdqLuJEdNufQxXVQoHbBJ6Lud2k1PBW1CIuwOSBdOQ"
```

### Seed backup

```
mnemonic          = "test test test test test test test test test test test junk"
owner             = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   (m/44'/60'/0'/0/0)
AAD               = "wl-embedded-wallet/seed-backup/v1|0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
password          = ASCII("000G40R40M30E209185GR38E1W")
salt              = 08 * 16          -> "CAgICAgICAgICAgICAgICA"
iv                = 09 * 12          -> "CQkJCQkJCQkJCQkJ"
Argon2id(defaults)= 3a282ee9ba28630cfeacfcbefc4c88cc532f5bcda7a1adf8469d498bc1084faa
ct                = "VD5Orfe5G-Ghd2BcGBIDL1nOVJOsxYAJXPqyRgavkBW4ZGW_NjWZhEh3N1Cn_1QfQsw6CEwzTX1Yhzy5VtzWwpJh27ChamFmqDWt"
```

### Safe address

```
owner             = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Safe (defaults)   = 0x97682ff1A980a96D65Ea606b717441E3662c557E
```

### Manifest signature

Manifest with the owner above, default Safe parameters, `wdkUtilsVersion = "1.0.0-beta.16"`, `createdAt = "2026-01-01T00:00:00.000Z"` and digests of the dummy shares `0a0b`, `0c0d`, `0e0f`:

```
shareDigest("0a0b") = bea0b72e71bfe7f15a88c25305bf96a9681e34d3aabe0c9a1b7093cb32d8ff05
canonical JSON      = {"createdAt":"2026-01-01T00:00:00.000Z","derivationPath":"m/44'/60'/0'/0/0","expectedAddress":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","format":"bip39-en/wdk-utils-hex","k":2,"n":3,"setId":"11111111-1111-4111-8111-111111111111","shareDigests":{"A":"bea0b72e71bfe7f15a88c25305bf96a9681e34d3aabe0c9a1b7093cb32d8ff05","B":"07653ec08000c93dedea7816c582fd08db6135d606ef57a1f55cdab8928a24c3","C":"ca53b1b426b669b4171fb4bb4e6cf90a2b2bbf46e3b8b280f0ec3328a10e8296"},"smartAccount":{"address":"0x97682ff1A980a96D65Ea606b717441E3662c557E","entryPoint":"0x0000000071727De22E5E9d8BAf0edAc6f37da032","factory":"0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67","multisend":"0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526","safe4337Module":"0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226","safeModuleSetup":"0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47","safeModulesVersion":"0.3.0","saltNonce":"0x69b348339eea4ed93f9d11931c3b894c8f9d8c7663a053024b11cb7eb4e5a1f6","singleton":"0x29fcB43b46531BcA003ddC8FCB67FFE91900C762","singletonInitHash":"0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee","type":"safe-4337"},"userId":"alice","v":1,"wdkUtilsVersion":"1.0.0-beta.16"}
SHA-256(canonical)  = f70f19f4916f22d81f3fe85f947bc4c8cf67d61f2fe90499dec17eca41fbe44f
signing key         = 2a * 32
public key          = 197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61
signature           = "ilrUcdVofGgjCHXFoyv6wMGY-GMeceEmxtrwteqBJtuhbZDEltgPWjqcYYhfAmfydBQp1Q-FkTsoEDq4vA9_Aw"
```

### SafeMessage hash

```
message           = "hello"
requestHash       = 0x50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750
chainId           = 11155111, Safe = 0x97682ff1A980a96D65Ea606b717441E3662c557E
SafeMessage hash  = 0x5891cb58804138740c5d1acbcb78b56ab047c1e374d409f735103472323f8abd
```

### Relink typed data hash

```
{ safe: 0x97682ff1A980a96D65Ea606b717441E3662c557E, owner: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
  newSub: "bob", issuer: "https://app.example.com", vaultOrigin: "https://vault.example.com",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: 1767225600 }
EIP-712 hash      = 0x75e48fe32b8ad3edeede49b33130d0a27fd15de5a8ac2ce4d065fe65c524be98
```

### Assertions in the test suites

Besides the vectors above (`crypto-spec-vectors.test.ts`), the suites check behavior: canonicalization, base64url canonical rejection, envelope tampering of every field, every Argon2id bound, code normalization (`ILO` maps to `110`), kit parse rules for `v: 1` and `v: 2`, seed backup AAD binding to the owner, the Safe address against WDK, and real-contract ERC-1271 and `handleOps` validation in `pnpm test:aa`. See [TESTING.md](TESTING.md).

## 23. Known gaps in this specification

- The internal share format of `shamir-secret-sharing@0.0.4` (field polynomial, x-coordinate choice) is described only as far as wdk-utils exposes it. A reimplementation should use the same library versions or treat the shares as opaque hex.
- The SafeOp EIP-712 type and domain are stated as implemented by abstractionkit 0.4.0 for the Safe 4337 module 0.3.0; they were verified against real contracts only on a local anvil chain (`pnpm test:aa`).
- The Argon2 version byte is hash-wasm's default (0x13); it is not set explicitly in this code.
