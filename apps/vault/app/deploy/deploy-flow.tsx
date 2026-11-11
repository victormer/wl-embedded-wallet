'use client';

import type { UserOperationJson } from '@wl-embedded-wallet/sdk/protocol';
import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'viem';
import { BackToApp, ChainReview, ErrorNote, Note, OwnerAddress, Screen, WalletAddress, Working } from '@/app/_components/ui';
import { VaultGate } from '@/app/_components/vault-gate';
import { prepareDeployment, requiredPrefund, sendDeployment } from '@/lib/aa-client';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { getPrfOutput } from '@/lib/prf';
import { runSigner } from '@/lib/signer-client';
import { WalletError, type ChainStatus } from '@wl-embedded-wallet/core/types';
import { fetchChainStatus, fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function DeployFlow() {
  const channel = useVaultChannel('deploy');
  return <VaultGate channel={channel}>{() => <Deploy channel={channel} />}</VaultGate>;
}

type Done = { userOpHash?: `0x${string}`; transactionHash?: `0x${string}` };

function Deploy({ channel }: { channel: VaultChannel }) {
  const [set, setSet] = useState<ShareSet | null>(null);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [operation, setOperation] = useState<UserOperationJson | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<UiError | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const started = useRef(false);

  const chainId = channel.request?.action.kind === 'deploy' ? channel.request.action.chain.chainId : null;

  function failFinally(cause: unknown) {
    const failure = toUiError(cause);
    setError(failure);
    channel.respond({ ok: false, code: failure.code });
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const found = await fetchShareSet();
      if (!found) {
        setError(uiError('NO_WALLET'));
        channel.respond({ ok: false, code: 'NO_WALLET' });
        return;
      }
      const chainStatus = await fetchChainStatus();
      if (chainStatus.chainId !== chainId) throw new WalletError('CHAIN_REQUEST_MISMATCH');
      setSet(found);
      setStatus(chainStatus);
      const { manifest } = found.signed;
      if (chainStatus.deployed) {
        // Already deployed: it returns without signing anything.
        setDone({});
        channel.respond({ ok: true, address: manifest.smartAccount.address, owner: manifest.expectedAddress as `0x${string}` });
        return;
      }
      if (!chainStatus.deployable) throw new WalletError('CHAIN_NOT_SUPPORTED');
      // Prepared (by the server) before asking for the passkey: some browsers require the passkey prompt to happen within
      // the user's gesture.
      setOperation(await prepareDeployment(chainStatus));
    })()
      .catch(failFinally)
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve() {
    if (!set || !status || !operation) return;
    setBusy(true);
    setError(null);
    try {
      const prf = await getPrfOutput(set.credentialId);
      const { smartAccount } = set.signed.manifest;
      const response = await runSigner({ op: 'deploy', chainId: status.chainId, signed: set.signed, encB: set.encB, prf, userOperation: operation });
      if (!response.ok || !response.userOperation) {
        const failure = uiError(response.ok ? 'INTERNAL' : response.code);
        setError(failure);
        channel.respond({ ok: false, code: failure.code });
        return;
      }
      const sent = await sendDeployment(response.userOperation, smartAccount);
      setDone(sent);
      channel.respond({ ok: true, address: response.address, owner: response.owner, ...sent });
    } catch (cause) {
      const failure = toUiError(cause);
      setError(failure);
      // A cancelled passkey is not final: the user can retry or reject.
      if (failure.code !== 'CANCELLED') channel.respond({ ok: false, code: failure.code });
    } finally {
      setBusy(false);
    }
  }

  function reject() {
    channel.respond({ ok: false, code: 'USER_REJECTED' });
    setError(uiError('USER_REJECTED'));
    setOperation(null);
  }

  const manifest = set?.signed.manifest;

  if (done && manifest) {
    return (
      <Screen title="Wallet deployed" testId="deploy-done">
        <WalletAddress address={manifest.smartAccount.address} />
        {status && <ChainReview status={status} />}
        {done.transactionHash ? (
          <div className="field">
            <span className="label">Transaction</span>
            <code className="value" data-testid="deploy-tx">
              {done.transactionHash}
            </code>
          </div>
        ) : (
          <p className="muted" data-testid="deploy-already">
            It was already deployed on this network. Nothing was signed.
          </p>
        )}
        <BackToApp />
      </Screen>
    );
  }

  return (
    <Screen title="Deploy your wallet" testId="deploy-review">
      {manifest && (
        <>
          <WalletAddress address={manifest.smartAccount.address} />
          <OwnerAddress owner={manifest.expectedAddress} />
        </>
      )}
      {status && (
        <>
          <ChainReview status={status} />
          <Note data-testid="deploy-cost" data-sponsored={String(status.sponsored)}>
            {status.sponsored ? "No cost to you: this network's paymaster pays for the deployment." : "This network has no paymaster: the deployment is paid with your Safe's funds."}
          </Note>
          {operation && !status.sponsored && (
            <div className="field">
              <span className="label">Maximum network fee</span>
              <code className="value" data-testid="deploy-max-cost">
                {formatEther(requiredPrefund(operation))} {status.nativeCurrency}
              </code>
            </div>
          )}
        </>
      )}
      <p className="muted">The address is the same on every network. Deploying here does not affect the others.</p>
      {busy && <Working text="Preparing the deployment." />}
      <ErrorNote error={error} />
      {operation && (
        <div className="actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={reject} data-testid="deploy-reject">
            Reject
          </button>
          <button className="button" type="button" disabled={busy} onClick={approve} data-testid="deploy-approve">
            Approve with passkey
          </button>
        </div>
      )}
    </Screen>
  );
}
