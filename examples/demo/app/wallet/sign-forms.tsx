'use client';

import { VaultError, type TypedDataRequest, type VaultChain, type VaultClient, type VaultSignRequest, type VaultSignature, type VaultTransactionResult } from '@wl-embedded-wallet/sdk/client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { messageFor } from '@/lib/messages';
import { parseTransactionForm, type TransactionForm } from '@/lib/transaction';
import { ChainTile, explorerTxUrl, type ChainOption } from '../_components/chain';
import { CopyButton, CopyValue } from '../_components/copy-value';
import { Notice } from '../_components/notice';
import { Tabs, type TabItem } from '../_components/tabs';

const EXAMPLE_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function defaultTypedData(owner: string, chainId: number): TypedDataRequest {
  return {
    domain: { name: 'Example USD', version: '1', chainId, verifyingContract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner, spender: EXAMPLE_ADDRESS, value: '1000000', nonce: '0', deadline: '1893456000' },
  };
}

type OperationTab = 'message' | 'typed' | 'transaction';
type SignTab = Exclude<OperationTab, 'transaction'>;

const TABS: TabItem<OperationTab>[] = [
  { id: 'message', label: 'Message', tabTestId: 'op-tab-message', panelTestId: 'op-panel-message' },
  { id: 'typed', label: 'Typed data', tabTestId: 'op-tab-typed', panelTestId: 'op-panel-typed' },
  { id: 'transaction', label: 'Transaction', tabTestId: 'op-tab-transaction', panelTestId: 'op-panel-transaction' },
];

type SignResult = {
  kind: VaultSignRequest['kind'];
  signature: string;
  verification: { status: 'checking' } | { status: 'done'; valid: boolean; recovered: string | null; erc1271: boolean | null } | { status: 'failed' };
};
type TransactionSent = Pick<VaultTransactionResult, 'userOpHash' | 'transactionHash'>;

const KIND_LABELS: Record<VaultSignRequest['kind'], string> = {
  message: 'Message',
  typedData: 'EIP-712',
  userOperation: 'Signed UserOperation',
};

async function verifyOnServer(chainId: number, request: VaultSignRequest, signature: string): Promise<{ valid: boolean; recovered: string | null; erc1271: boolean | null }> {
  const response = await fetch('/api/signatures/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chainId, request, signature }),
  });
  if (!response.ok) throw new Error('VERIFY');
  return (await response.json()) as { valid: boolean; recovered: string | null; erc1271: boolean | null };
}

function codeOf(caught: unknown): string {
  return caught instanceof VaultError ? caught.code : 'INTERNAL';
}

/**
 * Signing and sending, one tab per operation. Every tab keeps its own result and error, and the form values live
 * here, so switching tabs loses nothing. Mounted per chain.
 */
export function SignForms(props: {
  client: VaultClient;
  address: string;
  chain: VaultChain;
  chainOption: ChainOption | null;
  deployed: boolean | null;
  deployable: boolean;
  transactionsSponsored: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onGoToDeploy: () => void;
}) {
  const { client, address, chain, chainOption, deployed, deployable, transactionsSponsored, busy, setBusy, onGoToDeploy } = props;
  const chainName = chainOption?.name ?? 'the selected chain';
  const symbol = chainOption?.nativeCurrency ?? 'ETH';

  const [tab, setTab] = useState<OperationTab>('message');
  const [message, setMessage] = useState('I authorize this operation.');
  const [typedData, setTypedData] = useState(() => JSON.stringify(defaultTypedData(address, chain.chainId), null, 2));
  const [transaction, setTransaction] = useState<TransactionForm>({ to: EXAMPLE_ADDRESS, value: '0', data: '' });
  const [signResults, setSignResults] = useState<Record<SignTab, SignResult | null>>({ message: null, typed: null });
  const [sent, setSent] = useState<TransactionSent | null>(null);
  const [errors, setErrors] = useState<Record<OperationTab, string | null>>({ message: null, typed: null, transaction: null });

  const setError = (target: OperationTab, code: string | null) => setErrors((current) => ({ ...current, [target]: code }));
  const setSignResult = (target: SignTab, result: SignResult | null) => setSignResults((current) => ({ ...current, [target]: result }));

  // `sign` opens the popup: it is called within the user gesture, with nothing async before it.
  async function runSign(target: SignTab, request: VaultSignRequest, sign: () => Promise<VaultSignature>) {
    setBusy(true);
    setError(target, null);
    setSignResult(target, null);
    try {
      const { signature } = await sign();
      setSignResult(target, { kind: request.kind, signature, verification: { status: 'checking' } });
      try {
        const verification = await verifyOnServer(chain.chainId, request, signature);
        setSignResult(target, { kind: request.kind, signature, verification: { status: 'done', ...verification } });
      } catch {
        setSignResult(target, { kind: request.kind, signature, verification: { status: 'failed' } });
      }
    } catch (caught) {
      setError(target, codeOf(caught));
    }
    setBusy(false);
  }

  // The same rule: `send` opens the popup, so it is the first thing awaited.
  async function runTransaction(send: () => Promise<VaultTransactionResult>) {
    setBusy(true);
    setError('transaction', null);
    setSent(null);
    try {
      const { userOpHash, transactionHash } = await send();
      setSent({ userOpHash, transactionHash });
    } catch (caught) {
      setError('transaction', codeOf(caught));
    }
    setBusy(false);
  }

  function submitMessage(event: FormEvent) {
    event.preventDefault();
    void runSign('message', { kind: 'message', message }, () => client.signMessage(chain, message));
  }

  function submitTypedData(event: FormEvent) {
    event.preventDefault();
    let parsed: TypedDataRequest;
    try {
      parsed = JSON.parse(typedData) as TypedDataRequest;
    } catch {
      setSignResult('typed', null);
      setError('typed', 'INVALID_JSON');
      return;
    }
    void runSign('typed', { kind: 'typedData', typedData: parsed }, () => client.signTypedData(chain, parsed));
  }

  function submitTransaction(event: FormEvent) {
    event.preventDefault();
    const call = parseTransactionForm(transaction);
    if (!call) {
      setSent(null);
      setError('transaction', 'INVALID_INPUT');
      return;
    }
    void runTransaction(() => client.sendTransaction({ chain, ...call }));
  }

  const signable = deployed === true;
  const signNotice = (
    <p className="chain-notice" data-testid="chain-notice">
      <ChainTile chainId={chain.chainId} />
      <span>Signed by your Safe on {chainName}. Nothing is sent to the blockchain: the signature is checked against the Safe with ERC-1271.</span>
    </p>
  );
  const blocked = (
    <Notice kind="info" data-testid="sign-blocked">
      Deploy your wallet to sign on this chain.
    </Notice>
  );

  let panel: ReactNode;
  if (tab === 'message') {
    panel = (
      <>
        <div className="panel-body op-section">
          <Intro chip="EIP-191">Sign a plain-text message with your Safe.</Intro>
          {signNotice}
          {signable ? (
            <form className="op-form" onSubmit={submitMessage}>
              <label className="field">
                <span className="label">Message</span>
                <textarea className="input" data-testid="sign-message-input" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
              </label>
              <div className="row">
                <button className="btn" type="submit" data-testid="sign-message-submit" disabled={busy}>
                  Sign message
                </button>
              </div>
            </form>
          ) : (
            blocked
          )}
        </div>
        <SignOutcome result={signResults.message} error={errors.message} />
      </>
    );
  } else if (tab === 'typed') {
    panel = (
      <>
        <div className="panel-body op-section">
          <Intro chip="EIP-712">Sign structured data, here a sample Permit. You can edit the JSON.</Intro>
          {signNotice}
          {signable ? (
            <form className="op-form" onSubmit={submitTypedData}>
              <label className="field">
                <span className="label">Typed data</span>
                <textarea className="input input-json" data-testid="sign-typed-input" rows={16} spellCheck={false} value={typedData} onChange={(event) => setTypedData(event.target.value)} />
              </label>
              <div className="row">
                <button className="btn" type="submit" data-testid="sign-typed-submit" disabled={busy}>
                  Sign EIP-712
                </button>
              </div>
            </form>
          ) : (
            blocked
          )}
        </div>
        <SignOutcome result={signResults.typed} error={errors.typed} />
      </>
    );
  } else {
    const txHref = sent ? explorerTxUrl(chainOption, sent.transactionHash) : null;
    panel = (
      <>
        <div className="panel-body op-section">
          <Intro chip="ERC-4337">Send one call on-chain from your Safe. The vault builds the UserOperation and you review it before signing.</Intro>
          <p className="chain-notice" data-testid="chain-notice">
            <ChainTile chainId={chain.chainId} />
            <span>Sent to {chainName} from your Safe. Once confirmed, it cannot be undone.</span>
          </p>
          {signable ? (
            <form className="op-form" onSubmit={submitTransaction} noValidate>
              <div className="fields">
                <label className="field field-wide">
                  <span className="label">Recipient</span>
                  <input
                    className="input input-mono"
                    data-testid="tx-to"
                    spellCheck={false}
                    autoComplete="off"
                    value={transaction.to}
                    onChange={(event) => setTransaction({ ...transaction, to: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="label">Amount</span>
                  <span className="input-affix">
                    <input
                      className="input num"
                      data-testid="tx-value"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-describedby="tx-value-hint"
                      value={transaction.value}
                      onChange={(event) => setTransaction({ ...transaction, value: event.target.value })}
                    />
                    <span className="input-suffix">{symbol}</span>
                  </span>
                  <span className="hint" id="tx-value-hint">
                    Paid from your Safe’s balance.
                  </span>
                </label>
                <label className="field">
                  <span className="label">Data · optional</span>
                  <input
                    className="input input-mono"
                    data-testid="tx-data"
                    placeholder="0x"
                    spellCheck={false}
                    autoComplete="off"
                    value={transaction.data}
                    onChange={(event) => setTransaction({ ...transaction, data: event.target.value })}
                  />
                </label>
              </div>
              <p className="status-line fee-line" data-testid="tx-fee" data-sponsored={String(transactionsSponsored)}>
                <span className="sq" aria-hidden="true" />
                <span>{transactionsSponsored ? 'Sponsored: the network fee is paid by the vault’s paymaster.' : `Network fee paid in ${symbol} from your Safe’s balance.`}</span>
              </p>
              <div className="row">
                <button className="btn" type="submit" data-testid="tx-submit" disabled={busy}>
                  Send transaction
                </button>
              </div>
            </form>
          ) : (
            <div className="op-form">
              <Notice kind="info" data-testid="tx-not-deployed">
                {deployed === null
                  ? `Your Safe’s deployment status on ${chainName} is unknown, so nothing can be sent from it yet.`
                  : deployable
                    ? `Your Safe isn’t deployed on ${chainName} yet. Deploy it with “Deploy on this chain” to send transactions.`
                    : `Your Safe isn’t deployed on ${chainName}, and it can’t be deployed here: this chain has no bundler configured in the vault.`}
              </Notice>
              {deployed === false && deployable && (
                <div className="row">
                  <button type="button" className="btn btn-outline" data-testid="tx-go-deploy" onClick={onGoToDeploy}>
                    Go to “Deploy on this chain”
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {errors.transaction && (
          <div className="panel-body op-section">
            <Notice kind="error" role="alert" data-testid="tx-error" data-code={errors.transaction}>
              {messageFor(errors.transaction)}
            </Notice>
          </div>
        )}
        {sent && (
          <section className="panel-body op-section" data-testid="tx-result" data-status="sent" aria-labelledby="tx-result-title">
            <Notice kind="ok" role="status">
              <span id="tx-result-title">Transaction confirmed on {chainName}.</span>
            </Notice>
            <div className="field">
              <span className="label">UserOperation hash</span>
              <CopyValue value={sent.userOpHash} copyLabel="Copy the UserOperation hash" data-testid="tx-userop-hash" />
            </div>
            <div className="field">
              <span className="label">Transaction hash</span>
              <CopyValue
                value={sent.transactionHash}
                copyLabel="Copy the transaction hash"
                href={txHref}
                hrefLabel={chainOption ? `View the transaction on the ${chainOption.name} explorer` : undefined}
                hrefTestId="tx-hash-link"
                data-testid="tx-hash"
              />
            </div>
          </section>
        )}
      </>
    );
  }

  return (
    <Tabs className="panel op-tabs" label="Wallet operations" items={TABS} selected={tab} onSelect={setTab}>
      {panel}
    </Tabs>
  );
}

function Intro({ chip, children }: { chip: string; children: ReactNode }) {
  return (
    <div className="op-intro">
      <p className="muted">{children}</p>
      <span className="chip">{chip}</span>
    </div>
  );
}

function SignOutcome({ result, error }: { result: SignResult | null; error: string | null }) {
  return (
    <>
      {error && (
        <div className="panel-body op-section">
          <Notice kind="error" role="alert" data-testid="sign-error" data-code={error}>
            {messageFor(error)}
          </Notice>
        </div>
      )}
      {result && (
        <section className="panel-body op-section" data-testid="sign-result" data-kind={result.kind} aria-labelledby="sign-result-title">
          <h3 className="panel-title" id="sign-result-title">
            Result: {KIND_LABELS[result.kind]}
          </h3>
          <div className="field">
            <span className="label">Signature</span>
            <div className="copy-value code-block">
              <span className="mono copy-value-text" data-testid="sign-signature">
                {result.signature}
              </span>
              <span className="copy-value-tools">
                <CopyButton value={result.signature} label="Copy the signature" />
              </span>
            </div>
          </div>
          {result.verification.status === 'checking' && (
            <p className="label" data-testid="sign-verifying">
              Verifying on the server…
            </p>
          )}
          {result.verification.status === 'failed' && (
            <Notice kind="error" data-testid="sign-verified" data-valid="unknown">
              The signature could not be verified on the server.
            </Notice>
          )}
          {result.verification.status === 'done' && (
            <Notice kind={result.verification.valid ? 'ok' : 'error'} data-testid="sign-verified" data-valid={String(result.verification.valid)}>
              {result.verification.valid ? 'Valid signature: it matches your Safe and what you requested.' : 'Signature NOT valid.'}
              {result.verification.erc1271 !== null && (
                <span data-testid="sign-erc1271" data-valid={String(result.verification.erc1271)}>
                  {' '}
                  ERC-1271 on the Safe: {result.verification.erc1271 ? 'valid' : 'not valid'}.
                </span>
              )}
              {result.verification.recovered && (
                <>
                  {' '}
                  Signer: <span className="mono" data-testid="sign-recovered">{result.verification.recovered}</span>
                </>
              )}
            </Notice>
          )}
        </section>
      )}
    </>
  );
}
