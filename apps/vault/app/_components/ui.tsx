import type { HTMLAttributes, ReactNode } from 'react';
import type { UiError } from '@/lib/error-text';
import type { ChainStatus } from '@wl-embedded-wallet/core/types';

export function Screen({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <main className="screen" data-testid={testId}>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/**
 * Fixed scale of notices, the same for every brand: `brand.json` cannot change their colors or hide them.
 * `caution` is for security warnings; it never uses the brand's accent color.
 */
export type NoteTone = 'info' | 'caution' | 'danger' | 'success';

const TONE_CLASS: Record<NoteTone, string> = { info: 'note', caution: 'note note-warn', danger: 'note note-error', success: 'note note-ok' };

/** Custom stroke icons, all at the same weight. The notice text always accompanies them. */
function NoteIcon({ tone }: { tone: NoteTone }) {
  return (
    <svg className="note-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {tone === 'caution' ? (
        <>
          <path d="M8.7 3.9a1.5 1.5 0 0 1 2.6 0l6.1 10.8a1.5 1.5 0 0 1-1.3 2.2H3.9a1.5 1.5 0 0 1-1.3-2.2Z" />
          <path d="M10 8v3.6" />
          <circle cx="10" cy="14" r="0.4" fill="currentColor" />
        </>
      ) : (
        <circle cx="10" cy="10" r="7.25" />
      )}
      {tone === 'info' && (
        <>
          <path d="M10 9.2v4.3" />
          <circle cx="10" cy="6.7" r="0.4" fill="currentColor" />
        </>
      )}
      {tone === 'danger' && <path d="m7.5 7.5 5 5m0-5-5 5" />}
      {tone === 'success' && <path d="m6.8 10.3 2.2 2.2 4.3-4.6" />}
    </svg>
  );
}

export function Note({ tone = 'info', children, ...rest }: { tone?: NoteTone; children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={TONE_CLASS[tone]} {...rest}>
      <NoteIcon tone={tone} />
      <span className="note-text">{children}</span>
    </p>
  );
}

export function ErrorNote({ error }: { error: UiError | null }) {
  if (!error) return null;
  return (
    <Note tone="danger" role="alert" data-testid="flow-error" data-code={error.code}>
      {error.text}
    </Note>
  );
}

export function WalletAddress({ address }: { address: string }) {
  return (
    <div className="field">
      <span className="label">Wallet address</span>
      <code className="value" data-testid="wallet-address">
        {address}
      </code>
    </div>
  );
}

export function OwnerAddress({ owner }: { owner: string }) {
  return (
    <div className="field">
      <span className="label">Owner (your key)</span>
      <code className="value" data-testid="wallet-owner">
        {owner}
      </code>
    </div>
  );
}

/** Network, `chainId` and RPC host: the user sees where the vault checks what they are about to sign. */
export function ChainReview({ status }: { status: ChainStatus }) {
  return (
    <>
      <div className="field">
        <span className="label">Network</span>
        <span className="value value-strong" data-testid="review-chain" data-chain-id={status.chainId}>
          {status.chainName} ({status.chainId})
        </span>
      </div>
      <div className="field">
        <span className="label">RPC</span>
        <code className="value" data-testid="review-rpc-host">
          {status.rpcHost}
        </code>
      </div>
    </>
  );
}

export function VersionWarning({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Note tone="caution" data-testid="wdk-version-warning">
      This set was created with a different version of wdk-utils. The address matches, but rotating it is recommended.
    </Note>
  );
}

export function BackToApp() {
  return (
    <button
      className="button"
      type="button"
      data-testid="back-to-app"
      onClick={() => {
        (window.opener as Window | null)?.focus();
        window.close();
      }}
    >
      Back to the app
    </button>
  );
}

export function Working({ text }: { text: string }) {
  return (
    <p className="note note-working" role="status" data-testid="flow-working">
      <span className="spinner" aria-hidden="true" />
      <span className="note-text">{text}</span>
    </p>
  );
}
