import type { ReactNode } from 'react';
import { formatEther, formatGwei } from 'viem';
import type { SignRequest } from '@wl-embedded-wallet/core/types';
import { Note } from './ui';

export function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <span className="value" data-testid={testId}>
        {children}
      </span>
    </div>
  );
}

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

/** `nativeCurrency`: the symbol of the network the operation is for, from the vault's chain status. */
export function Review({ request, nativeCurrency = 'ETH' }: { request: SignRequest; nativeCurrency?: string }) {
  if (request.kind === 'message') {
    return (
      <div className="field">
        <span className="label">Message</span>
        <pre className="value value-pre" data-testid="sign-message">
          {request.message}
        </pre>
      </div>
    );
  }
  if (request.kind === 'typedData') {
    const { domain, primaryType, message } = request.typedData as { domain: unknown; primaryType: string; message: unknown };
    return (
      <>
        <Row label="Data type" testId="sign-typed-primary">
          {primaryType}
        </Row>
        <div className="field">
          <span className="label">Domain</span>
          <pre className="value value-pre" data-testid="sign-typed-domain">
            {toPrettyJson(domain)}
          </pre>
        </div>
        <div className="field">
          <span className="label">Fields</span>
          <pre className="value value-pre" data-testid="sign-typed-fields">
            {toPrettyJson(message)}
          </pre>
        </div>
      </>
    );
  }

  const operation = request.userOperation;
  const maxGas = BigInt(operation.callGasLimit) + BigInt(operation.verificationGasLimit) + BigInt(operation.preVerificationGas);
  return (
    <>
      {operation.calls.map((call, index) => (
        <div className="field" key={index} data-testid="sign-userop-call">
          <span className="label">
            Call {index + 1} of {operation.calls.length}
          </span>
          <dl className="call">
            <dt className="label">To</dt>
            <dd>
              <code className="value" data-testid="sign-userop-to">
                {call.to}
              </code>
            </dd>
            <dt className="label">Amount</dt>
            <dd>
              <span className="value" data-testid="sign-userop-value">
                {formatEther(BigInt(call.value))} {nativeCurrency}
              </span>
            </dd>
            <dt className="label">Data</dt>
            <dd>
              {call.data ? (
                <pre className="value value-pre" data-testid="sign-userop-data">
                  {call.data}
                </pre>
              ) : (
                <span className="value value-empty" data-testid="sign-userop-data">
                  No data
                </span>
              )}
            </dd>
          </dl>
        </div>
      ))}
      <Row label="Nonce" testId="sign-userop-nonce">
        {operation.nonce}
      </Row>
      <Row label="Gas" testId="sign-userop-gas">
        {maxGas.toString()} · max {formatGwei(BigInt(operation.maxFeePerGas))} gwei · priority {formatGwei(BigInt(operation.maxPriorityFeePerGas))} gwei
      </Row>
      <Row label="Maximum fee" testId="sign-userop-max-fee">
        {formatEther(maxGas * BigInt(operation.maxFeePerGas))} {nativeCurrency}
      </Row>
      {operation.calls.some((call) => call.data) && (
        <Note tone="caution" data-testid="sign-userop-data-warning">
          This operation calls a contract and the vault does not decode its data. Sign it only if you trust the app.
        </Note>
      )}
    </>
  );
}

export const KIND_LABELS: Record<SignRequest['kind'], string> = {
  message: 'Message',
  typedData: 'Structured data (EIP-712)',
  userOperation: 'Safe UserOperation (signed, not sent)',
};
