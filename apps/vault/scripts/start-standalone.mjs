// The `standalone` output does not include the static assets. This copies them and starts the server with
// `node --require peer-address.cjs server.js`, as the image does.
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const distDir = process.env.NEXT_DIST_DIR ?? '.next';
const standalone = join(app, distDir, 'standalone', 'apps', 'vault');

if (!existsSync(join(standalone, 'server.js'))) {
  console.error('The standalone output is missing. Run `pnpm build` first.');
  process.exit(1);
}
cpSync(join(app, distDir, 'static'), join(standalone, distDir, 'static'), { recursive: true });

const preload = fileURLToPath(new URL('./peer-address.cjs', import.meta.url));
const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
  cwd: standalone,
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT ?? '3201', HOSTNAME: '::' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code) => process.exit(code ?? 1));
