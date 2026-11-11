import type { ReactNode } from 'react';
import { DOCS_URL, LICENSE_URL, REPO_URL, SECURITY_URL, VERSION } from '@/lib/links';
import { BrandMark, PRODUCT_NAME } from '../brand';
import { Code, ExternalLink } from './icons';

type NavItem = { href: string; label: string; active?: boolean; external?: boolean };

const HOME_NAV: NavItem[] = [
  { href: '#how', label: 'How it works' },
  { href: '#demo', label: 'Live demo' },
  { href: DOCS_URL, label: 'Docs', external: true },
];

const WALLET_NAV: NavItem[] = [
  { href: '/wallet', label: 'Wallet', active: true },
  { href: DOCS_URL, label: 'Docs', external: true },
];

/** Black in both color schemes. `actions` goes at the right end (the signed-in user's sign-out button). */
export function SiteHeader({ page, actions }: { page: 'home' | 'wallet'; actions?: ReactNode }) {
  const nav = page === 'home' ? HOME_NAV : WALLET_NAV;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="topbar-id" href={page === 'home' ? '#top' : '/wallet'}>
          <BrandMark className="topbar-mark" />
          <span className="topbar-name">{PRODUCT_NAME}</span>
          <span className="topbar-chip">Demo</span>
        </a>
        <nav className="topbar-nav" aria-label="Main">
          {nav.map(({ href, label, active, external }) => (
            <a
              key={label}
              href={href}
              className={active ? 'is-active' : undefined}
              aria-current={active ? 'page' : undefined}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className="status-chip" title="Every network in this demo is a testnet">
            <span className="sq caution" aria-hidden="true" />
            Testnets
          </span>
          <a className="icon-button" href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub">
            <Code />
          </a>
          {actions}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-text">
          <p className="footer-risk">Testnet demo. Version {VERSION} has not been audited: do not use real funds.</p>
          <p className="footer-credit">
            Built on Tether’s Wallet Development Kit (WDK). An independent open-source project, not affiliated with or endorsed by Tether. WDK is a trademark of
            its owner.
          </p>
        </div>
        <nav className="footer-links" aria-label="Project">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Source code
            <ExternalLink size={12} />
          </a>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            Documentation
            <ExternalLink size={12} />
          </a>
          <a href={SECURITY_URL} target="_blank" rel="noopener noreferrer">
            Security policy
            <ExternalLink size={12} />
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
            License: Apache-2.0
            <ExternalLink size={12} />
          </a>
        </nav>
      </div>
    </footer>
  );
}
