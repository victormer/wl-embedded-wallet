import { predictSafeAddress } from '../src/safe';
import { describe, expect, it } from 'vitest';
import { WalletError } from '../src/errors';
import { recoverFromKit } from '../src/offline';
import { CODE, flipBit, makeKit, OTHER_CODE } from './fixtures';

const failure = (run: () => Promise<unknown>) => run().then(() => 'no error', (error: WalletError) => error.code);

describe('recover with kit and code', () => {
  it('returns the seed, and the owner and Safe match the kit', async () => {
    const { kit, mnemonic, owner } = await makeKit();
    const result = await recoverFromKit(JSON.stringify(kit), `${CODE.slice(0, 4)}-${CODE.slice(4).toLowerCase()}`);
    expect(result).toMatchObject({ ok: true, mnemonic, ownerMatches: true, safeMatches: true, derivedOwner: owner });
    expect(result.derivedSafe).toBe(predictSafeAddress(owner, kit.manifest.smartAccount));
  });

  it('wrong code or wrong format', async () => {
    const { kit } = await makeKit();
    expect(await failure(() => recoverFromKit(JSON.stringify(kit), OTHER_CODE))).toBe('DECRYPT_FAILED');
    expect(await failure(() => recoverFromKit(JSON.stringify(kit), 'ABC'))).toBe('BAD_RECOVERY_CODE');
  });

  it('tampered kit', async () => {
    const { kit } = await makeKit();
    const backup = kit.seedBackup!;
    expect(await failure(() => recoverFromKit(JSON.stringify({ ...kit, seedBackup: { ...backup, ct: flipBit(backup.ct) } }), CODE))).toBe('DECRYPT_FAILED');
    // The owner is in the AAD: changing it in the manifest breaks decryption.
    const other = await makeKit();
    expect(await failure(() => recoverFromKit(JSON.stringify({ ...kit, manifest: { ...kit.manifest, expectedAddress: other.owner } }), CODE))).toBe('DECRYPT_FAILED');
    expect(await failure(() => recoverFromKit('{"v":2}', CODE))).toBe('INVALID_KIT');
    expect(await failure(() => recoverFromKit('not json', CODE))).toBe('INVALID_KIT');
    expect(await failure(() => recoverFromKit(JSON.stringify({ ...kit, manifest: { ...kit.manifest, derivationPath: "m/44'/60'/0'/0/1" } }), CODE))).toBe('FORMAT_UNSUPPORTED');
  });

  it('another user\'s kit with my code', async () => {
    const mine = await makeKit();
    const theirs = await makeKit({ code: OTHER_CODE });
    expect(await failure(() => recoverFromKit(JSON.stringify(theirs.kit), CODE))).toBe('DECRYPT_FAILED');
    // Their backup in my kit: the AAD carries a different owner.
    expect(await failure(() => recoverFromKit(JSON.stringify({ ...mine.kit, seedBackup: theirs.kit.seedBackup }), OTHER_CODE))).toBe('DECRYPT_FAILED');
  });

  it('an old kit says so clearly', async () => {
    const { kit } = await makeKit();
    const { seedBackup: _backup, ...old } = kit;
    const code = await failure(() => recoverFromKit(JSON.stringify({ ...old, v: 1 }), CODE));
    expect(code).toBe('NO_SEED_BACKUP');
  });

  it('if the seed is not the owner\'s, says so and does not return it', async () => {
    const { mnemonic: foreign } = await makeKit();
    const { kit, owner } = await makeKit({ backupOf: foreign });
    const result = await recoverFromKit(JSON.stringify(kit), CODE);
    expect(result).toMatchObject({ ok: false, ownerMatches: false, safeMatches: false, expectedOwner: owner });
    expect(JSON.stringify(result)).not.toContain(foreign);
    expect('mnemonic' in result).toBe(false);
  });

  it('if the kit\'s Safe does not derive from the owner, says so and does not return the seed', async () => {
    const { kit, mnemonic } = await makeKit();
    const other = await makeKit();
    const altered = { ...kit, manifest: { ...kit.manifest, smartAccount: { ...kit.manifest.smartAccount, address: other.kit.manifest.smartAccount.address } } };
    const result = await recoverFromKit(JSON.stringify(altered), CODE);
    expect(result).toMatchObject({ ok: false, ownerMatches: true, safeMatches: false });
    expect(JSON.stringify(result)).not.toContain(mnemonic);
    // Invalid Safe parameters: not returned either.
    const broken = { ...kit, manifest: { ...kit.manifest, smartAccount: { ...kit.manifest.smartAccount, factory: 'not an address' } } };
    expect(await recoverFromKit(JSON.stringify(broken), CODE)).toMatchObject({ ok: false, safeMatches: false, derivedSafe: null });
  });
});
