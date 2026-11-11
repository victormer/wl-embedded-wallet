import { renderToStaticMarkup } from 'react-dom/server';
import { BrandFooter, BrandHeader } from '@/app/_components/brand';
import { brandFiles, defaultBrand, loadBrand, themeCss, type BrandAsset, type BrandIssue } from '@/server/brand';

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The static page's brand, from the same `brand.json` as the vault and with the same header and footer components.
 * The files go next to the HTML, named `brand-<hash>`: the hosting needs no subdirectories.
 * Only used by `scripts/build-static-recovery.mjs`, in Node.
 */
export function renderStaticBrand(dir: string | undefined, nameOverride: string | undefined): { issues: BrandIssue[]; files: Record<string, Uint8Array>; head: string; header: string; footer: string; name: string } {
  const { brand, issues } = dir ? loadBrand(dir) : { brand: defaultBrand(), issues: [] };
  if (nameOverride) brand.name = nameOverride;
  const url = (asset: BrandAsset) => `./brand-${asset.name}`;
  const files: Record<string, Uint8Array> = {};
  const head: string[] = [];
  if (brand.custom) {
    for (const asset of brandFiles(brand)) files[`brand-${asset.name}`] = asset.bytes;
    files['brand.css'] = new TextEncoder().encode(themeCss(brand, url));
    head.push('<link rel="stylesheet" href="./brand.css">');
    if (brand.favicon) head.push(`<link rel="icon" href="${url(brand.favicon)}" type="${escapeAttribute(brand.favicon.contentType)}">`);
  }
  const logo = brand.logo ? { light: url(brand.logo.light), dark: brand.logo.dark ? url(brand.logo.dark) : null } : null;
  return {
    issues,
    files,
    head: head.join('\n'),
    // The header is already the `<header>`: the HTML only leaves a slot for it.
    header: renderToStaticMarkup(<BrandHeader name={brand.name} logo={logo} />),
    footer: renderToStaticMarkup(<BrandFooter name={brand.name} links={brand.links} />),
    name: escapeAttribute(brand.name),
  };
}
