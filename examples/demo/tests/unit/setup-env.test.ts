import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SETUP = resolve('../../scripts/setup-env.mjs');
const NAME = 'DEMO_TOTP_KEY';

describe('setup:env and the demo 2FA key', () => {
  let root: string;
  const run = () => execFileSync('node', [SETUP, '--root', root], { encoding: 'utf8' });
  const read = () => readFileSync(join(root, 'examples/demo/.env.local'), 'utf8');
  const value = (text: string) => text.split('\n').find((line) => line.startsWith(`${NAME}=`))?.slice(NAME.length + 1) ?? '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-env-'));
    mkdirSync(join(root, 'apps/vault'), { recursive: true });
    mkdirSync(join(root, 'examples/demo'), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('generates it, keeps it, and adds it to an older environment without touching the rest or printing it', () => {
    run();
    const original = read();
    const key = value(original);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    run();
    expect(read()).toBe(original);

    const previous = original.split('\n').filter((line) => !line.startsWith(`${NAME}=`)).join('\n');
    writeFileSync(join(root, 'examples/demo/.env.local'), previous);
    const output = run();
    expect(output).toContain(NAME);
    const upgraded = read();
    expect(value(upgraded)).toMatch(/^[0-9a-f]{64}$/);
    expect(output).not.toContain(value(upgraded));
    expect(upgraded.split('\n').find((line) => line.startsWith('DEMO_HANDOFF_PRIVATE_KEY='))).toBe(original.split('\n').find((line) => line.startsWith('DEMO_HANDOFF_PRIVATE_KEY=')));
  });
});
