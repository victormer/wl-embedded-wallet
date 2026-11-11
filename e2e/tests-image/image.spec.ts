import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { validateConfig } from '../../apps/vault/server/config.ts';
import { ERC1271_MAGIC, erc1271 } from '../support/chain.ts';
import { APP, CHAIN_A, HANDOFF_PRIVATE_KEY, MANIFEST_SIGNING_KEY, EXAMPLE_BRAND_DIR, ROOT, RP_ID, SERVICE_TOKEN, VAULT, vaultEnv } from '../support/env.ts';
import { expect, runState, test, type Harness } from '../support/harness.ts';
import { CONTAINER_LABEL, HOST_ALIAS, IMAGE, NETWORK, POSTGRES_PASSWORD, brandMount, compose, composeEnv, docker, dockerStatus, envFlags } from '../support/image.ts';

const REPLICA_PORT = 4304;
const REPLICA_ORIGIN = `http://${RP_ID}:${REPLICA_PORT}`;
const POSTGRES_NAME = 'wl-embedded-wallet-e2e-postgres-1';
const HEALTH_TIMEOUT_MS = 60_000;
const RESTRICTIONS = ['--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init'];

function mainEnv(): Record<string, string> {
  return composeEnv(vaultEnv('', runState().imageAaChains));
}

function mainContainer(): string {
  return compose(mainEnv(), 'ps', '-q', 'vault').trim();
}

function health(container: string): string {
  return docker('inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', container);
}

async function waitHealth(container: string, status: string): Promise<void> {
  await expect.poll(() => health(container), { timeout: HEALTH_TIMEOUT_MS, intervals: [500] }).toBe(status);
}

function runContainer(name: string, env: Record<string, string>, extra: string[] = []): string {
  return docker(
    'run', '--detach', '--name', name, '--label', CONTAINER_LABEL, '--network', NETWORK,
    '--add-host', `${HOST_ALIAS}:host-gateway`, '-p', '127.0.0.1::3000',
    // The same brand as the main vault: `VAULT_BRAND_DIR` arrives in the environment.
    ...RESTRICTIONS, ...brandMount(EXAMPLE_BRAND_DIR), ...extra, ...envFlags(env), IMAGE,
  );
}

function publishedPort(container: string): number {
  return Number(docker('port', container, '3000/tcp').split('\n')[0].split(':').pop());
}

function removeContainers(...names: string[]): void {
  dockerStatus('rm', '-f', ...names);
}

/** Variables for a replica on another database of the same Postgres, behind the test proxy. */
function replicaEnv(database: string, overrides: Record<string, string> = {}): Record<string, string> {
  const { DATABASE_URL: _url, NEXT_DIST_DIR: _dist, ...base } = vaultEnv('', runState().imageAaChains);
  return { ...base, ORIGIN: REPLICA_ORIGIN, DATABASE_URL: `postgres://vault:${POSTGRES_PASSWORD}@postgres:5432/${database}`, ...overrides };
}

/** A minimal load balancer: each new connection goes to the chosen replica, and switching cuts the open ones. */
class SwitchProxy {
  readonly hits = new Map<number, number>();
  private target = 0;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  constructor(port: number) {
    this.server = createServer((client) => {
      const target = this.target;
      this.hits.set(target, (this.hits.get(target) ?? 0) + 1);
      const upstream = createConnection({ port: target, host: '127.0.0.1' });
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => this.sockets.delete(socket));
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server.listen(port, '127.0.0.1');
  }

  use(target: number): void {
    this.target = target;
    for (const socket of this.sockets) socket.destroy();
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }
}

async function activateOn(h: Harness, origin: string): Promise<{ safe: `0x${string}` }> {
  await h.register();
  const opened = h.context.waitForEvent('page');
  const result = h.direct('activate', { kind: 'activate' }, undefined, origin);
  h.popup = await opened;
  await h.addAuthenticator();
  await h.enrollSteps();
  await h.P('done-panel').waitFor();
  const outcome = await result;
  expect(outcome).toMatchObject({ ok: true });
  return { safe: outcome.address as `0x${string}` };
}

test.describe('J · image contents', () => {
  test('contains no keys, .env or foreign code, and runs as non-root on the local architecture', () => {
    const inspect = JSON.parse(docker('inspect', IMAGE))[0] as {
      Architecture: string;
      Size: number;
      Config: { User: string; Env: string[]; Healthcheck?: { Test: string[] } };
    };
    expect(inspect.Architecture).toBe(process.arch === 'x64' ? 'amd64' : process.arch);
    expect(inspect.Config.User).toBe('node');
    expect(inspect.Config.Healthcheck?.Test.join(' ')).toContain('/api/health');
    console.log(`[image] ${inspect.Architecture}, ${Math.round(inspect.Size / 1024 / 1024)} MB`);

    const allowedEnv = ['PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED', 'HOSTNAME', 'PORT'];
    expect(inspect.Config.Env.map((entry) => entry.split('=')[0]).sort()).toEqual([...allowedEnv].sort());
    expect(inspect.Config.Env).toContain('HOSTNAME=0.0.0.0');
    expect(inspect.Config.Env).toContain('PORT=3000');

    // Real values from the development environment and the suite.
    const secrets = [MANIFEST_SIGNING_KEY, HANDOFF_PRIVATE_KEY, SERVICE_TOKEN, vaultEnv('', {}).MASTER_KEY];
    for (const file of ['apps/vault/.env.local', 'examples/demo/.env.local']) {
      if (!existsSync(join(ROOT, file))) continue;
      secrets.push(...[...readFileSync(join(ROOT, file), 'utf8').matchAll(/^[A-Z_]+=([0-9a-f]{32,})$/gm)].map((match) => match[1]));
    }
    expect(secrets.length).toBeGreaterThan(4);

    const history = docker('history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE);
    for (const secret of secrets) expect(history).not.toContain(secret);
    // The HEALTHCHECK's `process.env` is not a file.
    expect(history).not.toMatch(/(^|[\s/])\.env/m);

    // Final file system.
    const scan = execFileSync('docker', ['run', '--rm', '-i', '--entrypoint', 'sh', IMAGE, '-c', 'grep -rlF -f /dev/stdin /app /home/node 2>/dev/null; true'], {
      input: secrets.join('\n'),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(scan.trim()).toBe('');
    const present = docker(
      'run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      "find /app /home/node -name '.env*' -not -path '*/node_modules/*'; find /app/node_modules -maxdepth 6 -name '.env' ; ls -d /app/examples/demo /app/e2e /app/docs 2>/dev/null; which pnpm; true",
    );
    const lines = present.split('\n');
    expect(lines.filter((line) => /\.env|apps\/demo|e2e|docs|pnpm/.test(line))).toEqual([]);
    expect(docker('run', '--rm', '--entrypoint', 'id', IMAGE, '-u')).not.toBe('0');

    // All layers, including files a later layer might have deleted.
    const dir = mkdtempSync(join(tmpdir(), 'vault-layers-'));
    try {
      const tarball = join(dir, 'image.tar');
      docker('save', IMAGE, '-o', tarball);
      execFileSync('tar', ['-xf', tarball, '-C', dir]);
      const blobs = join(dir, 'blobs/sha256');
      let layers = 0;
      for (const blob of readdirSync(blobs)) {
        const path = join(blobs, blob);
        if (statSync(path).size < 1024) continue;
        let names: string;
        try {
          names = execFileSync('tar', ['-tf', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
        } catch {
          continue; // Manifests and configuration.
        }
        layers += 1;
        expect(names.split('\n').filter((name) => /(^|\/)\.env(\.|$)/.test(name) && !name.includes('node_modules/'))).toEqual([]);
      }
      expect(layers).toBeGreaterThan(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('generate-secrets produces a valid environment and keeps the private key separate', () => {
    const run = () => {
      const result = dockerStatus('run', '--rm', IMAGE, 'node', 'scripts/generate-secrets.mjs');
      expect(result.status).toBe(0);
      return result;
    };
    const first = run();
    const env = Object.fromEntries(first.stdout.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const integrator = Object.fromEntries(first.stderr.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));

    expect(first.stdout).not.toContain(integrator.VAULT_HANDOFF_PRIVATE_KEY);
    // The vault receives no handoff key: the integrator publishes the public one in its JWKS.
    expect(env.HANDOFF_PUBLIC_KEY).toBeUndefined();
    expect(Buffer.from(ed25519.getPublicKey(Buffer.from(integrator.VAULT_HANDOFF_PRIVATE_KEY, 'hex')))).toHaveLength(32);
    expect(integrator.VAULT_HANDOFF_KID).toMatch(/^handoff-[0-9a-f]{16}$/);
    expect(integrator.VAULT_SERVICE_TOKEN).toBe(env.VAULT_SERVICE_TOKEN);
    expect(run().stdout).not.toContain(env.MASTER_KEY);

    const issues = validateConfig(
      { ...env, ORIGIN: 'https://vault.example.test', RP_ID: 'vault.example.test', HANDOFF_JWKS_URL: 'https://app.example.test/.well-known/jwks.json', HANDOFF_ISSUER: 'https://app.example.test', DATABASE_URL: 'postgres://u:p@h/v' },
      true,
    );
    expect(issues).toEqual([]);
  });

  test('compose.yaml with .env.example requires the secrets, and with them it validates, Caddy included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-compose-'));
    try {
      const config = (envFile: string) => dockerStatus('compose', '--project-directory', ROOT, '-f', join(ROOT, 'compose.yaml'), '--env-file', envFile, '--profile', 'tls', 'config', '--quiet');
      const incomplete = config(join(ROOT, '.env.example'));
      expect(incomplete.status).not.toBe(0);
      // Compose interpolates in a nondeterministic order: the error names any of the empty secrets.
      expect(incomplete.stderr).toMatch(/required variable (POSTGRES_PASSWORD|MASTER_KEY|MANIFEST_SIGNING_KEY|VAULT_SERVICE_TOKEN) is missing/);

      const generated = dockerStatus('run', '--rm', IMAGE, 'node', 'scripts/generate-secrets.mjs').stdout;
      const example = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n').filter((line) => !/^(MASTER_KEY|MANIFEST_SIGNING_KEY|VAULT_SERVICE_TOKEN|POSTGRES_PASSWORD)=/.test(line));
      const complete = join(dir, '.env');
      writeFileSync(complete, `${generated}\n${example.join('\n')}\n`);
      expect(config(complete).status).toBe(0);

      const caddyImage = /image: (caddy:\S+)/.exec(readFileSync(join(ROOT, 'compose.yaml'), 'utf8'))![1];
      const validated = dockerStatus(
        'run', '--rm', '-e', 'VAULT_DOMAIN=vault.example.test', '-v', `${join(ROOT, 'deploy/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
        caddyImage, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
      );
      expect(validated.status, validated.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('J · container', () => {
  test('the suite runs with the security restrictions, and they are real', () => {
    const container = mainContainer();
    const { HostConfig } = JSON.parse(docker('inspect', container))[0] as {
      HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[]; Tmpfs: Record<string, string>; Init: boolean };
    };
    expect(HostConfig.ReadonlyRootfs).toBe(true);
    expect(HostConfig.CapDrop).toContain('ALL');
    expect(HostConfig.SecurityOpt.join(' ')).toContain('no-new-privileges');
    expect(Object.keys(HostConfig.Tmpfs)).toContain('/tmp');
    expect(health(container)).toBe('healthy');

    expect(docker('exec', container, 'id', '-u')).not.toBe('0');
    expect(dockerStatus('exec', container, 'sh', '-c', 'touch /app/written').status).not.toBe(0);
    expect(dockerStatus('exec', container, 'sh', '-c', 'touch /tmp/written').status).toBe(0);
    // No capabilities or escalation: the process has no effective capabilities.
    expect(docker('exec', container, 'sh', '-c', "grep CapEff /proc/1/status | tr -d '[:space:]'")).toBe('CapEff:0000000000000000');
    expect(docker('exec', container, 'sh', '-c', "grep NoNewPrivs /proc/self/status | tr -d '[:space:]'")).toBe('NoNewPrivs:1');
  });

  test('the s2s curl from docs/INTEGRATION.md works against the container', async ({ h }) => {
    const curl = (path: string, token: string) =>
      execFileSync('curl', ['-sS', '-w', '\n%{http_code}', '-H', `Authorization: Bearer ${token}`, `${VAULT}${path}`], { encoding: 'utf8' }).split('\n');

    const docs = readFileSync(join(ROOT, 'docs/INTEGRATION.md'), 'utf8');
    expect(docs).toContain('curl -H "Authorization: Bearer $VAULT_SERVICE_TOKEN" "$VAULT_ORIGIN/api/s2s/accounts/$SUB"');
    expect(docs).toContain('curl -H "Authorization: Bearer $VAULT_SERVICE_TOKEN" "$VAULT_ORIGIN/api/s2s/accounts/$SUB?chainId=11155111"');

    expect(curl('/api/s2s/accounts/user-without-wallet', 'wrong-token')[1]).toBe('401');
    const [empty, emptyStatus] = curl('/api/s2s/accounts/user-without-wallet', SERVICE_TOKEN);
    expect(emptyStatus).toBe('200');
    expect(JSON.parse(empty)).toEqual({ exists: false, address: null, owner: null });

    const account = await h.activate(await h.register());
    const sub = await h.app.evaluate(async () => ((await (await fetch('/api/me')).json()) as { userId: string }).userId);
    const [found] = curl(`/api/s2s/accounts/${sub}`, SERVICE_TOKEN);
    expect(JSON.parse(found)).toEqual({ exists: true, address: account.safe, owner: account.owner });
    const [onChain] = curl(`/api/s2s/accounts/${sub}?chainId=${CHAIN_A}`, SERVICE_TOKEN);
    expect(JSON.parse(onChain)).toMatchObject({ exists: true, address: account.safe, chainId: CHAIN_A, deployed: false, deployable: true });
  });

  test('without a required variable it exits with an error, and compose does not report it healthy', () => {
    const name = 'wl-embedded-wallet-e2e-no-variable';
    removeContainers(name);
    const { MASTER_KEY: _missing, NEXT_DIST_DIR: _dist, ...env } = vaultEnv('', {});
    const result = dockerStatus('run', '--name', name, '--label', CONTAINER_LABEL, ...RESTRICTIONS, ...envFlags({ ...env, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/v' }), IMAGE);
    try {
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('MASTER_KEY');
      const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name)) as { Running: boolean; ExitCode: number; Health?: { Status: string } };
      expect(state.Running).toBe(false);
      expect(state.ExitCode).not.toBe(0);
      expect(state.Health?.Status).not.toBe('healthy');
    } finally {
      removeContainers(name);
    }

    // Variable present but invalid, which compose does not detect when interpolating: `--wait` must fail.
    const project = 'wl-embedded-wallet-e2e-invalid';
    const badEnv = { ...composeEnv(vaultEnv('', {})), MASTER_KEY: 'not-a-key', VAULT_PORT: '4305' };
    const composeArgs = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yaml', '-f', 'e2e/compose.image.yaml'];
    const run = (...args: string[]) => execFileSync('docker', [...composeArgs, ...args], { cwd: ROOT, env: badEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      expect(() => run('up', '--detach', '--wait', '--wait-timeout', '45', '--no-build', 'vault')).toThrow();
      expect(run('logs', '--no-color', 'vault')).toContain('MASTER_KEY');
      expect(run('logs', '--no-color', 'vault')).not.toContain('not-a-key');
    } finally {
      run('down', '--volumes', '--remove-orphans');
    }
  });

  test('if Postgres goes down, Docker reports it unhealthy and it recovers when it comes back', async () => {
    const database = 'wl-embedded-wallet-e2e-temp-pg';
    const vault = 'wl-embedded-wallet-e2e-health';
    removeContainers(database, vault);
    try {
      docker(
        'run', '--detach', '--name', database, '--label', CONTAINER_LABEL, '--network', NETWORK, '--network-alias', 'pg-temporary',
        '-e', 'POSTGRES_USER=vault', '-e', 'POSTGRES_DB=vault', '-e', 'POSTGRES_PASSWORD=temporary', '--tmpfs', '/var/lib/postgresql/data', 'postgres:17.6-alpine',
      );
      await expect.poll(() => dockerStatus('exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'vault', '-d', 'vault').status, { timeout: HEALTH_TIMEOUT_MS, intervals: [500] }).toBe(0);

      runContainer(vault, replicaEnv('vault', { DATABASE_URL: 'postgres://vault:temporary@pg-temporary:5432/vault', ORIGIN: 'http://vault.localhost:4305' }), ['--health-interval=1s', '--health-timeout=4s', '--health-retries=2', '--health-start-period=1s']);
      await waitHealth(vault, 'healthy');
      const url = `http://127.0.0.1:${publishedPort(vault)}/api/health`;
      expect((await fetch(url)).status).toBe(200);

      // The network is cut: with tmpfs, stopping Postgres would erase its data.
      docker('network', 'disconnect', NETWORK, database);
      await waitHealth(vault, 'unhealthy');
      expect(docker('inspect', '--format', '{{.State.Running}}', vault)).toBe('true');
      const unavailable = await fetch(url);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.text()).not.toContain('temporary');

      docker('network', 'connect', '--alias', 'pg-temporary', NETWORK, database);
      await waitHealth(vault, 'healthy');
    } finally {
      removeContainers(database, vault);
    }
  });

  test('after restarting Postgres and recreating the vault, the user keeps their wallet and signs', async ({ h }) => {
    const email = await h.register();
    const account = await h.activate(email);
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    const env = mainEnv();
    compose(env, 'restart', 'postgres');
    compose(env, 'up', '--detach', '--wait', '--wait-timeout', '120', '--force-recreate', '--no-deps', '--no-build', 'vault');

    await h.app.reload();
    await expect(h.T('wallet-address')).toHaveText(account.safe);
    await expect(h.T('activate-button')).toHaveCount(0);
    await h.selectChain(CHAIN_A, 'true');
    const signed = await h.signFromForm('sign-message-submit', 'message');
    expect(signed).toMatchObject({ valid: 'true', erc1271: 'true' });
  });
});

test.describe('J · multiple replicas', () => {
  const R1 = 'wl-embedded-wallet-e2e-replica-1';
  const R2 = 'wl-embedded-wallet-e2e-replica-2';
  const WRONG_KEY = 'wl-embedded-wallet-e2e-other-key';
  const DATABASE = 'vault_replicas';
  const OTHER_MASTER_KEY = 'ef'.repeat(32);
  let proxy: SwitchProxy;
  let r1: number;
  let r2: number;
  let wrong: number;

  test.beforeAll(async () => {
    removeContainers(R1, R2, WRONG_KEY);
    docker('exec', POSTGRES_NAME, 'createdb', '-U', 'vault', DATABASE);
    // Both at once on an empty database: the migrations really compete.
    runContainer(R1, replicaEnv(DATABASE));
    runContainer(R2, replicaEnv(DATABASE));
    runContainer(WRONG_KEY, replicaEnv(DATABASE, { MASTER_KEY: OTHER_MASTER_KEY }));
    await Promise.all([waitHealth(R1, 'healthy'), waitHealth(R2, 'healthy'), waitHealth(WRONG_KEY, 'healthy')]);
    [r1, r2, wrong] = [R1, R2, WRONG_KEY].map(publishedPort);
    proxy = new SwitchProxy(REPLICA_PORT);
  });

  test.afterAll(() => {
    proxy?.close();
    removeContainers(R1, R2, WRONG_KEY);
    dockerStatus('exec', POSTGRES_NAME, 'dropdb', '-U', 'vault', DATABASE);
  });

  test('a wallet created and deployed on one replica signs on the other', async ({ h }) => {
    proxy.use(r1);
    const { safe } = await activateOn(h, REPLICA_ORIGIN);

    const deploying = h.direct('deploy', { kind: 'deploy', chain: { chainId: CHAIN_A } }, CHAIN_A, REPLICA_ORIGIN);
    await h.P('deploy-approve').click();
    expect(await deploying).toMatchObject({ ok: true, address: safe });

    proxy.use(r2);
    const firstOnR2 = proxy.hits.get(r2) ?? 0;
    const message = 'signed on another replica';
    const signing = h.direct('sign', { kind: 'sign', chain: { chainId: CHAIN_A }, request: { kind: 'message', message } }, CHAIN_A, REPLICA_ORIGIN);
    await h.P('sign-approve').click();
    const signed = await signing;
    expect(signed).toMatchObject({ ok: true, address: safe });
    expect(await erc1271(CHAIN_A, safe, message, signed.signature as `0x${string}`)).toBe(ERC1271_MAGIC);

    expect(proxy.hits.get(r1)).toBeGreaterThan(0);
    expect(proxy.hits.get(r2)).toBeGreaterThan(firstOnR2);
    for (const replica of [R1, R2]) expect(health(replica)).toBe('healthy');

    // A single-use token spent on one replica is not valid on the other.
    const token = await h.app.evaluate(async () => ((await (await fetch('/api/vault/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { token: string }).token);
    const handoff = (port: number) =>
      fetch(`http://127.0.0.1:${port}/api/auth/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: REPLICA_ORIGIN }, body: JSON.stringify({ token, origin: APP }) }).then((response) => response.status);
    expect(await handoff(r1)).toBe(200);
    expect(await handoff(r2)).toBe(401);
  });

  test('with another MASTER_KEY it does not deliver share A, the failure is clear, and the correct key keeps working', async ({ h }) => {
    proxy.use(r1);
    const { safe } = await activateOn(h, REPLICA_ORIGIN);

    h.tolerate(/500/);
    proxy.use(wrong);
    // This operation does not end with a result: the popup shows the error and allows retrying.
    void h.direct('unlock', { kind: 'unlock' }, undefined, REPLICA_ORIGIN).catch(() => undefined);
    await h.P('unlock-start').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'SERVER_KEY_MISMATCH');
    await expect(h.P('flow-error')).toContainText('key');
    await expect(h.P('wallet-address')).toHaveCount(0);

    const { stdout, stderr } = dockerStatus('logs', WRONG_KEY);
    expect(stdout + stderr).toContain('MASTER_KEY');
    expect(stdout + stderr).not.toContain(OTHER_MASTER_KEY);

    proxy.use(r1);
    const unlocking = h.direct('unlock', { kind: 'unlock' }, undefined, REPLICA_ORIGIN);
    // The error page also has this button: wait for the new one to replace it.
    await expect(h.P('flow-error')).toHaveCount(0);
    await h.P('unlock-start').click();
    expect(await unlocking).toMatchObject({ ok: true, address: safe });
  });
});

