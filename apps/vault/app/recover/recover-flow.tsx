'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EnrollSteps } from '@/app/_components/enroll-steps';
import { RecoverWithKit, RecoverWithPasskey } from '@/app/_components/recover-offline';
import { KitRecoveryForm, type Recovered } from '@/app/_components/recovery-forms';
import { BackToApp, ErrorNote, Note, Screen, VersionWarning, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate, type GateSession } from '@/app/_components/vault-gate';
import { zero } from '@wl-embedded-wallet/core/encoding';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { getPrfOutput } from '@/lib/prf';
import { recoveryCodeToBytes } from '@wl-embedded-wallet/core/recovery-code';
import { runSigner } from '@/lib/signer-client';
import { fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

type Mode = 'ac' | 'bc' | 'rekit' | 'passkey';

const TABS: { mode: Mode; label: string; withApp: boolean }[] = [
  { mode: 'ac', label: 'I lost my passkey', withApp: true },
  { mode: 'bc', label: 'Without the server', withApp: false },
  { mode: 'rekit', label: 'Redo with my kit', withApp: true },
  { mode: 'passkey', label: 'Without a kit', withApp: false },
];

export function RecoverFlow() {
  const channel = useVaultChannel('recover');
  const [mode, setMode] = useState<Mode>('ac');
  const canUseServer = channel.state !== 'no-opener';
  const available = TABS.filter((tab) => canUseServer || !tab.withApp);
  const current: Mode = available.some((tab) => tab.mode === mode) ? mode : 'bc';

  function select(next: Mode) {
    if (next === current) return;
    // The token is single-use and lasts 60 s: each tab that opens a session requests a new one.
    if (next === 'ac' || next === 'rekit') channel.renew();
    setMode(next);
  }

  return (
    <>
      <nav className="tabs" aria-label="How to recover">
        {available.map((tab) => (
          <button
            key={tab.mode}
            className={current === tab.mode ? 'tab tab-current' : 'tab'}
            aria-pressed={current === tab.mode}
            type="button"
            onClick={() => select(tab.mode)}
            data-testid={`recover-tab-${tab.mode}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {current === 'ac' && <VaultGate channel={channel}>{(session) => <RecoverAC session={session} channel={channel} />}</VaultGate>}
      {current === 'bc' && <RecoverWithKit channel={channel} />}
      {current === 'rekit' && <VaultGate channel={channel}>{(session) => <ReEnrollWithKit session={session} channel={channel} />}</VaultGate>}
      {current === 'passkey' && <RecoverWithPasskey channel={channel} />}
    </>
  );
}

/** B+C, or kit and code, to create a new passkey and code. Requires the session of the account that already has that wallet. */
function ReEnrollWithKit({ session, channel }: { session: GateSession; channel: VaultChannel }) {
  const [recovered, setRecovered] = useState<Recovered | null>(null);
  const [set, setSet] = useState<ShareSet | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [finished, setFinished] = useState(false);
  const prf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const code = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(
    () => () => {
      zero(prf.current ?? undefined, code.current ?? undefined);
    },
    [],
  );

  async function accept(result: Recovered) {
    setError(null);
    try {
      const active = await fetchShareSet();
      if (!active) return setError(uiError('NO_WALLET'));
      if (active.signed.manifest.expectedAddress !== result.owner) return setError(uiError('ADDRESS_MISMATCH'));
      if (result.wallet.combo === 'B+C') prf.current = await getPrfOutput(result.wallet.credentialId);
      code.current = result.code;
      setSet(active);
      setRecovered(result);
    } catch (cause) {
      setError(toUiError(cause));
    }
  }

  if (finished && recovered) {
    return (
      <Screen title="Wallet recovered" testId="done-panel">
        <WalletAddress address={recovered.address} />
        <p className="muted" data-testid="re-enrolled">
          There is a new passkey, code and kit for this wallet. An old kit still opens with its old code and yields the same seed: destroy both.
        </p>
        <BackToApp />
      </Screen>
    );
  }

  if (recovered && set) {
    const { wallet, address, owner } = recovered;
    return (
      <EnrollSteps
        userId={session.userId}
        title="Protect your wallet again"
        expectedAddress={address}
        linkedOwner={set.signed.manifest.expectedAddress}
        source={() =>
          wallet.combo === 'B+C'
            ? { op: 'recover', combo: 'B+C', signed: wallet.signed, encB: wallet.encB, encC: wallet.encC, prf: (prf.current as Uint8Array).slice(), code: (code.current as Uint8Array).slice() }
            : { op: 'recover', combo: 'kit+code', signed: wallet.signed, seedBackup: wallet.seedBackup, code: (code.current as Uint8Array).slice() }
        }
        onComplete={() => {
          setFinished(true);
          channel.respond({ ok: true, address, owner });
        }}
      />
    );
  }

  return (
    <Screen title="Redo with my kit" testId="recover-rekit">
      <KitRecoveryForm onRecovered={(result) => void accept(result)} />
      <ErrorNote error={error} />
    </Screen>
  );
}

type AcResult = { address: `0x${string}`; owner: `0x${string}`; set: ShareSet; mismatch: boolean };

/** A+C: the server's share A and the code. Afterwards, re-enrollment creates a new set with the same seed. */
function RecoverAC({ session, channel }: { session: GateSession; channel: VaultChannel }) {
  const [set, setSet] = useState<ShareSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<AcResult | null>(null);
  const [reEnrolling, setReEnrolling] = useState(false);
  const [finished, setFinished] = useState<'re-enrolled' | 'skipped' | null>(null);
  // `runSigner` empties what it transfers, and re-enrollment needs the code again.
  const codeBytes = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    fetchShareSet()
      .then((found) => {
        if (found) setSet(found);
        else {
          setError(uiError('NO_WALLET'));
          channel.respond({ ok: false, code: 'NO_WALLET' });
        }
      })
      .catch((cause: unknown) => setError(toUiError(cause, 'code')))
      .finally(() => setLoading(false));
    return () => zero(codeBytes.current ?? undefined);
  }, [channel]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!set) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = recoveryCodeToBytes(code);
      const response = await runSigner({ op: 'recover', combo: 'A+C', signed: set.signed, encC: set.encC, code: bytes.slice() });
      if (!response.ok) {
        zero(bytes);
        setError(uiError(response.code, 'code'));
        return;
      }
      codeBytes.current = bytes;
      setCode('');
      setResult({ address: response.address, owner: response.owner, set, mismatch: response.wdkVersionMismatch });
    } catch (cause) {
      setError(toUiError(cause, 'code'));
    } finally {
      setBusy(false);
    }
  }

  function finish(kind: 're-enrolled' | 'skipped', address: `0x${string}`, owner: `0x${string}`) {
    zero(codeBytes.current ?? undefined);
    codeBytes.current = null;
    setFinished(kind);
    channel.respond({ ok: true, address, owner });
  }

  if (finished && result) {
    return (
      <Screen title={finished === 're-enrolled' ? 'Wallet recovered' : 'Recovery verified'} testId="done-panel">
        <WalletAddress address={result.address} />
        {finished === 're-enrolled' ? (
          <p className="muted" data-testid="re-enrolled">
            There is a new passkey, code and kit. The previous ones can no longer be used from the vault, but an old kit still opens with its old code and yields the same seed: destroy both.
          </p>
        ) : (
          <Note tone="caution">You are still using the previous passkey and code. If you lost the passkey, rotate the set.</Note>
        )}
        <BackToApp />
      </Screen>
    );
  }

  if (reEnrolling && result) {
    return (
      <EnrollSteps
        userId={session.userId}
        title="Protect your wallet again"
        expectedAddress={result.address}
        // The server returned this set for this session, even if it was encrypted with another `sub` before being relinked.
        linkedOwner={result.set.signed.manifest.expectedAddress}
        source={() => ({
          op: 'recover',
          combo: 'A+C',
          signed: result.set.signed,
          encC: result.set.encC,
          code: (codeBytes.current as Uint8Array<ArrayBuffer>).slice(),
        })}
        onComplete={() => finish('re-enrolled', result.address, result.owner)}
      />
    );
  }

  if (result) {
    return (
      <Screen title="Code correct" testId="recover-ac-result">
        <WalletAddress address={result.address} />
        <VersionWarning show={result.mismatch} />
        <p>Create a new passkey and code to keep using this wallet. The address does not change.</p>
        <div className="actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => finish('skipped', result.address, result.owner)}
            data-testid="recover-skip"
          >
            Not now
          </button>
          <button className="button" type="button" onClick={() => setReEnrolling(true)} data-testid="re-enroll-start">
            Create new passkey
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title="Recover your wallet" testId="recover-ac">
      {loading && <Working text="Loading your wallet." />}
      {set && (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span className="label">Recovery code</span>
            <input
              className="input input-code"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              data-testid="recovery-code-input"
            />
          </label>
          <button className="button" type="submit" disabled={busy || code.trim() === ''} data-testid="recover-ac-submit">
            Recover
          </button>
        </form>
      )}
      {busy && <Working text="Checking the code on this device." />}
      <ErrorNote error={error} />
    </Screen>
  );
}
