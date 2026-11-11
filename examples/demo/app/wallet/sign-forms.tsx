'use client';

import { VaultError, type TypedDataRequest, type UserOperationJson, type UserOperationRequest, type VaultChain, type VaultClient, type VaultSignRequest, type VaultSignature } from '@wl-embedded-wallet/sdk/client';
import { useState, type FormEvent } from 'react';
import { messageFor } from '@/lib/messages';
import { ChainTile } from '../_components/chain';
import { CopyButton } from '../_components/copy-value';
import { Notice } from '../_components/notice';

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

const DEFAULT_USER_OPERATION = {
  to: EXAMPLE_ADDRESS,
  value: '1000000000000000',
  data: '0x',
  nonce: '0',
  callGasLimit: '100000',
  verificationGasLimit: '200000',
  preVerificationGas: '60000',
  maxFeePerGas: '30000000000',
  maxPriorityFeePerGas: '1500000000',
};

const USER_OPERATION_FIELDS: { key: keyof typeof DEFAULT_USER_OPERATION; label: string; testId: string }[] = [
  { key: 'to', label: 'Recipient', testId: 'sign-userop-to' },
  { key: 'value', label: 'Value (wei)', testId: 'sign-userop-value' },
  { key: 'data', label: 'Data', testId: 'sign-userop-data' },
  { key: 'nonce', label: 'Nonce', testId: 'sign-userop-nonce' },
  { key: 'callGasLimit', label: 'Call gas limit', testId: 'sign-userop-call-gas' },
  { key: 'verificationGasLimit', label: 'Verification gas limit', testId: 'sign-userop-verification-gas' },
  { key: 'preVerificationGas', label: 'Pre-verification gas', testId: 'sign-userop-pre-verification-gas' },
  { key: 'maxFeePerGas', label: 'Max fee per gas (wei)', testId: 'sign-userop-max-fee' },
  { key: 'maxPriorityFeePerGas', label: 'Max priority fee (wei)', testId: 'sign-userop-max-priority' },
];

type SignResult = {
  kind: VaultSignRequest['kind'];
  signature: string;
  verification: { status: 'checking' } | { status: 'done'; valid: boolean; recovered: string | null; erc1271: boolean | null } | { status: 'failed' };
};

const KIND_LABELS: Record<VaultSignRequest['kind'], string> = {
  message: 'Message',
  typedData: 'EIP-712',
  userOperation: 'Signed UserOperation',
};

async function verifyOnServer(chainId: number, request: VaultSignRequest, signature: string, userOperation?: UserOperationJson): Promise<{ valid: boolean; recovered: string | null; erc1271: boolean | null }> {
  const response = await fetch('/api/signatures/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chainId, request, signature, ...(userOperation ? { userOperation } : {}) }),
  });
  if (!response.ok) throw new Error('VERIFY');
  return (await response.json()) as { valid: boolean; recovered: string | null; erc1271: boolean | null };
}

export function SignForms(props: { client: VaultClient; address: string; chain: VaultChain; chainName: string | null; busy: boolean; setBusy: (busy: boolean) => void }) {
  const { client, address, chain, chainName, busy, setBusy } = props;
  const [message, setMessage] = useState('I authorize this operation.');
  const [typedData, setTypedData] = useState(() => JSON.stringify(defaultTypedData(address, chain.chainId), null, 2));
  const [userOperation, setUserOperation] = useState(DEFAULT_USER_OPERATION);
  const [result, setResult] = useState<SignResult | null>(null);
  const [error, setError] = useState<{ code: string } | null>(null);

  // `sign` opens the popup: it is called within the user gesture, with nothing async before it.
  async function run(request: VaultSignRequest, sign: () => Promise<VaultSignature & { userOperation?: UserOperationJson }>) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { signature, userOperation: signedOperation } = await sign();
      setResult({ kind: request.kind, signature, verification: { status: 'checking' } });
      try {
        const verification = await verifyOnServer(chain.chainId, request, signature, signedOperation);
        setResult({ kind: request.kind, signature, verification: { status: 'done', ...verification } });
      } catch {
        setResult({ kind: request.kind, signature, verification: { status: 'failed' } });
      }
    } catch (caught) {
      setError({ code: caught instanceof VaultError ? caught.code : 'INTERNAL' });
    }
    setBusy(false);
  }

  function submitMessage(event: FormEvent) {
    event.preventDefault();
    void run({ kind: 'message', message }, () => client.signMessage(chain, message));
  }

  function submitTypedData(event: FormEvent) {
    event.preventDefault();
    let parsed: TypedDataRequest;
    try {
      parsed = JSON.parse(typedData) as TypedDataRequest;
    } catch {
      setResult(null);
      setError({ code: 'INVALID_JSON' });
      return;
    }
    void run({ kind: 'typedData', typedData: parsed }, () => client.signTypedData(chain, parsed));
  }

  function submitUserOperation(event: FormEvent) {
    event.preventDefault();
    const { to, value, data, ...gas } = userOperation;
    const request: UserOperationRequest = { calls: [{ to: to as `0x${string}`, value, ...(data && data !== '0x' ? { data: data as `0x${string}` } : {}) }], ...gas };
    void run({ kind: 'userOperation', userOperation: request }, () => client.signUserOperation(chain, request));
  }

  return (
    <>
      <p className="chain-notice" data-testid="chain-notice">
        <ChainTile chainId={chain.chainId} />
        <span>
          Signatures here come from your Safe on {chainName ?? 'the selected chain'} and are not sent to the blockchain. Messages and EIP-712 data are checked against
          the Safe with ERC-1271.
        </span>
      </p>

      {error && (
        <Notice kind="error" role="alert" data-testid="sign-error" data-code={error.code}>
          {messageFor(error.code)}
        </Notice>
      )}

      {result && (
        <section className="panel" data-testid="sign-result" data-kind={result.kind} aria-labelledby="sign-result-title">
          <div className="panel-head">
            <h2 className="panel-title" id="sign-result-title">
              Result: {KIND_LABELS[result.kind]}
            </h2>
          </div>
          <div className="panel-body">
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
          </div>
        </section>
      )}

      <form className="panel" onSubmit={submitMessage} aria-labelledby="sign-message-title">
        <div className="panel-head">
          <h2 className="panel-title" id="sign-message-title">
            Sign a message
          </h2>
          <span className="chip">EIP-191</span>
        </div>
        <div className="panel-body">
          <label className="field">
            <span className="label">Message</span>
            <textarea className="input" data-testid="sign-message-input" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <div className="row">
            <button className="btn" type="submit" data-testid="sign-message-submit" disabled={busy}>
              Sign message
            </button>
          </div>
        </div>
      </form>

      <form className="panel" onSubmit={submitTypedData} aria-labelledby="sign-typed-title">
        <div className="panel-head">
          <h2 className="panel-title" id="sign-typed-title">
            Sign EIP-712 data
          </h2>
          <span className="chip">Permit</span>
        </div>
        <div className="panel-body">
          <p className="muted">Sample Permit type. You can edit the JSON.</p>
          <label className="field">
            <span className="label">Data</span>
            <textarea className="input input-json" data-testid="sign-typed-input" rows={16} spellCheck={false} value={typedData} onChange={(event) => setTypedData(event.target.value)} />
          </label>
          <div className="row">
            <button className="btn" type="submit" data-testid="sign-typed-submit" disabled={busy}>
              Sign EIP-712
            </button>
          </div>
        </div>
      </form>

      <form className="panel" onSubmit={submitUserOperation} aria-labelledby="sign-userop-title">
        <div className="panel-head">
          <h2 className="panel-title" id="sign-userop-title">
            Sign a UserOperation
          </h2>
          <span className="chip">ERC-4337</span>
        </div>
        <div className="panel-body">
          <p className="muted">The Safe is the sender and the chain is the selected one. Sample nonce and gas values. It is only signed, not sent.</p>
          <div className="fields">
            {USER_OPERATION_FIELDS.map(({ key, label, testId }) => (
              <label key={key} className={key === 'to' ? 'field field-wide' : 'field'}>
                <span className="label">{label}</span>
                <input
                  className={key === 'to' || key === 'data' ? 'input input-mono' : 'input num'}
                  inputMode={key === 'to' || key === 'data' ? undefined : 'numeric'}
                  spellCheck={false}
                  data-testid={testId}
                  value={userOperation[key]}
                  onChange={(event) => setUserOperation({ ...userOperation, [key]: event.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn" type="submit" data-testid="sign-userop-submit" disabled={busy}>
              Sign UserOperation
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
