# Recovery

This document lists every way a user can regain access to their wallet in WL Embedded Wallet 0.1.0: what each path needs, how it works step by step, what it leaves behind, and how it fails. The formats are specified in [CRYPTO-SPEC.md](CRYPTO-SPEC.md), the risks in [THREAT-MODEL.md](THREAT-MODEL.md), and what the integrator should tell users in [INTEGRATION.md](INTEGRATION.md#10-recovery-what-to-tell-your-users).

## Contents

- [What the user holds](#what-the-user-holds)
- [Choosing a path](#choosing-a-path)
- [A+B: normal unlock](#ab-normal-unlock)
- [A+C: lost passkey](#ac-lost-passkey)
- [B+C: kit, passkey and code, without the server](#bc-kit-passkey-and-code-without-the-server)
- [Kit + code in the vault](#kit--code-in-the-vault)
- [Redo with my kit: re-enroll from the kit](#redo-with-my-kit-re-enroll-from-the-kit)
- [Passkey recovery: without a kit](#passkey-recovery-without-a-kit)
- [Lost app login: relink](#lost-app-login-relink)
- [Static recovery page](#static-recovery-page)
- [Offline HTML tool](#offline-html-tool)
- [Offline CLI](#offline-cli)
- [What can be done after recovering without share A](#what-can-be-done-after-recovering-without-share-a)
- [Old kits and kit upgrade](#old-kits-and-kit-upgrade)
- [Failure modes](#failure-modes)
- [What recovery does not do](#what-recovery-does-not-do)

## What the user holds

| Item | Created | Contains | Notes |
|---|---|---|---|
| **Passkey** | At enrollment, in the user's passkey provider | Unlocks share B (PRF) | Bound to the vault's RP ID (its domain). Must support the WebAuthn PRF extension. |
| **Recovery code** | At enrollment, shown once | Unlocks share C and the seed backup | 26 characters, `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`. Case, spaces and hyphens do not matter; `I`/`L` read as `1`, `O` as `0`. Never stored by the vault. |
| **Emergency Kit** | At enrollment and rotation (`wl-embedded-wallet-kit-xxxxxxxx.json`) | encB, encC, signed manifest, credential id, RP ID, and (version 2) the seed encrypted under the code | Never contains share A. |
| **Offline recovery tool** | Downloaded from the vault before the kit (`wl-embedded-wallet-recovery.html`) | Program only, no user data | Identical for every deployment; check its SHA-256 ([REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md)). |
| **Exported seed file** (optional) | Only if the user chose to export (`wl-embedded-wallet-seed-….txt`) | The mnemonic in plaintext | Equivalent to the wallet. |

> [!IMPORTANT]
> **Kit + recovery code are enough to obtain the seed**, with no passkey and no server. The kit and the code must be stored separately.

## Choosing a path

| The user has | And the vault is | Path | Server needed | Keeps using the vault? |
|---|---|---|---|---|
| App login + passkey | Up | [A+B](#ab-normal-unlock) | Yes | Yes |
| App login + code (passkey lost) | Up | [A+C](#ac-lost-passkey), then re-enroll | Yes | Yes, with a new passkey and code |
| App login + kit + code (+ passkey optional) | Up | [Redo with my kit](#redo-with-my-kit-re-enroll-from-the-kit) | Yes (session to store the new set) | Yes |
| Kit + passkey + code | Up or down | [B+C](#bc-kit-passkey-and-code-without-the-server) (vault page or [static page](#static-recovery-page)) | No | Sign and export in recovered mode |
| Kit (v2) + code | Up or down | [Kit + code](#kit--code-in-the-vault), [static page](#static-recovery-page), [offline tool](#offline-html-tool) or [CLI](#offline-cli) | No | Sign and export in recovered mode; the tools only reveal the seed |
| Passkey + code, no kit | Up | [Passkey recovery](#passkey-recovery-without-a-kit) | Yes (returns encB and encC; no session) | Sign and export in recovered mode |
| Lost app login, and any of the above without share A | Up | [Relink](#lost-app-login-relink) to a new app account | Yes | Yes, under the new account |
| Exported seed file | Any | Import the mnemonic into any BIP-39 wallet, path `m/44'/60'/0'/0/0`; the Safe is controlled by that owner | No | n/a |

All paths that rebuild the seed do so in a Web Worker on the vault origin (or in the offline tool), verify the signed manifest (except the offline tool), verify each share against its digest, and check that the result derives the expected owner and Safe before anything is returned. See [CRYPTO-SPEC.md](CRYPTO-SPEC.md#14-reconstruction-and-verification-order).

## A+B: normal unlock

**Needs:** a working app login (a fresh handoff token), the passkey. **Where:** the vault's `/unlock` page, opened by `client.unlock()`. Every signature, deployment and export uses the same combination.

1. The popup redeems the token and loads the active set (`GET /api/shares`).
2. The user approves with the passkey; the browser returns the PRF output.
3. The worker decrypts share B, then fetches share A (`GET /api/shares/a`), verifies both digests against the signed manifest, combines and checks the owner and Safe.
4. The app receives `{ address, owner }`. Nothing is signed.
5. The page offers to generate a new kit with a seed backup, for users whose kit is version 1 ([kit upgrade](#old-kits-and-kit-upgrade)).

During enrollment the same A+B reconstruction runs as a **drill** before the set is activated.

## A+C: lost passkey

**Needs:** a working app login, the recovery code. **Where:** `/recover`, tab "I lost my passkey" (opened by `client.recover()`).

1. The popup redeems the token and loads the active set, including encC.
2. The user enters the code. The worker decrypts share C with the code (Argon2id) **before** requesting share A, so a wrong code never releases A.
3. The worker fetches share A, verifies, combines and checks the owner and Safe.
4. The page shows the Safe address and offers:
   - **Create new passkey** (recommended): re-enrollment with the same seed. The worker reconstructs the seed again from A+C, and the standard enrollment steps run: new passkey, new recovery code, new shares A, B, C, new kit, tool download, and an A+B drill with the new passkey. The new set is activated and the old one revoked (its encrypted shares are deleted on the server). The Safe address does not change.
   - **Not now**: return to the app with the old passkey and code still in place.
5. The app receives `{ address, owner }`.

After re-enrollment the old passkey and code can no longer be used through the vault, but the **old kit still opens with the old code** and yields the same seed. The user should destroy both.

## B+C: kit, passkey and code, without the server

**Needs:** the kit (version 1 or 2), the passkey, the code, and a page on an origin valid for the vault's RP ID (the vault itself or the [static page](#static-recovery-page)). **Where:** `/recover`, tab "Without the server" (works even without an app opener), or the static page.

1. The user uploads the kit. It is parsed in the browser; the vault rejects a kit whose `rpId` is not its own (`WRONG_RP`).
2. The user enters the code and chooses "Recover with passkey". The browser asks for the kit's passkey (by credential id) and returns the PRF output.
3. The worker verifies the manifest signature (with the public key the page was served with), decrypts B and C, verifies the digests, combines and checks the owner and Safe. **No server call is made.**
4. The page shows the Safe and owner addresses, and the [recovered-mode panel](#what-can-be-done-after-recovering-without-share-a).

If the vault page was opened by an app, a result is posted to it; because no handoff token was redeemed in this tab, the app receives an error code rather than the address (the vault never posts data to an unverified origin).

## Kit + code in the vault

**Needs:** a version 2 kit, the code. **Where:** `/recover`, tab "Without the server", button "Without passkey"; also the static page and `/relink`.

1. The user uploads the kit and enters the code.
2. The worker verifies the manifest signature, format and Safe parameters, decrypts the seed backup with the code and the manifest's owner as AAD, and checks that the seed derives that owner.
3. The [recovered-mode panel](#what-can-be-done-after-recovering-without-share-a) is shown.

No passkey and no server call. A version 1 kit has no backup: the button is not offered, and the page explains that the passkey is needed.

## Redo with my kit: re-enroll from the kit

**Needs:** a working app login for the account that owns the wallet, the kit and the code, and the passkey if the kit is version 1. **Where:** `/recover`, tab "Redo with my kit".

1. The popup redeems the token.
2. The user recovers with the kit as in [B+C](#bc-kit-passkey-and-code-without-the-server) or [kit + code](#kit--code-in-the-vault).
3. The page loads the account's active set and requires its owner to equal the recovered owner (`ADDRESS_MISMATCH` otherwise).
4. Re-enrollment runs with the recovered seed as the source: new passkey, code, shares, kit, tool download, A+B drill, activation.

This is the path when the passkey is lost and the user prefers not to involve share A, or when `MASTER_KEY` was lost by the operator (share A unusable for everyone).

## Passkey recovery: without a kit

**Needs:** the passkey (discoverable, which every passkey created by this vault is), the code, the vault running. No kit and no app session. **Where:** `/recover`, tab "Without a kit", and `/relink`, tab "Without a kit".

1. On load, the page requests a recovery challenge (`POST /api/recovery/passkey/challenge`, valid 5 minutes on the server; the page requests a new one at submit time if its challenge is older than 4 minutes, and after every failed attempt).
2. The user enters the code and chooses their passkey. The browser performs one discoverable assertion (no `allowCredentials`) that yields both the assertion and the PRF output. The PRF output stays in the browser.
3. The page sends only the assertion to `POST /api/recovery/passkey`. The server spends the challenge, finds the active set for that credential id, verifies the assertion against the stored public key (origin, RP ID, user verification, counter), and returns encB, encC and the signed manifest. **Never share A, and no session is opened.**
4. The worker runs B+C as above.
5. The [recovered-mode panel](#what-can-be-done-after-recovering-without-share-a) is shown.

Limits:

- Only sets that registered the passkey's public key at enrollment can be found. Sets enrolled without it cannot use this path until they re-enroll.
- Only the passkey of the **active** set works; a passkey from a set that was replaced by a rotation does not.
- Passkey + code is therefore equivalent to the wallet ([THREAT-MODEL.md](THREAT-MODEL.md#accepted-risks)).

## Lost app login: relink

**Needs:** a new account in the integrator app (with no wallet), and either the kit and the code (with or without the passkey), or the passkey and the code. **Where:** `/relink`, opened by `client.relink()`.

1. The popup redeems the new account's token and checks that the account has no wallet (`WALLET_ALREADY_EXISTS` otherwise).
2. The user recovers the wallet with the kit (B+C or kit + code) or without a kit (passkey recovery). Share A is not used.
3. The page shows the Safe, the owner and the new account's label, and warns that the previous account will lose access.
4. The vault issues a relink challenge; the worker signs it with the owner key (an EIP-712 message bound to the new account, the issuer, the vault origin, a nonce and a 5-minute expiry; it moves no funds and is not sent to any chain).
5. The server verifies the signature and moves the wallet's sets to the new account, ends the previous account's sessions, and records the relink in its audit table.

The passkey, code and kit are unchanged. The previous account is not notified. If the user suspects someone else has their material, they should rotate (A+C or redo with the kit) or move the funds to a new wallet. Protocol and server rules: [HTTP-API.md](HTTP-API.md#relinking-a-wallet-to-another-account), [CRYPTO-SPEC.md](CRYPTO-SPEC.md#19-relink-authorization).

## Static recovery page

**Needs:** the kit, the code, the passkey for B+C (not needed for kit + code with a version 2 kit), and the operator's static page hosted on an origin valid for the vault's RP ID (the RP ID host itself or one of its subdomains). **Where:** for example `https://recover.vault.example.com/`, built with `pnpm --filter ./apps/vault build:static-recovery` ([DEPLOYMENT.md](DEPLOYMENT.md#static-recovery-page)).

The page is the vault's "Without the server" screen, bundled with the same worker logic and the operator's brand, with the RP ID and the manifest public key baked in at build time. Its CSP has `connect-src 'none'`: it cannot contact the vault or anything else.

Steps are the same as [B+C](#bc-kit-passkey-and-code-without-the-server) and [kit + code](#kit--code-in-the-vault), followed by the recovered-mode panel (sign, export). It **cannot** re-enroll, relink, perform passkey recovery without a kit, or generate a new kit (it cannot fetch the recovery tool, and a kit is never handed out without the tool).

Hosted on an unrelated domain, the passkey does not work (WebAuthn refuses the RP ID), so only kit + code would work there. If the vault's domain is lost entirely, B+C is no longer possible anywhere and only kit + code remains.

## Offline HTML tool

**Needs:** a version 2 kit and the code. No network, no passkey, no server, no domain. **Where:** the downloaded `wl-embedded-wallet-recovery.html`, opened from disk (`file://`) in a browser on a trusted device, preferably offline.

1. Verify the file's SHA-256 against the published value ([REPRODUCIBLE-BUILDS.md](REPRODUCIBLE-BUILDS.md)).
2. Open it, choose the kit file, enter the code, press "Decrypt and check". Argon2id runs on the main thread, so the page may pause for a few seconds.
3. The tool parses the kit, requires a seed backup and the standard derivation path, decrypts the backup with the code (AAD bound to the kit's owner), derives the owner, recomputes the Safe from the owner and the kit's Safe parameters, and compares both with the kit.
4. If both match, it says so and offers "Show the seed". If either differs, it shows `MISMATCH` and **never reveals the seed**.

The tool does not verify the manifest signature (it has no trusted public key); authenticity rests on AES-GCM under the code. It cannot sign or deploy: the user imports the seed into another wallet (path `m/44'/60'/0'/0/0`) to control the Safe owner.

## Offline CLI

**Needs:** Node.js, a version 2 kit and the code. **Where:** `wl-embedded-wallet-recovery.mjs` (built in `packages/recovery-tool/dist/`), with its published SHA-256.

```bash
node wl-embedded-wallet-recovery.mjs kit.json                 # prompts for the code without echo; checks owner and Safe
node wl-embedded-wallet-recovery.mjs kit.json --show-seed     # also prints the seed if everything matches
printf '%s\n' "$CODE" | node wl-embedded-wallet-recovery.mjs kit.json --code-stdin
```

The code is never accepted as an argument (it would end up in shell history and the process list). Output: the derived owner and Safe with "matches the kit" or `MISMATCH`. The seed is printed only with `--show-seed` and only when both match.

| Exit code | Meaning |
|---|---|
| `0` | Owner and Safe match (seed printed only with `--show-seed`) |
| `1` | Usage error or unreadable kit file |
| `2` | Recovery failed (invalid kit, no seed backup, bad code format, wrong code or tampered kit, unsupported format) |
| `3` | Decrypted, but the owner or the Safe does not match the kit |

The CLI makes no network calls: `fetch` is replaced by a stub at build time, and the test suite runs it under a network detector.

## What can be done after recovering without share A

After B+C, kit + code, or passkey recovery, the vault and the static page show a panel that works without the server:

- **Sign** a message, EIP-712 typed data or a UserOperation, for a `chainId` the user types. The request is reviewed, the seed is rebuilt for that signature only (the passkey is asked again for B+C), and the signature is shown. Nothing is sent to any chain. The chain is not checked: the signature is only valid where the Safe is deployed.
- **Download the seed** after an explicit risk confirmation (`export-recovered`).
- **Generate a new kit with a seed backup**, if the kit was version 1 and the recovery used B+C (vault only, not the static page).

The code bytes are kept in memory only while this panel is open, and overwritten when it closes.

## Old kits and kit upgrade

A **version 1 kit** has no seed backup. It still works for B+C (with the passkey) and its code still works for A+C, but kit + code alone cannot recover it, and the offline tool reports `NO_SEED_BACKUP`.

To get a version 2 kit without rotating: after an A+B unlock (or on the activate screen of an existing wallet, or after a B+C recovery in the vault), use "New kit with seed backup". The user downloads the recovery tool, enters the recovery code and approves with the passkey. The worker rebuilds the seed, proves the code belongs to this set by decrypting the set's share C, and seals a new seed backup. The new kit has the same envelopes and manifest and opens with the same code. No new set is created on the server.

## Failure modes

| What the user sees (code) | Likely cause | What to do |
|---|---|---|
| Incorrect passkey or tampered data (`DECRYPT_FAILED`, passkey context) | A different passkey than the set's, or tampered encB | Use the right passkey; otherwise A+C |
| Incorrect code or tampered kit (`DECRYPT_FAILED`, code context) | Wrong code, a kit from another rotation, or tampered data | Check the code against the kit's date; try another copy of the kit |
| `BAD_RECOVERY_CODE` | Not 26 valid characters after normalization | Re-type; `U` is never part of a code |
| `INVALID_KIT` | Not a kit, edited, or corrupted | Use another copy |
| `WRONG_RP` | Kit from another vault domain | Use that vault, or kit + code in the offline tool |
| `NO_SEED_BACKUP` | Version 1 kit used without a passkey | Use B+C with the passkey, or upgrade the kit |
| `MANIFEST_INVALID` | Manifest signature does not verify with the vault's key (tampering, or a kit from a different vault) | Use another copy; the offline tool does not depend on this key |
| `SHARE_TAMPERED`, `COMBINE_FAILED` | A share does not match the signed digests | Stop: data tampered; use another copy or another pair |
| `ADDRESS_MISMATCH` / offline `MISMATCH` | The decrypted seed does not control the claimed owner or Safe | Stop: tampered kit; do not send funds to the displayed addresses |
| `KDF_PARAMS_INVALID` | Kit's Argon2id parameters out of bounds | Tampered kit; use another copy |
| `FORMAT_UNSUPPORTED` | Unknown manifest format or derivation path | Use the matching software version |
| `RECOVERY_FAILED` | Passkey not the active set's, set enrolled without a public key, expired challenge, or failed verification | Use the kit, or re-enroll first while access remains |
| `SERVER_KEY_MISMATCH` | The operator's `MASTER_KEY` cannot open share A | Use the kit (B+C or kit + code); notify the operator |
| `PRF_UNSUPPORTED`, `PRF_NOT_RETURNED` | The passkey provider lacks PRF | Use another provider at enrollment; for recovery, use the kit + code |
| `CANCELLED` | Passkey prompt dismissed or timed out (60 s) | Retry |
| `UNAUTHORIZED` | Session expired (15 minutes) or token invalid | Reopen the popup from the app |
| `WALLET_ALREADY_EXISTS` | Relink into an account that already has a wallet | Use an account without a wallet |
| `RELINK_REJECTED` | Expired or foreign nonce, bad signature, or the wallet moved meanwhile | Retry; nothing changed |

A wrong code and a tampered kit are deliberately indistinguishable.

## What recovery does not do

- **It does not change the seed.** Rotation creates new shares, passkey, code and kit for the **same** seed and Safe. Old kits keep opening with their old code; exported seed files stay valid. If the seed, kit + code, or an exported file may have leaked, create a new wallet and move the funds.
- **It does not revoke offline material.** The server cannot invalidate a kit or a seed file.
- **It does not work without PRF.** A passkey provider without the PRF extension cannot enroll; there is no fallback.
- **It does not survive losing both** the code and (the passkey or the app login): any recovery needs two of the three factors, or the kit + code.
