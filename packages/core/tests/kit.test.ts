import { describe, expect, it } from 'vitest';
import { buildKit, parseKit } from '../src/kit';
import { makeKit } from './fixtures';

describe('kit versions', () => {
  it('a new kit is v2 and contains the backup', async () => {
    const { kit } = await makeKit();
    expect(kit.v).toBe(2);
    expect(parseKit(JSON.stringify(kit))).toEqual(kit);
  });

  it('still reads old kits, without a backup', async () => {
    const { kit } = await makeKit();
    const { seedBackup: _backup, ...old } = kit;
    const parsed = parseKit(JSON.stringify({ ...old, v: 1 }));
    expect(parsed?.v).toBe(1);
    expect(parsed?.seedBackup).toBeUndefined();
  });

  it('without a backup, buildKit does not fake a v2 kit', async () => {
    const { kit } = await makeKit();
    const old = buildKit({ rpId: kit.rpId, credentialId: kit.credentialId, encB: kit.encB, encC: kit.encC, signed: { manifest: kit.manifest, signature: kit.signature } });
    expect(old.v).toBe(1);
    expect('seedBackup' in old).toBe(false);
  });

  it('is strict: v2 without a backup, v1 with a backup, invalid backup or unknown version', async () => {
    const { kit } = await makeKit();
    const { seedBackup, ...withoutBackup } = kit;
    expect(parseKit(JSON.stringify({ ...withoutBackup, v: 2 }))).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, v: 1 }))).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, v: 3 }))).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, seedBackup: { ...seedBackup, extra: true } }))).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, seedBackup: 'text' }))).toBeNull();
    expect(parseKit('{')).toBeNull();
  });
});
