'use client';

import type { UserOperationJson, VaultCall } from '@wl-embedded-wallet/sdk/protocol';
import { isAllowedTransactionCall } from '@wl-embedded-wallet/core/safe';
import { parseVaultCall } from '@wl-embedded-wallet/core/sign-request';
import { WalletError, type ChainStatus, type WalletErrorCode } from '@wl-embedded-wallet/core/types';
import { useEffect, useRef, useState } from 'react';
import { Row } from '@/app/_components/sign-review';
import { TransactionCallReview, TransactionCost } from '@/app/_components/transaction-review';
import { BackToApp, ChainReview, ErrorNote, Screen, Working } from '@/app/_components/ui';
import { VaultGate } from '@/app/_components/vault-gate';
import { prepareTransaction, SentTransactionError, sendTransaction } from '@/lib/aa-client';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { getPrfOutput } from '@/lib/prf';
import { runSigner } from '@/lib/signer-client';
import { fetchChainStatus, fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { useVaultChannel, type VaultChannel } from '@/lib/vault-channel';

export function TransactionFlow() {
  const channel = useVaultChannel('transaction');
  return <VaultGate channel={channel}>{() => <Transaction channel={channel} />}</VaultGate>;
}

type Outcome =
  | { name: 'sent'; userOpHash: `0x${string}`; transactionHash: `0x${string}` }
  // On-chain without success, or not confirmed in time: the hashes are still shown, so the user can look them up.
  | { name: 'unconfirmed'; error: UiError; userOpHash: `0x${string}`; transactionHash: `0x${string}` | null }
  | { name: 'rejected' };

function parseCall(raw: unknown): VaultCall | null {
  try {
    return parseVaultCall(raw);
  } catch {
    // Whatever the failure, an unparseable call is never prepared or signed.
    return null;
  }
}

function Transaction({ channel }: { channel: VaultChannel }) {
  const action = channel.request?.action.kind === 'transaction' ? channel.request.action : null;
  const parsed = useRef<{ call: VaultCall | null } | null>(null);
  if (parsed.current === null) parsed.current = { call: parseCall(action?.transaction) };
  const call = parsed.current.call;
  const chainId = action?.chain.chainId ?? null;

  const [set, setSet] = useState<ShareSet | null>(null);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [operation, setOperation] = useState<UserOperationJson | null>(null);
  const [busy, setBusy] = useState(call !== null);
  const [busyText, setBusyText] = useState('Preparing the transaction.');
  const [error, setError] = useState<UiError | null>(call ? null : uiError('INVALID_REQUEST'));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const started = useRef(false);

  function failFinally(cause: unknown) {
    const failure = toUiError(cause);
    setError(failure);
    setOperation(null);
    channel.respond({ ok: false, code: failure.code });
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!call) {
      channel.respond({ ok: false, code: 'INVALID_REQUEST' });
      return;
    }
    (async () => {
      const found = await fetchShareSet();
      if (!found) throw new WalletError('NO_WALLET' as WalletErrorCode);
      const chainStatus = await fetchChainStatus();
      if (chainStatus.chainId !== chainId) throw new WalletError('CHAIN_REQUEST_MISMATCH');
      setSet(found);
      setStatus(chainStatus);
      // Sending only exists with the Safe deployed on this network.
      if (!chainStatus.deployed) throw new WalletError('WALLET_NOT_DEPLOYED');
      if (!chainStatus.bundler) throw new WalletError('CHAIN_NOT_SUPPORTED');
      if (!isAllowedTransactionCall(found.signed.manifest.smartAccount.address, call)) throw new WalletError('CALL_NOT_ALLOWED');
      // Prepared (by the server) before asking for the passkey: some browsers require the passkey prompt to happen within
      // the user's gesture.
      setOperation(await prepareTransaction(call, chainStatus));
    })()
      .catch(failFinally)
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve() {
    if (!set || !status || !operation || !call) return;
    setBusy(true);
    setBusyText('Reconstructing the key for this transaction only.');
    setError(null);
    try {
      const prf = await getPrfOutput(set.credentialId);
      const { smartAccount } = set.signed.manifest;
      const response = await runSigner({ op: 'send-transaction', chainId: status.chainId, signed: set.signed, encB: set.encB, prf, transaction: call, userOperation: operation });
      if (!response.ok || !response.userOperation) {
        failFinally(new WalletError(response.ok ? 'INTERNAL' : response.code));
        return;
      }
      setBusyText('Sending the transaction and waiting for it to be confirmed.');
      const sent = await sendTransaction(response.userOperation, smartAccount);
      setOutcome({ name: 'sent', ...sent });
      channel.respond({ ok: true, address: response.address, owner: response.owner, chainId: status.chainId, ...sent });
    } catch (cause) {
      const failure = toUiError(cause);
      if (cause instanceof SentTransactionError) {
        setOutcome({ name: 'unconfirmed', error: failure, userOpHash: cause.userOpHash, transactionHash: cause.transactionHash });
        channel.respond({ ok: false, code: failure.code });
        return;
      }
      setError(failure);
      // A cancelled passkey is not final: the user can retry or reject.
      if (failure.code !== 'CANCELLED') {
        setOperation(null);
        channel.respond({ ok: false, code: failure.code });
      }
    } finally {
      setBusy(false);
    }
  }

  function reject() {
    setOutcome({ name: 'rejected' });
    channel.respond({ ok: false, code: 'USER_REJECTED' });
  }

  const safe = set?.signed.manifest.smartAccount.address;
  const nativeCurrency = status?.nativeCurrency ?? 'ETH';

  if (outcome?.name === 'rejected') {
    return (
      <Screen title="Transaction rejected" testId="tx-rejected">
        <p>Nothing was signed or sent.</p>
        <BackToApp />
      </Screen>
    );
  }
  if (outcome?.name === 'sent' || outcome?.name === 'unconfirmed') {
    return (
      <Screen title={outcome.name === 'sent' ? 'Transaction confirmed' : 'Transaction not confirmed'} testId={outcome.name === 'sent' ? 'tx-done' : 'tx-unconfirmed'}>
        {outcome.name === 'unconfirmed' && <ErrorNote error={outcome.error} />}
        {status && <ChainReview status={status} />}
        {outcome.transactionHash && (
          <div className="field">
            <span className="label">Transaction</span>
            <code className="value" data-testid="tx-hash">
              {outcome.transactionHash}
            </code>
          </div>
        )}
        <div className="field">
          <span className="label">UserOperation</span>
          <code className="value" data-testid="tx-userop-hash">
            {outcome.userOpHash}
          </code>
        </div>
        <BackToApp />
      </Screen>
    );
  }

  return (
    <Screen title="Review the transaction" testId="tx-review">
      <div className="field">
        <span className="label">Requested by</span>
        <span className="value value-strong" data-testid="tx-origin">
          {channel.origin}
        </span>
      </div>
      {call && (
        <>
          <Row label="Type" testId="tx-kind">
            Transaction from your Safe (sent on-chain)
          </Row>
          {status && <ChainReview status={status} />}
          {safe && (
            <div className="field">
              <span className="label">From your Safe</span>
              <code className="value" data-testid="tx-safe">
                {safe}
              </code>
            </div>
          )}
          <TransactionCallReview call={call} nativeCurrency={nativeCurrency} />
          {operation && <TransactionCost operation={operation} nativeCurrency={nativeCurrency} />}
        </>
      )}
      {busy && <Working text={busyText} />}
      <ErrorNote error={error} />
      {operation && (
        <div className="actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={reject} data-testid="tx-reject">
            Reject
          </button>
          <button className="button" type="button" disabled={busy} onClick={approve} data-testid="tx-approve">
            Approve with passkey
          </button>
        </div>
      )}
    </Screen>
  );
}
