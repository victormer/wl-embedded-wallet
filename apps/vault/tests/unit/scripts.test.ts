import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHandoffToken, handoffPublicJwk } from '@wl-embedded-wallet/sdk/server';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hexDecode } from '@wl-embedded-wallet/core/encoding';
import { validateConfig } from '../../server/config';

const SETUP = resolve('../../scripts/setup-env.mjs');
const GENERATE = resolve('../../scripts/generate-secrets.mjs');

function parseEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8').trim().split('\n').map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
}

describe('setup:env', () => {
  let root: string;
  const run = (...args: string[]) => execFileSync('node', [SETUP, '--root', root, ...args], { encoding: 'utf8', stdio: 'pipe' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wl-embedded-wallet-env-'));
    mkdirSync(join(root, 'apps/vault'), { recursive: true });
    mkdirSync(join(root, 'examples/demo'), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('generates consistent keys for the vault and the demo, without printing secrets or overwriting existing values', async () => {
    const output = run();
    const vaultPath = join(root, 'apps/vault/.env.local');
    const demoPath = join(root, 'examples/demo/.env.local');
    expect(statSync(vaultPath).mode & 0o777).toBe(0o600);
    expect(statSync(demoPath).mode & 0o777).toBe(0o600);
    const vault = parseEnv(vaultPath);
    const demo = parseEnv(demoPath);

    expect(hexDecode(vault.MASTER_KEY)).toHaveLength(32);
    expect(hexDecode(vault.MANIFEST_SIGNING_KEY)).toHaveLength(32);
    expect(Object.keys(vault).filter((name) => name.startsWith('NEXT_PUBLIC_'))).toEqual([]);
    expect(validateConfig({ ...vault, NODE_ENV: 'development' }, false)).toEqual([]);
    expect(vault.VAULT_SERVICE_TOKEN).toBe(demo.VAULT_SERVICE_TOKEN);
    expect(vault.RP_ID).toBe('vault.localhost');
    expect(vault.ORIGIN).toBe(demo.VAULT_ORIGIN);
    // No fixed list: the domain is authorized by the signed `origin`.
    expect(vault.ALLOWED_APP_ORIGINS).toBeUndefined();
    expect(vault.DATABASE_URL).toBe('sqlite:data/vault.db');
    expect(demo.DB_PATH).toBe('data/demo.db');
    // In development, the project's brand, relative to apps/vault.
    expect(vault.VAULT_BRAND_DIR).toBe('../../brands/wl');

    // No vault secret reaches the demo, nor the other way around.
    expect(demo.MASTER_KEY).toBeUndefined();
    expect(demo.MANIFEST_SIGNING_KEY).toBeUndefined();
    expect(vault.DEMO_HANDOFF_PRIVATE_KEY).toBeUndefined();

    expect(vault.HANDOFF_JWKS_URL).toBe(`${demo.ORIGIN}/.well-known/jwks.json`);
    expect(vault.HANDOFF_ISSUER).toBe(demo.ORIGIN);
    expect(vault.HANDOFF_AUDIENCE).toBe(vault.ORIGIN);
    expect(vault.HANDOFF_PUBLIC_KEY).toBeUndefined();

    const token = createHandoffToken(
      { sub: 'user-1', label: 'a@b.c', iss: vault.HANDOFF_ISSUER, aud: vault.HANDOFF_AUDIENCE, origin: demo.ORIGIN, kid: demo.DEMO_HANDOFF_KID },
      demo.DEMO_HANDOFF_PRIVATE_KEY,
    );
    const jwks = createLocalJWKSet({ keys: [handoffPublicJwk(demo.DEMO_HANDOFF_PRIVATE_KEY, demo.DEMO_HANDOFF_KID)] });
    const verified = await jwtVerify(token, jwks, { issuer: vault.HANDOFF_ISSUER, audience: vault.HANDOFF_AUDIENCE });
    expect(verified.payload.sub).toBe('user-1');

    for (const secret of [vault.MASTER_KEY, vault.MANIFEST_SIGNING_KEY, demo.DEMO_HANDOFF_PRIVATE_KEY, vault.VAULT_SERVICE_TOKEN]) {
      expect(output).not.toContain(secret);
    }

    // Another run touches nothing: it is already up to date.
    const before = readFileSync(vaultPath, 'utf8');
    const demoBefore = readFileSync(demoPath, 'utf8');
    expect(run()).toContain('up to date');
    expect(readFileSync(vaultPath, 'utf8')).toBe(before);
    expect(readFileSync(demoPath, 'utf8')).toBe(demoBefore);

    // An older environment only receives what it is missing, without regenerating any key.
    const oldVault = before.split('\n').filter((line) => !/^HANDOFF_(JWKS_URL|ISSUER|AUDIENCE)=/.test(line));
    oldVault.unshift('HANDOFF_PUBLIC_KEY=ab');
    writeFileSync(vaultPath, oldVault.join('\n'));
    writeFileSync(demoPath, demoBefore.split('\n').filter((line) => !/^DEMO_HANDOFF_KID=/.test(line)).join('\n'));
    const upgraded = run();
    expect(upgraded).toContain('DEMO_HANDOFF_KID');
    const after = parseEnv(vaultPath);
    const demoAfter = parseEnv(demoPath);
    expect(after).toEqual(vault);
    expect(demoAfter.DEMO_HANDOFF_PRIVATE_KEY).toBe(demo.DEMO_HANDOFF_PRIVATE_KEY);
    expect(demoAfter.DEMO_HANDOFF_KID).toBe(demo.DEMO_HANDOFF_KID);

    run('--force');
    expect(readFileSync(vaultPath, 'utf8')).not.toBe(before);
  });
});

describe('generate-secrets', () => {
  const namesIn = (text: string) => text.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.slice(0, line.indexOf('=')));

  it('labels the handoff variables with the names the SDK example and the bundled demo actually read', () => {
    const result = spawnSync('node', [GENERATE], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(namesIn(result.stdout)).toEqual(['MASTER_KEY', 'MANIFEST_SIGNING_KEY', 'VAULT_SERVICE_TOKEN', 'POSTGRES_PASSWORD']);
    const handoffNames = namesIn(result.stderr).filter((name) => name !== 'VAULT_SERVICE_TOKEN');
    expect(handoffNames).toEqual(['VAULT_HANDOFF_PRIVATE_KEY', 'VAULT_HANDOFF_KID']);
    const key = result.stderr.split('\n').find((line) => line.startsWith('VAULT_HANDOFF_PRIVATE_KEY='))?.split('=')[1] ?? '';
    expect(hexDecode(key)).toHaveLength(32);
    expect(result.stdout).not.toContain(key);

    // The names printed are read by the integrator example, and the demo's own names are listed next to them.
    const example = readFileSync(resolve('../../packages/sdk/examples/mint-token.ts'), 'utf8');
    for (const name of handoffNames) expect(example).toContain(`${name}:`);
    const demo = readFileSync(resolve('../../examples/demo/server/handoff.ts'), 'utf8');
    for (const name of ['DEMO_HANDOFF_PRIVATE_KEY', 'DEMO_HANDOFF_KID']) {
      expect(demo).toContain(`${name}:`);
      expect(result.stderr).toMatch(new RegExp(`^#.*\\b${name}\\b`, 'm'));
    }
  });
});

describe('vercel-aa-chains', () => {
  const example = readFileSync(resolve(__dirname, '../../../../deploy/vercel/aa-chains.example.json'), 'utf8');
  const filled = example.replaceAll('<PIMLICO_API_KEY>', 'pim_test').replaceAll('<SPONSORSHIP_POLICY_ID>', 'sp_test');

  it('the example, once filled in, passes the script and the vault’s own validation', async () => {
    const { summarize } = await import('../../../../scripts/vercel-aa-chains.mjs');
    expect(summarize(filled).problems).toEqual([]);
    expect(summarize(example).problems).toEqual(['still has a <PLACEHOLDER> from the example']);
    const issues = validateConfig({ AA_CHAINS: JSON.stringify(JSON.parse(filled)) }, true).filter((issue) => issue.variable.startsWith('AA_CHAINS'));
    expect(issues).toEqual([]);
  });

  it('reports a JSON error by line and column, without quoting the input', async () => {
    const { summarize } = await import('../../../../scripts/vercel-aa-chains.mjs');
    const broken = '{\n  "1": {\n    "bundlerUrl": "https://bundler.example/rpc?apikey=SECRET-VALUE"\n    "sponsorTransactions": true\n  }\n}';
    const { problems } = summarize(broken);
    expect(problems).toEqual([expect.stringMatching(/^not valid JSON at line 4, column \d+$/)]);
    expect(problems.join(' ')).not.toContain('SECRET');
  });
});
