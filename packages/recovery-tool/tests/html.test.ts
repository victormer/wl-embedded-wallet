import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const HTML = resolve(ROOT, 'dist/wl-embedded-wallet-recovery.html');
const SUMS = resolve(ROOT, 'dist/SHA256SUMS');

const html = () => readFileSync(HTML, 'utf8');
const inline = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html())?.[1] as string;
const cspHash = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;

describe('single-file tool', () => {
  it('loads nothing external: no scripts, no styles, no images', () => {
    const text = html();
    expect(text).not.toMatch(/<script[^>]+src=/i);
    expect(text).not.toMatch(/<link\b/i);
    expect(text).not.toMatch(/<img\b/i);
    expect(text).not.toMatch(/<iframe\b/i);
    expect(text).not.toMatch(/@import|url\(/);
    expect(text.match(/<script/g)).toHaveLength(1);
  });

  it('strict CSP via meta, with the exact hash of its script and its style', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html())?.[1] as string;
    const directives = csp.split('; ');
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("connect-src 'none'");
    expect(directives).toContain("form-action 'none'");
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("img-src 'none'");
    expect(directives).toContain("require-trusted-types-for 'script'");
    expect(directives).toContain(`script-src ${cspHash(inline('script'))} 'wasm-unsafe-eval'`);
    expect(directives).toContain(`style-src ${cspHash(inline('style'))}`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/https?:/);
  });

  it('contains no fetch call, on top of what the CSP blocks', () => {
    expect(inline('script')).not.toMatch(/\bfetch\(/);
    expect(inline('script')).not.toMatch(/new WebSocket|XMLHttpRequest|sendBeacon/);
  });

  it('inlines Argon2, with no separate files', () => {
    expect(inline('script').length).toBeGreaterThan(50_000);
    expect(html()).not.toMatch(/\.wasm["']/);
  });

  it('docs/REPRODUCIBLE-BUILDS.md publishes the hash of this build', () => {
    const sha = createHash('sha256').update(readFileSync(HTML)).digest('hex');
    expect(readFileSync(resolve(ROOT, '../../docs/REPRODUCIBLE-BUILDS.md'), 'utf8')).toContain(`${sha}  wl-embedded-wallet-recovery.html`);
  });

  it('the build is reproducible: two runs give the same bytes, those in SHA256SUMS', () => {
    const before = readFileSync(SUMS, 'utf8');
    const sha = createHash('sha256').update(readFileSync(HTML)).digest('hex');
    expect(before).toContain(`${sha}  wl-embedded-wallet-recovery.html`);
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
    expect(readFileSync(SUMS, 'utf8')).toBe(before);
  });
});
