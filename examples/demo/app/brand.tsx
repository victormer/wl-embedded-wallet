import localFont from 'next/font/local';
import mark from '../../../brands/wl/favicon.svg';

// The demo uses the project's own brand (brands/wl): the vault can mount the same directory.
// Fonts are self-hosted by Next, never loaded from a CDN.
export const brandFont = localFont({
  src: [
    { path: '../../../brands/wl/fonts/InterTight-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../../../brands/wl/fonts/InterTight-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../../../brands/wl/fonts/InterTight-SemiBold.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-brand',
  display: 'swap',
});

// Addresses, hashes, codes and JSON. Not used for prose.
export const codeFont = localFont({
  src: [
    { path: '../../../brands/wl/fonts/JetBrainsMono-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../../../brands/wl/fonts/JetBrainsMono-Medium.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-code',
  display: 'swap',
  adjustFontFallback: false,
});

export const PRODUCT_NAME = 'WL Embedded Wallet';

/** The WL mark. Decorative: the product name always sits next to it as live text. */
export function BrandMark({ className, size = 28 }: { className?: string; size?: number }) {
  return <img className={className} src={mark.src} width={size} height={size} alt="" />;
}
