import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aaChainsConfig, startAaStack } from '../../apps/vault/tests/aa-stack/stack.mjs';
import contracts from '../../apps/vault/tests/aa-stack/fixtures/contracts.json' with { type: 'json' };
import {
  APP,
  APP2,
  CHAIN_A,
  CHAIN_B,
  CHAIN_NO_FACTORY,
  CHAIN_WRONG_RPC,
  DIST_DIR,
  MANIFEST_PUBKEY,
  PORTS,
  EXAMPLE_BRAND_DIR,
  ROOT,
  RPC_PORTS,
  RP_ID,
  RUN_DIR,
  SECRETS_FILE,
  STATE_FILE,
  STATIC_RECOVERY_PORT,
  VAULT,
  VAULT_BUILD_ENV,
  VAULT_STANDALONE,
  demoEnv,
  vaultEnv,
} from './env.ts';
import { HOST_ALIAS, IMAGE, IMAGE_MODE, PROJECT, compose, composeEnv, docker, removeLabelledContainers } from './image.ts';

const PIDS_FILE = join(RUN_DIR, 'pids.json');

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

/** Only kills processes recorded by a previous run of this suite that still belong to it. */
function killLeftovers(): void {
  if (!existsSync(PIDS_FILE)) return;
  const recorded = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as { pid: number; group: boolean }[];
  for (const { pid, group } of recorded) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    if (!/anvil|next|server\.js/.test(command)) continue;
    try {
      process.kill(group ? -pid : pid);
    } catch {
      // It no longer exists.
    }
  }
  rmSync(PIDS_FILE);
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function assertPortsFree(): Promise<void> {
  // After killing leftovers, the port may take a moment to be released.
  await new Promise((done) => setTimeout(done, 300));
  const busy = (await Promise.all(PORTS.map(async (port) => ((await portBusy(port)) ? port : null)))).filter(Boolean);
  if (busy.length) throw new Error(`Ports in use by another process: ${busy.join(', ')}. Free them to run the e2e suite.`);
}

/** The vault is the service in `apps/`; the demo is the example in `examples/`. */
function appDir(app: string): string {
  return app === 'demo' ? 'examples/demo' : join('apps', app);
}

function nextBin(app: string): string {
  return createRequire(join(ROOT, appDir(app), 'package.json')).resolve('next/dist/bin/next');
}

/**
 * `next build` rewrites `next-env.d.ts` and `tsconfig.json` to point at the `distDir`.
 * They are restored so the e2e suite does not modify the project.
 */
function build(app: string, env: Record<string, string>): void {
  const cwd = join(ROOT, appDir(app));
  const files = ['next-env.d.ts', 'tsconfig.json'].map((name) => join(cwd, name));
  const saved = files.map((file) => (existsSync(file) ? readFileSync(file) : null));
  try {
    execFileSync(process.execPath, [nextBin(app), 'build'], {
      cwd,
      env: { ...process.env, ...env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`Build of ${app} failed:\n${failure.stdout}\n${failure.stderr}`);
  } finally {
    files.forEach((file, index) => {
      const content = saved[index];
      if (content) writeFileSync(file, content);
    });
  }
}

function startApp(app: string, port: number, env: Record<string, string>) {
  const logFile = join(RUN_DIR, `${app}.log`);
  const fd = openSync(logFile, 'w');
  const child = spawn(process.execPath, [nextBin(app), 'start', '-p', String(port)], {
    cwd: join(ROOT, appDir(app)),
    env: { ...process.env, ...env, NODE_ENV: 'production' },
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  closeSync(fd);
  return { child, logFile };
}

/** The vault starts as in production: the `standalone` output, outside pnpm and without the project's `.env` files. */
function startVault(port: number, env: Record<string, string>) {
  cpSync(join(ROOT, 'apps/vault', DIST_DIR, 'static'), join(VAULT_STANDALONE, DIST_DIR, 'static'), { recursive: true });
  const logFile = join(RUN_DIR, 'vault.log');
  const fd = openSync(logFile, 'w');
  const child = spawn(process.execPath, ['--require', join(ROOT, 'apps/vault/scripts/peer-address.cjs'), 'server.js'], {
    cwd: VAULT_STANDALONE,
    env: { ...process.env, ...env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '::' },
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  closeSync(fd);
  return { child, logFile };
}

async function waitUp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`${url} does not start`);
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // The brand files, next to the HTML.
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

/** Builds the static page as in a real deployment and serves it like any static host, with its `_headers`. */
function startStaticRecovery() {
  const dir = join(RUN_DIR, 'static-recovery');
  // With the same brand as the suite's vault, from its `brand.json`.
  execFileSync(process.execPath, ['scripts/build-static-recovery.mjs', '--rp-id', RP_ID, '--manifest-pubkey', MANIFEST_PUBKEY, '--out', dir, '--brand-dir', EXAMPLE_BRAND_DIR], {
    cwd: join(ROOT, 'apps/vault'),
    stdio: 'pipe',
  });
  const headers = Object.fromEntries(
    readFileSync(join(dir, '_headers'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => {
        const index = line.indexOf(':');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
  const server = createServer((request, response) => {
    const path = new URL(request.url as string, 'http://x').pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    const type = STATIC_TYPES[name.slice(name.lastIndexOf('.'))];
    if (!type || name.includes('/') || !existsSync(join(dir, name))) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Type': type }).end(readFileSync(join(dir, name)));
  });
  server.listen(STATIC_RECOVERY_PORT, '127.0.0.1');
  return server;
}

function scanLogs(logFiles: string[]): string[] {
  if (!existsSync(SECRETS_FILE)) return [];
  const secrets = readFileSync(SECRETS_FILE, 'utf8').split('\n').filter(Boolean);
  return logFiles.flatMap((file) => {
    const text = readFileSync(file, 'utf8').toLowerCase();
    return secrets.some((secret) => text.includes(secret.toLowerCase())) ? [file] : [];
  });
}

/** The real image with real Postgres, with the restrictions of `compose.yaml`. Returns how to stop it. */
function startVaultImage(aaChains: unknown) {
  const env = composeEnv(vaultEnv('', aaChains));
  const logFile = join(RUN_DIR, 'vault.log');
  compose(env, 'up', '--detach', '--wait', '--wait-timeout', '120', '--no-build', 'vault');
  const fd = openSync(logFile, 'w');
  const follower = spawn('docker', ['compose', '--env-file', '/dev/null', '-p', PROJECT, '-f', 'compose.yaml', '-f', 'e2e/compose.image.yaml', 'logs', '--follow', '--no-color', 'vault'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const finalLog = join(RUN_DIR, 'vault-final.log');
  return {
    logFiles: [logFile, finalLog],
    stop() {
      follower.kill();
      writeFileSync(finalLog, compose(env, 'logs', '--no-color', 'vault'));
      compose(env, 'down', '--volumes', '--remove-orphans');
      removeLabelledContainers();
    },
  };
}

function imageAaChains(chains: { chainId: number; rpcUrl: string; bundlerUrl?: string }[]): unknown {
  const config = aaChainsConfig(chains, { includeRpc: true }) as Record<string, Record<string, unknown>>;
  const byId = Object.fromEntries(chains.map((chain) => [chain.chainId, chain]));
  // A chain without a factory or bundler, and an RPC that answers with another `eth_chainId`. Inside the
  // container 127.0.0.1 is not the host, so those RPCs are given here instead of in the token.
  config[CHAIN_NO_FACTORY] = { name: 'No factory', rpcUrl: byId[CHAIN_NO_FACTORY].rpcUrl };
  config[CHAIN_WRONG_RPC] = { name: 'RPC of another chain', rpcUrl: byId[CHAIN_A].rpcUrl };
  return JSON.parse(JSON.stringify(config).replaceAll('127.0.0.1', HOST_ALIAS));
}

export default async function globalSetup() {
  mkdirSync(RUN_DIR, { recursive: true });
  killLeftovers();
  if (IMAGE_MODE) {
    compose(composeEnv(vaultEnv('', {})), 'down', '--volumes', '--remove-orphans');
    removeLabelledContainers();
  }
  await assertPortsFree();
  rmSync(SECRETS_FILE, { force: true });
  rmSync(resolve(ROOT, 'e2e/.run/screenshots'), { recursive: true, force: true });

  const started = Date.now();
  if (IMAGE_MODE) {
    log('Building the vault image');
    docker('build', '-f', join(ROOT, 'apps/vault/Dockerfile'), '-t', IMAGE, ROOT);
  } else {
    log('Building the offline tool');
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: join(ROOT, 'packages/recovery-tool'), stdio: 'pipe' });
    log('Building vault');
    build('vault', VAULT_BUILD_ENV);
  }
  if (IMAGE_MODE) {
    // The CLI and the suite's comparisons use this output, also with the image.
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: join(ROOT, 'packages/recovery-tool'), stdio: 'pipe' });
  }
  log('Building demo');
  build('demo', { NEXT_DIST_DIR: DIST_DIR });
  log(`Built in ${Math.round((Date.now() - started) / 1000)} s`);

  // On Linux, `host-gateway` does not reach what listens only on 127.0.0.1.
  const bindHost = IMAGE_MODE && process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';
  const stack = await startAaStack([
    // Transactions are sponsored on A only: on B the Safe pays for its own calls.
    { chainId: CHAIN_A, port: RPC_PORTS[CHAIN_A], withContracts: true, sponsorTransactions: true, bindHost },
    { chainId: CHAIN_B, port: RPC_PORTS[CHAIN_B], withContracts: true, bindHost },
    { chainId: CHAIN_NO_FACTORY, port: RPC_PORTS[CHAIN_NO_FACTORY], withContracts: false, bindHost },
  ]);
  const chains = stack.chains as { chainId: number; rpcUrl: string; paymasterAddress?: string; pid: number }[];
  const rpcUrl = Object.fromEntries(chains.map((chain) => [chain.chainId, chain.rpcUrl]));

  const dataDir = mkdtempSync(join(tmpdir(), 'wl-embedded-wallet-e2e-'));
  const anvilPids = chains.map((chain) => ({ pid: chain.pid, group: false }));
  writeFileSync(PIDS_FILE, JSON.stringify(anvilPids));
  let image: ReturnType<typeof startVaultImage> | undefined;
  const containerChains = IMAGE_MODE ? imageAaChains(stack.chains) : undefined;
  try {
    if (IMAGE_MODE) image = startVaultImage(containerChains);
  } catch (error) {
    await stack.stop();
    throw error;
  }
  const vault = image ? null : startVault(4301, vaultEnv(join(dataDir, 'vault.db'), aaChainsConfig(stack.chains)));
  const demo = startApp('demo', 4300, demoEnv(join(dataDir, 'demo.db'), rpcUrl));
  // Same user database and same keys, with its own `ORIGIN`.
  const demo2 = startApp('demo', 4302, demoEnv(join(dataDir, 'demo.db'), rpcUrl, APP2));
  const children = [vault?.child, demo.child, demo2.child].filter((child) => child !== undefined);
  const pids = [...anvilPids, ...children.map((child) => ({ pid: child.pid as number, group: true }))];
  writeFileSync(PIDS_FILE, JSON.stringify(pids));
  const vaultLogs = image ? image.logFiles : [vault!.logFile];

  const staticRecovery = startStaticRecovery();

  const stop = async () => {
    staticRecovery.close();
    staticRecovery.closeAllConnections();
    for (const child of children) {
      try {
        process.kill(-(child.pid as number));
      } catch {
        // It has already exited.
      }
    }
    image?.stop();
    await stack.stop();
    rmSync(PIDS_FILE, { force: true });
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    await waitUp(`${VAULT}/`);
    await waitUp(`${APP}/`);
    await waitUp(`${APP2}/`);
  } catch (error) {
    await stop();
    throw error;
  }

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      chains: Object.fromEntries(chains.map((chain) => [chain.chainId, { rpcUrl: chain.rpcUrl, paymasterAddress: chain.paymasterAddress }])),
      entryPoint: contracts.entryPoint.address,
      imageAaChains: containerChains,
    }),
  );
  log('Servers and chains ready');

  return async () => {
    await stop();
    // The secrets from every test must not appear in the server logs.
    const leaked = scanLogs([...vaultLogs, demo.logFile]);
    rmSync(SECRETS_FILE, { force: true });
    if (leaked.length) throw new Error(`Suite secrets found in the logs of: ${leaked.join(', ')}`);
    log('Server logs checked: no secrets');
  };
}
