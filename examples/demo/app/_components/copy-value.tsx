'use client';

import { useEffect, useState, type HTMLAttributes } from 'react';
import { Check, Copy, ExternalLink } from './icons';

/** Copies `value`; the icon turns into a check for a moment. Nothing is copied unless the user clicks. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? 'copy-button is-copied' : 'copy-button'}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} />}
    </button>
  );
}

/**
 * A full address or hash in mono, never shortened in the text (tests and users compare it whole), with copy and,
 * when the chain has an explorer, a link to it.
 */
export function CopyValue({
  value,
  copyLabel,
  href,
  hrefLabel,
  hrefTestId,
  className,
  ...rest
}: { value: string; copyLabel: string; href?: string | null; hrefLabel?: string; hrefTestId?: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <div className={className ? `copy-value ${className}` : 'copy-value'}>
      <span className="mono copy-value-text" {...rest}>
        {value}
      </span>
      <span className="copy-value-tools">
        <CopyButton value={value} label={copyLabel} />
        {href && (
          <a className="copy-button" href={href} target="_blank" rel="noopener noreferrer" aria-label={hrefLabel} title={hrefLabel} data-testid={hrefTestId}>
            <ExternalLink size={14} />
          </a>
        )}
      </span>
    </div>
  );
}
