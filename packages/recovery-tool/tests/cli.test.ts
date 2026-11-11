import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CODE, flipBit, makeKit, OTHER_CODE } from '../../core/tests/fixtures';

const CLI = resolve(import.meta.dirname, '../dist/wl-embedded-wallet-recovery.mjs');
const NO_NETWORK = resolve(import.meta.dirname, 'no-network.mjs');
const dir = mkdtempSync(join(tmpdir(), 'wl-embedded-wallet-recovery-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(kit: unknown, options: { code?: string; flags?: string[] } = {}) {
  const path = join(dir, `${crypto.randomUUID()}.json`);
  writeFileSync(path, typeof kit === 'string' ? kit : JSON.stringify(kit));
  return spawnSync(process.execPath, ['--import', NO_NETWORK, CLI, path, '--code-stdin', ...(options.flags ?? [])], { input: `${options.code ?? CODE}\n`, encoding: 'utf8' });
}

describe('CLI', () => {
  it('without --show-seed checks owner and Safe and does not show the seed', async () => {
    const { kit, mnemonic, owner } = await makeKit();
    const result = run(kit);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Owner: ${owner} (matches the kit)`);
    expect(result.stdout).toContain(`Safe: ${kit.manifest.smartAccount.address} (matches the kit)`);
    expect(result.stdout + result.stderr).not.toContain(mnemonic);
    expect(result.stderr).toContain('--show-seed');
  });

  it('with --show-seed shows the seed, on stdout', async () => {
    const { kit, mnemonic } = await makeKit();
    const result = run(kit, { flags: ['--show-seed'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Seed: ${mnemonic}`);
    expect(result.stderr).not.toContain(mnemonic);
  });

  it('wrong code and tampered kit: exits with an error and no data', async () => {
    const { kit, mnemonic } = await makeKit();
    const wrong = run(kit, { code: OTHER_CODE, flags: ['--show-seed'] });
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('Incorrect code or tampered kit');
    expect(wrong.stdout).toBe('');
    const altered = run({ ...kit, seedBackup: { ...kit.seedBackup, ct: flipBit(kit.seedBackup!.ct) } }, { flags: ['--show-seed'] });
    expect(altered.status).toBe(2);
    expect(altered.stdout + altered.stderr).not.toContain(mnemonic);
    expect(run('not a kit').status).toBe(2);
  });

  it('on a mismatch, says so clearly and does not show the seed even if asked', async () => {
    const { kit, mnemonic } = await makeKit();
    const other = await makeKit();
    const altered = { ...kit, manifest: { ...kit.manifest, smartAccount: { ...kit.manifest.smartAccount, address: other.kit.manifest.smartAccount.address } } };
    const result = run(altered, { flags: ['--show-seed'] });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('MISMATCH');
    expect(result.stderr).toContain('MISMATCH');
    expect(result.stdout + result.stderr).not.toContain(mnemonic);
  });

  it('an old kit says so clearly', async () => {
    const { kit } = await makeKit();
    const { seedBackup: _backup, ...old } = kit;
    const result = run({ ...old, v: 1 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('kit is old');
  });

  it('accepts neither the code as an argument nor unknown options', async () => {
    const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8', input: '' });
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain('Usage:');
    const { kit } = await makeKit();
    expect(run(kit, { flags: ['--code=ABC'] }).status).toBe(1);
  });

  it('does not use the network: the detector works, and the bundle loads no network module', () => {
    const canary = join(dir, 'canary.mjs');
    writeFileSync(canary, "await fetch('https://example.com');\n");
    const detected = spawnSync(process.execPath, ['--import', NO_NETWORK, canary], { encoding: 'utf8' });
    expect(detected.status).toBe(99);
    expect(detected.stderr).toContain('NETWORK-USED:fetch');

    const bundle = readFileSync(CLI, 'utf8');
    expect(bundle).not.toMatch(/node:(net|http|https|http2|tls|dns|dgram)\b/);
    expect(bundle).not.toMatch(/from\s*"(net|http|https|http2|tls|dns|dgram)"/);
    expect(bundle).not.toMatch(/\bfetch\(/);
  });
});
