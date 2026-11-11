import { NextResponse, type NextRequest } from 'next/server';

const CSP_HEADER = 'Content-Security-Policy';
const NONCE_HEADER = 'x-nonce';
const HSTS = 'max-age=31536000';

/** An `http:` ORIGIN is a local test with ALLOW_INSECURE_LOCAL: browsers ignore HSTS there, but it is not sent either. */
function isHttpsOrigin(): boolean {
  try {
    return new URL(process.env.ORIGIN ?? '').protocol === 'https:';
  } catch {
    return false;
  }
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "img-src 'self'",
    // The brand fonts, served by the vault itself. Never from a CDN.
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
  ].join('; ');
}

/** CSP with a per-request nonce, and HSTS. Not applied in development: Next needs `eval` and HMR. */
export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== 'production') return NextResponse.next();

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const csp = contentSecurityPolicy(nonce);
  // Next takes the nonce from this request header for its inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_HEADER, csp);
  requestHeaders.set(NONCE_HEADER, nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, csp);
  if (isHttpsOrigin()) response.headers.set('Strict-Transport-Security', HSTS);
  return response;
}

export const config = {
  // `/brand/` sets its own headers, with a sandbox CSP for the SVG: see `app/brand/[file]/route.ts`.
  // `/api/` is left out because Next buffers the body of every request the proxy sees (up to 10 MB) before the route
  // runs, which would bypass the body cap of `readJson`. API responses carry HSTS from `json()` in `server/http.ts`.
  matcher: [{ source: '/((?!api/|_next/static|_next/image|favicon.ico|brand/).*)' }],
};
