import type { HTMLAttributes, ReactNode } from 'react';
import { AlertTriangle, AppWindow, CheckCircle, Info } from './icons';

export type NoticeKind = 'info' | 'ok' | 'error' | 'caution' | 'pending';

/**
 * Inline bands. Success, caution and error use the vault's fixed notice scale, so a warning here and one in the
 * popup are the same color. Info and pending use the interaction blue. Each one has its own icon and text.
 */
function NoticeIcon({ kind }: { kind: NoticeKind }) {
  if (kind === 'pending') {
    return (
      <span className="notice-pending" aria-hidden="true">
        <span className="sq pulse" />
        <AppWindow size={16} />
      </span>
    );
  }
  const Icon = kind === 'ok' ? CheckCircle : kind === 'info' ? Info : AlertTriangle;
  return <Icon className="notice-icon" size={16} />;
}

export function Notice({ kind, children, className, ...rest }: { kind: NoticeKind; children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={`notice ${kind}${className ? ` ${className}` : ''}`} {...rest}>
      <NoticeIcon kind={kind} />
      <span>{children}</span>
    </p>
  );
}
