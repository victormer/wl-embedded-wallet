'use client';

import type { VaultSignRequest } from '@wl-embedded-wallet/sdk/protocol';
import { useEffect, useRef, useState } from 'react';
import type { VaultChain } from '@wl-embedded-wallet/sdk/client';
import { KIND_LABELS, Review, Row } from '@/app/_components/sign-review';
import { BackToApp, ChainReview, ErrorNote, Screen, VersionWarning, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate } from '@/app/_components/vault-gate';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { getPrfOutput } from '@/lib/prf';
import { parseSignRequest } from '@wl-embedded-wallet/core/sign-request';
import { runSigner } from '@/lib/signer-client';
import { WalletError, type ChainStatus, type WalletErrorCode, type SignRequest } from '@wl-embedded-wallet/core/types';
import { fetchChainStatus, fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function SignFlow() {
  const channel = useVaultChannel('sign');
  return <VaultGate channel={channel}>{() => <Sign channel={channel} />}</VaultGate>;
}

type Outcome = { name: 'signed'; address: string; mismatch: boolean } | { name: 'rejected' };

function Sign({ channel }: { channel: VaultChannel }) {
  const raw = channel.request?.action.kind === 'sign' ? channel.request.action.request : null;
  const parsed = useRef<{ request: SignRequest } | { invalid: true } | null>(null);
  if (parsed.current === null) parsed.current = parseRequest(raw);
  const request = 'request' in parsed.current ? parsed.current.request : null;

  const chain: VaultChain | null = channel.request?.action.kind === 'sign' ? channel.request.action.chain : null;
  const [set, setSet] = useState<ShareSet | null>(null);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [loading, setLoading] = useState(request !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(request ? null : uiError('INVALID_REQUEST'));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!request) {
      channel.respond({ ok: false, code: 'INVALID_REQUEST' });
      return;
    }
    (async () => {
      const found = await fetchShareSet();
      if (!found) throw new WalletError('NO_WALLET' as WalletErrorCode);
      const chainStatus = await fetchChainStatus();
      if (chainStatus.chainId !== chain?.chainId) throw new WalletError('CHAIN_REQUEST_MISMATCH');
      setStatus(chainStatus);
      // Signing only exists with the Safe deployed on this network.
      if (!chainStatus.deployed) throw new WalletError('WALLET_NOT_DEPLOYED');
      setSet(found);
    })()
      .catch((cause: unknown) => {
        const failure = toUiError(cause);
        setError(failure);
        channel.respond({ ok: false, code: failure.code });
      })
      .finally(() => setLoading(false));
  }, [chain, channel, request]);

  async function approve() {
    if (!set || !request || !status) return;
    setBusy(true);
    setError(null);
    try {
      const prf = await getPrfOutput(set.credentialId);
      const response = await runSigner({ op: 'sign', chainId: status.chainId, signed: set.signed, encB: set.encB, prf, request });
      if (!response.ok) {
        setError(uiError(response.code));
        channel.respond({ ok: false, code: response.code });
        return;
      }
      setOutcome({ name: 'signed', address: response.address, mismatch: response.wdkVersionMismatch });
      channel.respond({
        ok: true,
        address: response.address,
        owner: response.owner,
        signature: response.signature,
        ...(response.userOperation ? { userOperation: response.userOperation } : {}),
      });
    } catch (cause) {
      // A cancelled passkey is not final: the user can retry or reject.
      setError(toUiError(cause));
    } finally {
      setBusy(false);
    }
  }

  function reject() {
    setOutcome({ name: 'rejected' });
    channel.respond({ ok: false, code: 'USER_REJECTED' });
  }

  if (outcome?.name === 'signed') {
    return (
      <Screen title="Signed" testId="sign-done">
        <WalletAddress address={outcome.address} />
        <VersionWarning show={outcome.mismatch} />
        <p className="muted">The signature was sent to the app. Nothing was sent to the blockchain.</p>
        <BackToApp />
      </Screen>
    );
  }
  if (outcome?.name === 'rejected') {
    return (
      <Screen title="Signature rejected" testId="sign-rejected">
        <p>Nothing was signed.</p>
        <BackToApp />
      </Screen>
    );
  }

  return (
    <Screen title="Review what you are about to sign" testId="sign-review">
      <div className="field">
        <span className="label">Requested by</span>
        <span className="value value-strong" data-testid="sign-origin">
          {channel.origin}
        </span>
      </div>
      {request && (
        <>
          <Row label="Type" testId="sign-kind">
            {KIND_LABELS[request.kind]}
          </Row>
          {status && <ChainReview status={status} />}
          {set && (
            <>
              <div className="field">
                <span className="label">Signing Safe</span>
                <code className="value" data-testid="sign-address">
                  {set.signed.manifest.smartAccount.address}
                </code>
              </div>
              <p className="muted" data-testid="sign-authority">
                Your key, owner of the Safe, authorizes this signature only for this Safe and this network.
              </p>
            </>
          )}
          <Review request={request} nativeCurrency={status?.nativeCurrency} />
        </>
      )}
      {loading && <Working text="Loading your wallet." />}
      {busy && <Working text="Reconstructing the key for this signature only." />}
      <ErrorNote error={error} />
      {request && set && status?.deployed && (
        <div className="actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={reject} data-testid="sign-reject">
            Reject
          </button>
          <button className="button" type="button" disabled={busy} onClick={approve} data-testid="sign-approve">
            Approve with passkey
          </button>
        </div>
      )}
    </Screen>
  );
}

function parseRequest(raw: VaultSignRequest | null): { request: SignRequest } | { invalid: true } {
  try {
    return { request: parseSignRequest(raw) };
  } catch {
    // Whatever the failure, an unparseable request is never signed.
    return { invalid: true };
  }
}
