import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { RUNTIME_CONFIG_ID } from '@/lib/runtime-config';
import { currentBrand } from '@/server/brand';
import { publicRuntimeConfig } from '@/server/config';
import { BrandFooter, BrandHeader } from './_components/brand';
import './globals.css';

export function generateMetadata(): Metadata {
  const brand = currentBrand();
  return {
    title: brand.name,
    description: `${brand.name}: your wallet keys.`,
    robots: { index: false, follow: false },
    ...(brand.favicon ? { icons: { icon: { url: brand.url(brand.favicon), type: brand.favicon.contentType } } } : {}),
  };
}

/**
 * Single Trusted Types policy (`trusted-types default`). It only allows scripts and workers from the
 * build itself. Since it defines neither `createHTML` nor `createScript`, those sinks stay blocked.
 */
const TRUSTED_TYPES_POLICY = `if (window.trustedTypes) trustedTypes.createPolicy('default', {
  createScriptURL(value) {
    const url = new URL(value, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/_next/static/')) return value;
    throw new TypeError('script URL blocked');
  },
});`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the headers forces dynamic rendering: Next needs each request's nonce.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const config = publicRuntimeConfig();
  const brand = currentBrand();
  return (
    <html lang="en">
      <head>
        {nonce && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: TRUSTED_TYPES_POLICY }} />}
        {/* Only variable values and `@font-face`, generated from a validated `brand.json`. Goes after globals.css. */}
        {brand.stylesheet && <link rel="stylesheet" href={brand.url(brand.stylesheet)} />}
      </head>
      <body>
        <div id={RUNTIME_CONFIG_ID} hidden data-rp-id={config.rpId} data-manifest-pubkey={config.manifestPubKey} data-brand={config.brand} />
        <BrandHeader
          name={brand.name}
          logo={brand.logo ? { light: brand.url(brand.logo.light), dark: brand.logo.dark ? brand.url(brand.logo.dark) : null } : null}
        />
        {children}
        <BrandFooter name={brand.name} links={brand.links} />
      </body>
    </html>
  );
}
