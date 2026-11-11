'use client';

import { useEffect, useRef, useState } from 'react';
import { KitRecoveryForm, PasskeyRecoveryForm, type Recovered } from '@/app/_components/recovery-forms';
import { BackToApp, ErrorNote, Note, OwnerAddress, Screen, VersionWarning, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate, type GateSession } from '@/app/_components/vault-gate';
import { zero } from '@wl-embedded-wallet/core/encoding';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { sourceFor } from '@/lib/recovered';
import { runSigner } from '@/lib/signer-client';
import { fetchShareSet, postRelink, requestRelinkChallenge } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function RelinkFlow() {
  const channel = useVaultChannel('relink');
  return <VaultGate channel={channel}>{(session) => <Relink session={session} channel={channel} />}</VaultGate>;
}

type Via = 'kit' | 'passkey';

/**
 * For whoever has lost their login: this account is new and has no wallet, and proves it controls one by signing with
 * its owner. A valid JWT is not enough. The previous account loses access, and the trail stays on the server.
 */
function Relink({ session, channel }: { session: GateSession; channel: VaultChannel }) {
  const [checking, setChecking] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [via, setVia] = useState<Via>('kit');
  const [recovered, setRecovered] = useState<Recovered | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // A final error was already sent to the app: this popup can no longer answer it, so it only shows the error.
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const code = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    fetchShareSet()
      .then((set) => {
        if (!set) return;
        setBlocked(true);
        setError(uiError('WALLET_ALREADY_EXISTS'));
        channel.respond({ ok: false, code: 'WALLET_ALREADY_EXISTS' });
      })
      .catch((cause: unknown) => {
        const failure = toUiError(cause);
        setBlocked(true);
        setError(failure);
        channel.respond({ ok: false, code: failure.code });
      })
      .finally(() => setChecking(false));
    return () => zero(code.current ?? undefined);
  }, [channel]);

  function accept(result: Recovered) {
    code.current = result.code;
    setRecovered(result);
    setError(null);
  }

  function fail(failure: UiError) {
    setError(failure);
    setFailed(true);
    channel.respond({ ok: false, code: failure.code });
  }

  async function confirm() {
    if (!recovered || !code.current || failed) return;
    setBusy(true);
    setError(null);
    try {
      const { manifest } = recovered.wallet.signed;
      const challenge = await requestRelinkChallenge(manifest.smartAccount.address, manifest.expectedAddress);
      // This vault and this account: a response with any other data never gets signed.
      if (challenge.vaultOrigin !== window.location.origin || challenge.newSub !== session.userId) return fail(uiError('RELINK_REJECTED'));
      const source = await sourceFor(recovered.wallet, code.current);
      const response = await runSigner({ op: 'sign-relink', source, relink: challenge });
      if (!response.ok) return fail(uiError(response.code, 'code'));
      if (!response.signature) return fail(uiError('INTERNAL'));
      const linked = await postRelink(challenge.nonce, response.signature);
      setDone(true);
      channel.respond({ ok: true, address: linked.address, owner: linked.owner });
    } catch (cause) {
      const failure = toUiError(cause, 'code');
      // A cancelled passkey (B+C asks for it again) is not final: the user can retry.
      if (failure.code === 'CANCELLED') setError(failure);
      else fail(failure);
    } finally {
      setBusy(false);
    }
  }

  if (done && recovered) {
    return (
      <Screen title="Wallet linked to this account" testId="relink-done">
        <WalletAddress address={recovered.address} />
        <OwnerAddress owner={recovered.owner} />
        <p className="muted">
          The previous account no longer has access. Your passkey and your code remain the same. If you think someone has them, rotate them from the app or create another wallet and move the funds.
        </p>
        <BackToApp />
      </Screen>
    );
  }

  if (recovered) {
    return (
      <Screen title="Link this wallet" testId="relink-review">
        <WalletAddress address={recovered.address} />
        <OwnerAddress owner={recovered.owner} />
        <VersionWarning show={recovered.mismatch} />
        <div className="field">
          <span className="label">It will be linked to the account</span>
          <span className="value value-strong" data-testid="relink-account">
            {session.label}
          </span>
        </div>
        <Note tone="caution">The account that currently has this wallet will lose access. With your key you will sign only this permission: it does not move funds and is not sent to any network.</Note>
        {!failed && (
          <button className="button" type="button" disabled={busy} onClick={() => void confirm()} data-testid="relink-confirm">
            Sign and link
          </button>
        )}
        {busy && <Working text="Signing on this device." />}
        <ErrorNote error={error} />
        {failed && <BackToApp />}
      </Screen>
    );
  }

  return (
    <>
      {!blocked && (
        <nav className="tabs" aria-label="How to recover the wallet">
          <button className={via === 'kit' ? 'tab tab-current' : 'tab'} aria-pressed={via === 'kit'} type="button" onClick={() => setVia('kit')} data-testid="relink-tab-kit">
            With my kit
          </button>
          <button className={via === 'passkey' ? 'tab tab-current' : 'tab'} aria-pressed={via === 'passkey'} type="button" onClick={() => setVia('passkey')} data-testid="relink-tab-passkey">
            Without a kit
          </button>
        </nav>
      )}
      <Screen title="Link a wallet you already have" testId="relink">
        {checking && <Working text="Checking your account." />}
        {!checking && !blocked && (
          <>
            <p>If you have lost access to your previous account, recover your wallet here and link it to this one. Nothing leaves this device except the permission signature.</p>
            {via === 'kit' ? <KitRecoveryForm onRecovered={accept} /> : <PasskeyRecoveryForm onRecovered={accept} />}
          </>
        )}
        <ErrorNote error={error} />
      </Screen>
    </>
  );
}
