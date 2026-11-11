'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { exchangeHandoff } from '@/lib/vault-api';
import { WalletError } from '@wl-embedded-wallet/core/types';
import type { VaultChannel } from '@/lib/vault-channel';
import { ErrorNote, Screen, Working } from './ui';

export interface GateSession {
  userId: string;
  label: string;
}

type Step =
  | { name: 'connecting' }
  | { name: 'failed' }
  | { name: 'ready'; session: GateSession };

/** Exchanges the app's token for a session. Nothing is shown until it is validated, and share A is never handed out without a session. */
export function VaultGate({ channel, children }: { channel: VaultChannel; children: (session: GateSession) => ReactNode }) {
  const [step, setStep] = useState<Step>({ name: 'connecting' });
  const [error, setError] = useState<UiError | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const { request } = channel;
    if (!request || started.current) return;
    started.current = true;
    (async () => {
      const chain = 'chain' in request.action ? request.action.chain : undefined;
      const result = await exchangeHandoff(request.token, channel.requestOrigin as string, chain?.chainId);
      if (!channel.confirmOrigin(result.origin)) throw new WalletError('ORIGIN_MISMATCH');
      setStep({ name: 'ready', session: { userId: result.userId, label: result.label } });
    })().catch((cause: unknown) => {
      const failure = toUiError(cause);
      setError(failure);
      setStep({ name: 'failed' });
      channel.respond({ ok: false, code: failure.code });
    });
  }, [channel]);

  if (channel.state === 'no-opener') {
    return (
      <Screen title="Open this window from the app" testId="no-opener">
        <p>This screen only works within a request from an authorized app.</p>
      </Screen>
    );
  }
  if (channel.state === 'invalid') {
    return (
      <Screen title="Invalid request" testId="invalid-request">
        <ErrorNote error={uiError('INVALID_REQUEST')} />
      </Screen>
    );
  }
  if (step.name === 'failed') {
    return (
      <Screen title="Could not connect">
        <ErrorNote error={error} />
      </Screen>
    );
  }
  if (step.name === 'ready') return <>{children(step.session)}</>;

  return (
    <Screen title="Connecting" testId="gate-connecting">
      <Working text="Waiting for the app's request." />
    </Screen>
  );
}
