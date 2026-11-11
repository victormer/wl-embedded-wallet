import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

// On Vercel the brand is read from the deployment itself, so it has to be traced into every function, the proxy and
// the instrumentation included (`**` matches every entry): a missing brand dir stops the vault in production. Docker
// mounts it at runtime instead, and the image build has no `VAULT_BRAND_DIR`, so the image does not change.
const brandDir = process.env.VERCEL === '1' ? process.env.VAULT_BRAND_DIR?.trim().replace(/\/+$/, '') : undefined;
const brandIncludes = brandDir && !isAbsolute(brandDir) ? { '**': [`${brandDir}/**/*`] } : {};

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  },
];

// A worker's CSP comes from its script response, not from the page.
const workerCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'none'";

/** @type {(phase: string) => import('next').NextConfig} */
const nextConfig = (phase) => ({
  // The e2e tests build with their own keys in another directory, without overwriting the development build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Generic image: all configuration is read at runtime. It starts with `node server.js`. Vercel has its own output.
  output: process.env.VERCEL === '1' ? undefined : 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: ['@wl-embedded-wallet/core', '@wl-embedded-wallet/sdk', '@wl-embedded-wallet/recovery-tool'],
  // Server only. WDK pulls in `sodium-native`, which cannot be bundled, and `pg` loads optional modules.
  serverExternalPackages: ['@tetherto/wdk-wallet-evm-erc-4337', 'pg'],
  // File tracing does not see the native addon of `sodium-native`, which WDK loads on import. Linux and macOS only.
  outputFileTracingIncludes: {
    '/api/shares': ['../../node_modules/.pnpm/sodium-native@*/node_modules/sodium-native/prebuilds/{linux,darwin}-*/**'],
    // The offline tool is read at runtime. `pnpm build` generates it before `next build`.
    '/recovery-tool': ['../../packages/recovery-tool/dist/wl-embedded-wallet-recovery.html'],
    ...brandIncludes,
  },
  allowedDevOrigins: ['vault.localhost'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      ...(phase === PHASE_DEVELOPMENT_SERVER
        ? []
        : [{ source: '/_next/static/:path*', headers: [{ key: 'Content-Security-Policy', value: workerCsp }] }]),
    ];
  },
});

export default nextConfig;
