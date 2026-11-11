'use client';

import { useEffect, useRef, useState } from 'react';
import { ExportPanel } from '@/app/_components/export-panel';
import { BackToApp, ErrorNote, Screen, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate } from '@/app/_components/vault-gate';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function ExportFlow() {
  const channel = useVaultChannel('export');
  // Always with a token: a live session is not enough to open this popup from another page.
  return <VaultGate channel={channel}>{() => <Export channel={channel} initial={null} />}</VaultGate>;
}

function Export({ channel, initial }: { channel: VaultChannel; initial: ShareSet | null }) {
  const [set, setSet] = useState(initial);
  const [loading, setLoading] = useState(initial === null);
  const [error, setError] = useState<UiError | null>(null);
  const loaded = useRef(initial !== null);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    // A wallet that cannot be loaded ends the operation: the app is told, so its promise does not wait for the popup to close.
    fetchShareSet()
      .then((found) => {
        if (found) return setSet(found);
        setError(uiError('NO_WALLET'));
        channel.respond({ ok: false, code: 'NO_WALLET' });
      })
      .catch((cause: unknown) => {
        const failure = toUiError(cause);
        setError(failure);
        channel.respond({ ok: false, code: failure.code });
      })
      .finally(() => setLoading(false));
  }, [channel]);

  return (
    <Screen title="Download the seed" testId="export">
      {loading && <Working text="Loading your wallet." />}
      {set && (
        <>
          <WalletAddress address={set.signed.manifest.smartAccount.address} />
          <ExportPanel
            source={{ signed: set.signed, encB: set.encB, credentialId: set.credentialId, exportedAt: set.exportedAt }}
            onExported={(address, owner) => channel.respond({ ok: true, address, owner })}
          />
          <BackToApp />
        </>
      )}
      <ErrorNote error={error} />
    </Screen>
  );
}
