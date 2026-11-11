import type { BrandLinks } from '@/server/brand';

const LINK_LABELS: Record<keyof BrandLinks, string> = { support: 'Help', privacy: 'Privacy', terms: 'Terms' };

/**
 * Brand header. With a logo, the name is left for screen readers. The logo is always an `<img>`:
 * an SVG loaded that way runs nothing, and the CSP only allows images from the vault itself.
 * `scripts/build-static-recovery.mjs` also renders it statically, for the recovery page.
 */
export function BrandHeader({ name, logo }: { name: string; logo: { light: string; dark: string | null } | null }) {
  return (
    <header className="brand">
      {logo && (
        <picture>
          {logo.dark && <source media="(prefers-color-scheme: dark)" srcSet={logo.dark} />}
          <img className="brand-logo" src={logo.light} alt="" />
        </picture>
      )}
      <span className={logo ? 'brand-name visually-hidden' : 'brand-name'}>{name}</span>
    </header>
  );
}

/** Support and legal links from `brand.json`, if any. They open outside the vault, without `Referer`. */
export function BrandFooter({ name, links }: { name: string; links: BrandLinks }) {
  const keys = (Object.keys(LINK_LABELS) as (keyof BrandLinks)[]).filter((key) => links[key]);
  if (keys.length === 0) return null;
  return (
    <footer className="site-footer" data-testid="brand-footer">
      <nav aria-label={`${name} links`}>
        {keys.map((key) => (
          <a key={key} className="link" href={links[key] as string} target="_blank" rel="noopener noreferrer" data-testid={`brand-link-${key}`}>
            {LINK_LABELS[key]}
          </a>
        ))}
      </nav>
    </footer>
  );
}
