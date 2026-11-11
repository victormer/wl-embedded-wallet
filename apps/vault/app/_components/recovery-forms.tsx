'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { zero } from '@wl-embedded-wallet/core/encoding';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { parseKit, type EmergencyKit } from '@wl-embedded-wallet/core/kit';
import { discoverPasskey, getPrfOutput } from '@/lib/prf';
import { recoveryCodeToBytes } from '@wl-embedded-wallet/core/recovery-code';
import type { RecoveredWallet } from '@/lib/recovered';
import { readRuntimeConfig } from '@/lib/runtime-config';
import { runSigner } from '@/lib/signer-client';
import { fetchRecoveryChallenge, postRecoveryAssertion } from '@/lib/vault-api';
import { ErrorNote, Note, Working } from './ui';

export interface Recovered {
  wallet: RecoveredWallet;
  // The code bytes, because every operation needs them again. Whoever receives them overwrites them when done.
  code: Uint8Array<ArrayBuffer>;
  address: `0x${string}`;
  owner: `0x${string}`;
  mismatch: boolean;
}

function CodeField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label className="field">
      <span className="label">Recovery code</span>
      <input className="input input-code" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} data-testid="recovery-code-input" />
    </label>
  );
}

/** Kit and code, with the passkey (B+C) or without it (the seed backup). It makes no API calls. */
export function KitRecoveryForm({ onRecovered }: { onRecovered(result: Recovered): void }) {
  const [kit, setKit] = useState<EmergencyKit | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  async function loadKit(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setKit(null);
    const file = event.target.files?.[0];
    setFileName(file?.name ?? null);
    if (!file) return;
    const parsed = parseKit(await file.text());
    if (!parsed) return setError(uiError('INVALID_KIT'));
    if (parsed.rpId !== readRuntimeConfig().rpId) return setError(uiError('WRONG_RP'));
    setKit(parsed);
  }

  async function run(combo: 'B+C' | 'kit+code') {
    if (!kit) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = recoveryCodeToBytes(code);
      const signed = { manifest: kit.manifest, signature: kit.signature };
      const { encB, encC, credentialId, seedBackup } = kit;
      const response =
        combo === 'kit+code'
          ? await runSigner({ op: 'recover', combo, signed, seedBackup: seedBackup!, code: bytes.slice() })
          : await runSigner({ op: 'recover', combo, signed, encB, encC, prf: await getPrfOutput(credentialId), code: bytes.slice() });
      if (!response.ok) {
        zero(bytes);
        setError(uiError(response.code, 'code'));
        return;
      }
      setCode('');
      const wallet: RecoveredWallet =
        combo === 'kit+code'
          ? { combo, signed, seedBackup: seedBackup!, encB, encC, credentialId, hasBackup: true }
          : { combo, signed, encB, encC, credentialId, hasBackup: Boolean(seedBackup) };
      onRecovered({ wallet, code: bytes, address: response.address, owner: response.owner, mismatch: response.wdkVersionMismatch });
    } catch (cause) {
      setError(toUiError(cause, 'code'));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('B+C');
  }

  return (
    <>
      <p>Upload your emergency kit. It is only processed in this browser.</p>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="label">Emergency kit</span>
          {/* The native picker's text follows the browser's language: the visible control is custom so its text matches the UI language. */}
          <span className="file-picker">
            <input className="file-input" type="file" accept="application/json,.json" onChange={loadKit} data-testid="kit-file" />
            <span className="file-button" aria-hidden="true">
              Choose file
            </span>
            <span className="file-name">{fileName ?? 'No file'}</span>
          </span>
        </label>
        {kit && (
          <div className="field" data-testid="kit-loaded">
            <span className="label">Kit loaded for</span>
            <code className="value">{kit.manifest.smartAccount.address}</code>
          </div>
        )}
        {kit && !kit.seedBackup && (
          <Note data-testid="kit-old">
            This kit is old and has no seed backup: you need your passkey. Once you recover the wallet, generate a new kit.
          </Note>
        )}
        <CodeField value={code} onChange={setCode} />
        <div className="actions">
          {kit?.seedBackup && (
            <button className="button button-secondary" type="button" disabled={busy || code.trim() === ''} onClick={() => void run('kit+code')} data-testid="recover-backup-submit">
              Without passkey
            </button>
          )}
          <button className="button" type="submit" disabled={busy || !kit || code.trim() === ''} data-testid="recover-bc-submit">
            Recover with passkey
          </button>
        </div>
      </form>
      {busy && <Working text="Reconstructing the key on this device." />}
      <ErrorNote error={error} />
    </>
  );
}

const CHALLENGE_MAX_AGE_MS = 4 * 60 * 1000;

/** No kit and no session: a single assertion identifies the passkey to the server and yields the PRF in the browser. */
export function PasskeyRecoveryForm({ onRecovered }: { onRecovered(result: Recovered): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  // Requested before the user's gesture, and each challenge is used once.
  const challenge = useRef<{ value: Promise<string>; at: number } | null>(null);

  const prepare = () => {
    const value = fetchRecoveryChallenge();
    value.catch(() => undefined);
    challenge.current = { value, at: Date.now() };
    return value;
  };

  useEffect(() => {
    if (!challenge.current) prepare();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bytes = recoveryCodeToBytes(code);
      const current = challenge.current;
      const value = await (current && Date.now() - current.at < CHALLENGE_MAX_AGE_MS ? current.value : prepare());
      challenge.current = null;
      const passkey = await discoverPasskey(value);
      const found = await postRecoveryAssertion(passkey.assertion);
      if (!found) {
        zero(passkey.prfOutput, bytes);
        prepare();
        return setError(uiError('RECOVERY_FAILED'));
      }
      const { signed, encB, encC, credentialId } = found;
      const response = await runSigner({ op: 'recover', combo: 'B+C', signed, encB, encC, prf: passkey.prfOutput, code: bytes.slice() });
      if (!response.ok) {
        zero(bytes);
        prepare();
        return setError(uiError(response.code, 'code'));
      }
      setCode('');
      onRecovered({ wallet: { combo: 'B+C', signed, encB, encC, credentialId, hasBackup: false }, code: bytes, address: response.address, owner: response.owner, mismatch: response.wdkVersionMismatch });
    } catch (cause) {
      if (!challenge.current) prepare();
      setError(toUiError(cause, 'code'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>If you have lost your kit or your session: choose your passkey on this device and enter your code. The server only hands out your encrypted data.</p>
      <form className="stack" onSubmit={submit}>
        <CodeField value={code} onChange={setCode} />
        <button className="button" type="submit" disabled={busy || code.trim() === ''} data-testid="recover-passkey-submit">
          Choose my passkey
        </button>
      </form>
      <p className="muted" data-testid="passkey-recovery-limit">
        Wallets created before this feature did not store their passkey's public key and cannot use this option until they re-enroll. A passkey you have already replaced will not work either.
      </p>
      {busy && <Working text="Checking the passkey and reconstructing the key on this device." />}
      <ErrorNote error={error} />
    </>
  );
}
