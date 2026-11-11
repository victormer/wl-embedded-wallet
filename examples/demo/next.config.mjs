import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The e2e suite builds with its own keys into another directory, without overwriting the dev build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: ['@wl-embedded-wallet/core', '@wl-embedded-wallet/sdk'],
  // Loaded from node_modules at runtime, not bundled: `pg` has optional native requires that break bundling.
  serverExternalPackages: ['pg'],
  allowedDevOrigins: ['app.localhost'],
};

export default nextConfig;
