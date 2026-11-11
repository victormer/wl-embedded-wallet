import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { CONTAINER_BRAND_DIR, ROOT } from './env.ts';

// `pnpm test:e2e:image` mode: the vault runs in the real image, with real Postgres.
export const IMAGE_MODE = process.env.E2E_VAULT_IMAGE === '1';
export const IMAGE = 'wl-embedded-wallet-vault:local';
export const PROJECT = 'wl-embedded-wallet-e2e';
export const NETWORK = `${PROJECT}_default`;
export const POSTGRES_PASSWORD = 'e2e-postgres-password';
// Same name from the host (resolves locally) and from the container (`extra_hosts`, to the host).
export const HOST_ALIAS = 'rpc.localhost';
// Standalone containers started by the suite carry this label, so only those are cleaned up.
export const CONTAINER_LABEL = 'wl-embedded-wallet-e2e=1';

const COMPOSE_FILES = ['-f', 'compose.yaml', '-f', 'e2e/compose.image.yaml'];

export function composeEnv(vault: Record<string, string>): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...vault, VAULT_IMAGE: IMAGE, VAULT_PORT: '4301', POSTGRES_PASSWORD };
}

export function compose(env: Record<string, string>, ...args: string[]): string {
  return execFileSync('docker', ['compose', '--env-file', '/dev/null', '-p', PROJECT, ...COMPOSE_FILES, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function dockerStatus(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status, stdout, stderr };
}

export function removeLabelledContainers(): void {
  const ids = docker('ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`).split('\n').filter(Boolean);
  if (ids.length) docker('rm', '-f', ...ids);
}

export function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

/** A brand directory from the host, mounted read-only where `VAULT_BRAND_DIR` expects it inside the container. */
export function brandMount(hostDir: string): string[] {
  return ['--volume', `${hostDir}:${CONTAINER_BRAND_DIR}:ro`];
}

/** The image equivalent of `node server.js`: exits with the same code and the same output. */
export function spawnImage(env: Record<string, string>, port: number): ChildProcess {
  // PATH and HOSTNAME are the image's own. SQLite can only live in /tmp in a read-only container.
  const { PATH: _path, HOSTNAME: _hostname, NODE_ENV: _nodeEnv, ...rest } = env;
  // A host brand is mounted: the image stays the same, with no rebuild.
  const mounts = rest.VAULT_BRAND_DIR ? brandMount(rest.VAULT_BRAND_DIR) : [];
  if (rest.VAULT_BRAND_DIR) rest.VAULT_BRAND_DIR = CONTAINER_BRAND_DIR;
  if (rest.DATABASE_URL?.startsWith('sqlite:') && !rest.DATABASE_URL.startsWith('sqlite:/tmp/must-not')) rest.DATABASE_URL = 'sqlite:/tmp/vault.db';
  return spawn(
    'docker',
    [
      'run', '--rm', '--init', '--label', CONTAINER_LABEL, '-p', `127.0.0.1:${port}:${port}`,
      '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...mounts,
      ...envFlags(rest),
      IMAGE,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
