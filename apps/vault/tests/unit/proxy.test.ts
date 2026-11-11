import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from '../../proxy';
import { json } from '../../server/http';

const HSTS = 'Strict-Transport-Security';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy security headers', () => {
  it('sends HSTS with the CSP in production on an https ORIGIN', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN', 'https://vault.test');
    const response = proxy(new NextRequest('https://vault.test/'));
    expect(response.headers.get(HSTS)).toBe('max-age=31536000');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('does not send HSTS on an http ORIGIN, a local test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN', 'http://vault.localhost:4300');
    const response = proxy(new NextRequest('http://vault.localhost:4300/'));
    expect(response.headers.get(HSTS)).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('does not send HSTS on a missing or invalid ORIGIN', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN', 'not a url');
    expect(proxy(new NextRequest('https://vault.test/')).headers.get(HSTS)).toBeNull();
    vi.stubEnv('ORIGIN', undefined);
    expect(proxy(new NextRequest('https://vault.test/')).headers.get(HSTS)).toBeNull();
  });

  it('sends neither HSTS nor CSP outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ORIGIN', 'https://vault.test');
    const response = proxy(new NextRequest('https://vault.test/'));
    expect(response.headers.get(HSTS)).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('API responses carry HSTS from json(), only in production on an https ORIGIN', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN', 'https://vault.test');
    expect(json({ ok: true }).headers.get(HSTS)).toBe('max-age=31536000');
    expect(json({ ok: true }).headers.get('Cache-Control')).toBe('no-store');
    vi.stubEnv('ORIGIN', 'http://vault.localhost:4300');
    expect(json({ ok: true }).headers.get(HSTS)).toBeNull();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ORIGIN', 'https://vault.test');
    expect(json({ ok: true }).headers.get(HSTS)).toBeNull();
  });

  it('does not run on /api/, so Next does not buffer API bodies before the body cap', () => {
    const matcher = new RegExp(`^${config.matcher[0].source}$`);
    expect(matcher.test('/api/shares')).toBe(false);
    expect(matcher.test('/api/aa/rpc')).toBe(false);
    expect(matcher.test('/recover')).toBe(true);
    expect(matcher.test('/recovery-tool')).toBe(true);
    expect(matcher.test('/brand/0123456789abcdef.css')).toBe(false);
  });
});
