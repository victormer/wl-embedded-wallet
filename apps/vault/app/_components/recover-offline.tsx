'use client';

import { useEffect, useRef, useState } from 'react';
import { zero } from '@wl-embedded-wallet/core/encoding';
import type { VaultChannel } from '@/lib/vault-channel';
import { RecoveredPanel } from './recovered-panel';
import { KitRecoveryForm, PasskeyRecoveryForm, type Recovered } from './recovery-forms';
import { BackToApp, OwnerAddress, Screen, VersionWarning, WalletAddress } from './ui';

/** What these screens use from the channel to the app. The static page has no app. */
export type RecoveryChannel = Pick<VaultChannel, 'state' | 'respond'>;

function useRecovered(channel: RecoveryChannel) {
  const [result, setResult] = useState<Recovered | null>(null);
  const code = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(
    () => () => {
      zero(code.current ?? undefined);
    },
    [],
  );

  function accept(recovered: Recovered) {
    code.current = recovered.code;
    setResult(recovered);
    channel.respond({ ok: true, address: recovered.address, owner: recovered.owner });
  }

  return { result, code, accept };
}

function RecoveredScreen({
  result,
  code,
  channel,
  intro,
  offersTool = true,
}: {
  result: Recovered;
  code: { current: Uint8Array | null };
  channel: RecoveryChannel;
  intro: string;
  offersTool?: boolean;
}) {
  return (
    <Screen title="Wallet recovered" testId="done-panel">
      <WalletAddress address={result.address} />
      <OwnerAddress owner={result.owner} />
      <VersionWarning show={result.mismatch} />
      <p className="muted">{intro}</p>
      {channel.state === 'ready' && <BackToApp />}
      <RecoveredPanel wallet={result.wallet} code={code} offersTool={offersTool} />
    </Screen>
  );
}

/**
 * B+C, or kit and code. It makes no API calls: it is also what the static page serves, which passes
 * `offersTool={false}` because its CSP does not let it fetch the tool and, without the tool, it cannot hand out a kit.
 */
export function RecoverWithKit({ channel, offersTool = true }: { channel: RecoveryChannel; offersTool?: boolean }) {
  const { result, code, accept } = useRecovered(channel);
  if (result) {
    const intro = result.wallet.combo === 'B+C' ? 'Recovered using only your kit, your passkey and your code.' : 'Recovered using only your kit and your code, without a passkey.';
    return <RecoveredScreen result={result} code={code} channel={channel} intro={intro} offersTool={offersTool} />;
  }
  return (
    <Screen title="Recover with your kit" testId="recover-bc">
      <KitRecoveryForm onRecovered={accept} />
    </Screen>
  );
}

/** Discoverable passkey and code, with no kit or session. The server never hands out share A here. */
export function RecoverWithPasskey({ channel }: { channel: RecoveryChannel }) {
  const { result, code, accept } = useRecovered(channel);
  if (result) return <RecoveredScreen result={result} code={code} channel={channel} intro="Recovered using only your passkey and your code." />;
  return (
    <Screen title="Recover without a kit" testId="recover-passkey">
      <PasskeyRecoveryForm onRecovered={accept} />
    </Screen>
  );
}
