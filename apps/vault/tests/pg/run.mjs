// `pnpm test:pg`: temporary Postgres in Docker, on a random free port, removed when done.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const IMAGE = 'postgres:17.6-alpine';
const READY_ATTEMPTS = 120;
const name = `wl-embedded-wallet-test-pg-${randomBytes(4).toString('hex')}`;
const password = randomBytes(16).toString('hex');
const cwd = fileURLToPath(new URL('../..', import.meta.url));

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function removeContainer() {
  try {
    docker('rm', '-f', name);
  } catch {
    // Already gone.
  }
}

async function waitReady() {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      // Over TCP: the image's init server only listens on the socket.
      docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'vault', '-d', 'vault');
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error('Postgres does not start');
}

process.on('SIGINT', () => {
  removeContainer();
  process.exit(130);
});

let code = 1;
try {
  docker(
    'run', '-d', '--rm', '--name', name,
    '-e', 'POSTGRES_USER=vault', '-e', 'POSTGRES_DB=vault', '-e', `POSTGRES_PASSWORD=${password}`,
    '--tmpfs', '/var/lib/postgresql/data',
    '-p', '127.0.0.1::5432',
    IMAGE,
  );
  await waitReady();
  const port = docker('port', name, '5432/tcp').split('\n')[0].split(':').pop();
  const testDatabaseUrl = `postgres://vault:${password}@127.0.0.1:${port}/vault`;
  const command = process.argv.slice(2);
  const [bin, ...args] = command.length ? command : ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.pg.config.ts'];
  code = await new Promise((resolve) => {
    spawn(bin, args, { cwd, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl } }).on('close', resolve);
  });
} finally {
  removeContainer();
}
process.exit(code ?? 1);
