import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openStore } from '../../server/store';
import { storeContract } from '../store/contract';

const dir = mkdtempSync(join(tmpdir(), 'vault-store-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

storeContract('SQLite', async () => `sqlite:${join(dir, `${crypto.randomUUID()}.db`)}`);

describe('SQLite file', () => {
  it('creates the file and its directories with 600 permissions', async () => {
    const path = join(dir, 'nested', 'vault.db');
    const store = await openStore(`sqlite:${path}`);
    await store.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
