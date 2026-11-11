import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import favicon from '../../../brands/wl/favicon.svg';
import { brandFont, codeFont, PRODUCT_NAME } from './brand';
import { SiteFooter } from './_components/site-shell';
import './globals.css';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} · Demo`,
  description: 'Live demo of an embeddable, non-custodial wallet: 2-of-3 Shamir, passkeys and Safe smart accounts on testnets.',
  icons: { icon: { url: favicon.src, type: 'image/svg+xml' } },
};

// The vault popup follows the system scheme, so the demo does too: never a cream popup over a black page.
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: '#000000',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${brandFont.variable} ${codeFont.variable}`} data-scroll-behavior="smooth">
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
