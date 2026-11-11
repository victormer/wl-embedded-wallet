'use client';

import { useState, type FormEvent, type RefObject } from 'react';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { DERIVATION_PATH } from '@wl-embedded-wallet/core/manifest';
import { sourceFor, type RecoveredWallet } from '@/lib/recovered';
import { downloadSeedFile } from '@/lib/seed-file';
import { InvalidSignRequest, parseSignRequest } from '@wl-embedded-wallet/core/sign-request';
import { runSigner } from '@/lib/signer-client';
import type { SignRequest } from '@wl-embedded-wallet/core/types';
import { KitUpgradePanel } from './kit-upgrade';
import { KIND_LABELS, Review } from './sign-review';
import { ErrorNote, Note, Working } from './ui';

type Kind = SignRequest['kind'];

function toRequest(kind: Kind, text: string): SignRequest {
  if (kind === 'message') return parseSignRequest({ kind, message: text });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidSignRequest();
  }
  return parseSignRequest(kind === 'typedData' ? { kind, typedData: value } : { kind, userOperation: value });
}

const PLACEHOLDERS: Record<Kind, string> = {
  message: 'The message you want to sign',
  typedData: '{ "domain": {…}, "types": {…}, "primaryType": "…", "message": {…} }',
  userOperation: '{ "calls": […], "nonce": "0", "callGasLimit": "…", … }',
};

function SignPanel({ wallet, code }: { wallet: RecoveredWallet; code: RefObject<Uint8Array | null> }) {
  const [kind, setKind] = useState<Kind>('message');
  const [chainId, setChainId] = useState('');
  const [text, setText] = useState('');
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<{ signature: string; userOperation?: unknown } | null>(null);

  const chain = Number(chainId);
  const validChain = Number.isSafeInteger(chain) && chain > 0;

  function review(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      setRequest(toRequest(kind, text));
    } catch {
      setRequest(null);
      setError(uiError('INVALID_REQUEST'));
    }
  }

  async function approve() {
    if (!request || !code.current) return;
    setBusy(true);
    setError(null);
    try {
      const source = await sourceFor(wallet, code.current);
      const response = await runSigner({ op: 'sign-recovered', chainId: chain, source, request });
      if (!response.ok) return setError(uiError(response.code, 'code'));
      if (!response.signature) return setError(uiError('INTERNAL'));
      setResult({ signature: response.signature, ...(response.userOperation ? { userOperation: response.userOperation } : {}) });
      setRequest(null);
    } catch (cause) {
      setError(toUiError(cause, 'code'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="recovered-sign">
      <h2>Sign</h2>
      <p className="muted">
        The signature is generated on this device and stays here. Nothing is sent to the blockchain. In this mode the network is not checked: a message will only be valid if your Safe is deployed on it.
      </p>
      <form className="stack" onSubmit={review}>
        <label className="field">
          <span className="label">What you are signing</span>
          <select
            className="input"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as Kind);
              setRequest(null);
            }}
            data-testid="recovered-sign-kind"
          >
            {(Object.keys(KIND_LABELS) as Kind[]).map((option) => (
              <option key={option} value={option}>
                {KIND_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Network identifier (chainId)</span>
          <input className="input" inputMode="numeric" value={chainId} onChange={(event) => setChainId(event.target.value.trim())} data-testid="recovered-sign-chain" />
        </label>
        <label className="field">
          <span className="label">Data</span>
          <textarea className="input" rows={4} placeholder={PLACEHOLDERS[kind]} value={text} onChange={(event) => setText(event.target.value)} data-testid="recovered-sign-input" />
        </label>
        <button className="button button-secondary" type="submit" disabled={!validChain || text.trim() === ''} data-testid="recovered-sign-review">
          Review
        </button>
      </form>
      {request && (
        <div className="stack" data-testid="recovered-sign-preview">
          <Review request={request} />
          <button className="button" type="button" disabled={busy} onClick={() => void approve()} data-testid="recovered-sign-approve">
            Sign
          </button>
        </div>
      )}
      {busy && <Working text="Reconstructing the key for this signature only." />}
      {result && (
        <div className="field">
          <span className="label">Signature</span>
          <code className="value" data-testid="recovered-signature">
            {result.signature}
          </code>
          {result.userOperation !== undefined && (
            <pre className="value value-pre" data-testid="recovered-userop">
              {JSON.stringify(result.userOperation, null, 2)}
            </pre>
          )}
          <p className="muted">Nothing was sent to the blockchain.</p>
        </div>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function ExportRecoveredPanel({ wallet, code }: { wallet: RecoveredWallet; code: RefObject<Uint8Array | null> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  async function start() {
    if (!code.current) return;
    setBusy(true);
    setError(null);
    try {
      const response = await runSigner({ op: 'export-recovered', source: await sourceFor(wallet, code.current) });
      if (!response.ok) return setError(uiError(response.code, 'code'));
      if (!response.mnemonic) return setError(uiError('INTERNAL'));
      downloadSeedFile(response.mnemonic, response.owner, DERIVATION_PATH);
      setDone(true);
      setConfirmed(false);
    } catch (cause) {
      setError(toUiError(cause, 'code'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="recovered-export">
      <h2>Download the seed</h2>
      <Note tone="caution">The file contains your full seed, unencrypted. Whoever has it controls your funds, and no one can revoke it.</Note>
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} data-testid="recovered-export-confirm" />
        <span>I understand the risk and want to download my seed on this device.</span>
      </label>
      <button className="button button-secondary" type="button" disabled={!confirmed || busy} onClick={() => void start()} data-testid="recovered-export-start">
        Download the seed
      </button>
      {busy && <Working text="Reconstructing the seed on this device." />}
      {done && (
        <Note tone="success" role="status" data-testid="recovered-export-done">
          File downloaded. Move it to a safe offline location.
        </Note>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

/** What can be done without share A: the seed is reconstructed and discarded in the worker, on every operation. */
export function RecoveredPanel({ wallet, code, offersTool }: { wallet: RecoveredWallet; code: RefObject<Uint8Array | null>; offersTool: boolean }) {
  return (
    <>
      <SignPanel wallet={wallet} code={code} />
      <ExportRecoveredPanel wallet={wallet} code={code} />
      {wallet.combo === 'B+C' && !wallet.hasBackup && <KitUpgradePanel wallet={wallet} combo="B+C" offersTool={offersTool} />}
    </>
  );
}
