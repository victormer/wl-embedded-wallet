'use client';

import { useEffect, useRef, useState } from 'react';
import { KitUpgradePanel } from '@/app/_components/kit-upgrade';
import { BackToApp, ErrorNote, Screen, VersionWarning, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate } from '@/app/_components/vault-gate';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { getPrfOutput } from '@/lib/prf';
import { runSigner } from '@/lib/signer-client';
import { fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function UnlockFlow() {
  const channel = useVaultChannel('unlock');
  return <VaultGate channel={channel}>{() => <Unlock channel={channel} />}</VaultGate>;
}

/** Normal unlock: A+B. The seed is reconstructed in the worker and discarded. */
function Unlock({ channel }: { channel: VaultChannel }) {
  const [set, setSet] = useState<ShareSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<{ address: `0x${string}`; mismatch: boolean } | null>(null);
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
      .catch((cause: unknown) => setError(toUiError(cause)))
      .finally(() => setLoading(false));
  }, [channel]);

  async function unlock() {
    if (!set) return;
    setBusy(true);
    setError(null);
    try {
      const prf = await getPrfOutput(set.credentialId);
      const response = await runSigner({ op: 'recover', combo: 'A+B', signed: set.signed, encB: set.encB, prf });
      if (!response.ok) {
        setError(uiError(response.code));
        channel.respond({ ok: false, code: response.code });
        return;
      }
      const { address, owner } = response;
      setResult({ address, mismatch: response.wdkVersionMismatch });
      channel.respond({ ok: true, address, owner });
    } catch (cause) {
      setError(toUiError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Screen title="Wallet unlocked" testId="done-panel">
        <WalletAddress address={result.address} />
        <VersionWarning show={result.mismatch} />
        <BackToApp />
        {set && <KitUpgradePanel wallet={set} combo="A+B" />}
      </Screen>
    );
  }

  return (
    <Screen title="Unlock your wallet" testId="unlock">
      {loading && <Working text="Loading your wallet." />}
      {set && (
        <>
          <p>Confirm with your passkey to check that you can recover the wallet on this device.</p>
          <button className="button" type="button" disabled={busy} onClick={unlock} data-testid="unlock-start">
            Unlock with passkey
          </button>
        </>
      )}
      {busy && <Working text="Reconstructing the key on this device." />}
      <ErrorNote error={error} />
    </Screen>
  );
}
