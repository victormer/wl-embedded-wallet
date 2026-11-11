'use client';

import { useEffect, useRef, useState } from 'react';
import { EnrollSteps, type EnrollResult } from '@/app/_components/enroll-steps';
import { ExportPanel } from '@/app/_components/export-panel';
import { KitUpgradePanel } from '@/app/_components/kit-upgrade';
import { RecoveryToolDownload } from '@/app/_components/recovery-tool';
import { BackToApp, ErrorNote, OwnerAddress, Screen, VersionWarning, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate, type GateSession } from '@/app/_components/vault-gate';
import { toUiError, type UiError } from '@/lib/error-text';
import { fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function ActivateFlow() {
  const channel = useVaultChannel('activate');
  return <VaultGate channel={channel}>{(session) => <Activate session={session} channel={channel} />}</VaultGate>;
}

type State =
  | { name: 'checking' }
  | { name: 'enroll' }
  | { name: 'done'; address: `0x${string}`; owner: `0x${string}`; set: ShareSet; mismatch: boolean; existing: boolean }
  | { name: 'failed'; error: UiError };

function Activate({ session, channel }: { session: GateSession; channel: VaultChannel }) {
  const [state, setState] = useState<State>({ name: 'checking' });
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    fetchShareSet()
      .then((set) => {
        if (!set) return setState({ name: 'enroll' });
        // A second wallet is never created: the existing one is returned.
        const { manifest } = set.signed;
        const address = manifest.smartAccount.address;
        const owner = manifest.expectedAddress as `0x${string}`;
        setState({ name: 'done', address, owner, set, mismatch: false, existing: true });
        channel.respond({ ok: true, address, owner });
      })
      .catch((cause: unknown) => {
        const error = toUiError(cause);
        setState({ name: 'failed', error });
        channel.respond({ ok: false, code: error.code });
      });
  }, [channel]);

  function complete(result: EnrollResult) {
    setState({ name: 'done', address: result.address, owner: result.owner, set: result.set, mismatch: result.wdkVersionMismatch, existing: false });
    channel.respond({ ok: true, address: result.address, owner: result.owner });
  }

  if (state.name === 'checking') {
    return (
      <Screen title="Activate your wallet">
        <Working text="Checking your account." />
      </Screen>
    );
  }
  if (state.name === 'failed') {
    return (
      <Screen title="Could not activate">
        <ErrorNote error={state.error} />
      </Screen>
    );
  }
  if (state.name === 'enroll') return <EnrollSteps userId={session.userId} title="Activate your wallet" onComplete={complete} />;

  return (
    <Screen title={state.existing ? 'You already have a wallet' : 'Wallet activated'} testId="done-panel">
      <WalletAddress address={state.address} />
      <OwnerAddress owner={state.owner} />
      <VersionWarning show={state.mismatch} />
      <BackToApp />
      {/* With an existing wallet, the new kit already includes its own tool step. */}
      {state.existing ? (
        <KitUpgradePanel wallet={state.set} combo="A+B" />
      ) : (
        <section className="panel">
          <h2>Offline recovery tool</h2>
          <RecoveryToolDownload />
        </section>
      )}
      <ExportPanel
        source={{
          signed: state.set.signed,
          encB: state.set.encB,
          credentialId: state.set.credentialId,
          exportedAt: state.set.exportedAt,
        }}
      />
    </Screen>
  );
}
