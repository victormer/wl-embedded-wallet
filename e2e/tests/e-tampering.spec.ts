import { signManifest } from '../../packages/core/src/manifest.ts';
import { MANIFEST_SIGNING_KEY, VAULT } from '../support/env.ts';
import { expect, test, type Harness, type Kit } from '../support/harness.ts';

function flipB64(value: string): string {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

function flipHex(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
}

const clone = (kit: Kit): Kit => structuredClone(kit);

/** Uploads the kit and checks that it aborts with that code, without any address. */
async function expectAbort(h: Harness, kit: unknown, code: string, expected: string): Promise<void> {
  await h.popup.goto(`${VAULT}/recover`);
  await h.recoverWithKit(kit, code);
  await h.P('recover-bc-submit').click();
  await expect(h.P('flow-error'), `expected ${expected}`).toHaveAttribute('data-code', expected);
  await expect(h.P('done-panel')).toHaveCount(0);
  await expect(h.P('wallet-address')).toHaveCount(0);
}

async function expectRecovers(h: Harness, kit: unknown, code: string, address: string): Promise<void> {
  await h.popup.goto(`${VAULT}/recover`);
  await h.recoverWithKit(kit, code);
  await h.P('recover-bc-submit').click();
  await expect(h.P('done-panel')).toBeVisible();
  await expect(h.P('wallet-address')).toHaveText(address);
}

test.describe('E · tampering', () => {
  test('tampered or foreign kit: aborts without returning any address', async ({ h }) => {
    const first = await h.activate(await h.register());
    await h.logout();
    const second = await h.activate(await h.register());
    await h.openStandaloneRecover();

    // Controls: untampered, each kit recovers its wallet. So the failures below are caused by the tampering.
    await expectRecovers(h, first.kit, first.recovery, first.safe);
    await expectRecovers(h, second.kit, second.recovery, second.safe);

    const mutate = (change: (kit: Kit) => void): Kit => {
      const kit = clone(first.kit);
      change(kit);
      return kit;
    };
    const { recovery } = first;

    const altered: [string, Kit, string][] = [
      ['B ct', mutate((kit) => void (kit.encB.ct = flipB64(kit.encB.ct))), 'DECRYPT_FAILED'],
      ['B iv', mutate((kit) => void (kit.encB.iv = flipB64(kit.encB.iv))), 'DECRYPT_FAILED'],
      ['B salt', mutate((kit) => void (kit.encB.salt = flipB64(kit.encB.salt))), 'DECRYPT_FAILED'],
      ['C ct', mutate((kit) => void (kit.encC.ct = flipB64(kit.encC.ct))), 'DECRYPT_FAILED'],
      ['C iv', mutate((kit) => void (kit.encC.iv = flipB64(kit.encC.iv))), 'DECRYPT_FAILED'],
      ['C salt', mutate((kit) => void (kit.encC.salt = flipB64(kit.encC.salt))), 'DECRYPT_FAILED'],
      ['manifest digest', mutate((kit) => void (kit.manifest.shareDigests.B = flipHex(kit.manifest.shareDigests.B))), 'MANIFEST_INVALID'],
      ['manifest signature', mutate((kit) => void (kit.signature = flipB64(kit.signature))), 'MANIFEST_INVALID'],
      ['manifest address', mutate((kit) => void (kit.manifest.expectedAddress = second.owner)), 'MANIFEST_INVALID'],
      ['manifest Safe', mutate((kit) => void (kit.manifest.smartAccount.address = second.safe)), 'MANIFEST_INVALID'],
    ];
    for (const [name, kit, expected] of altered) {
      await test.step(name, () => expectAbort(h, kit, recovery, expected));
    }

    // With the manifest key compromised the signature passes, and each later check still stops it.
    const resigned = (change: (kit: Kit) => void): Kit => {
      const kit = mutate(change);
      kit.signature = signManifest(kit.manifest, MANIFEST_SIGNING_KEY).signature;
      return kit;
    };
    await test.step('valid signature with a tampered digest', () =>
      expectAbort(h, resigned((kit) => void (kit.manifest.shareDigests.C = flipHex(kit.manifest.shareDigests.C))), recovery, 'SHARE_TAMPERED'));
    await test.step("valid signature with another user's owner", () =>
      expectAbort(h, resigned((kit) => void (kit.manifest.expectedAddress = second.owner)), recovery, 'ADDRESS_MISMATCH'));
    await test.step("valid signature with another user's Safe", () =>
      expectAbort(h, resigned((kit) => void (kit.manifest.smartAccount.address = second.safe)), recovery, 'ADDRESS_MISMATCH'));

    await test.step("another user's kit with my code", () => expectAbort(h, second.kit, recovery, 'DECRYPT_FAILED'));
    await test.step("my manifest with another user's share B", () => expectAbort(h, mutate((kit) => void (kit.encB = second.kit.encB)), recovery, 'DECRYPT_FAILED'));
    await test.step("my manifest with another user's share C", () => expectAbort(h, mutate((kit) => void (kit.encC = second.kit.encC)), second.recovery, 'DECRYPT_FAILED'));
    await test.step('B and C swapped', () => expectInvalidKit(h, mutate((kit) => void ([kit.encB, kit.encC] = [kit.encC, kit.encB]))));

    await test.step('wrong code with a valid format', () => expectAbort(h, first.kit, second.recovery, 'DECRYPT_FAILED'));
    await expect(h.P('flow-error')).toContainText('Incorrect code or tampered kit');
    await test.step('code with an invalid format', () => expectAbort(h, first.kit, 'ABC', 'BAD_RECOVERY_CODE'));

    await test.step('Argon2id with abusive parameters in the envelope', () =>
      expectAbort(h, mutate((kit) => void (kit.encC.kdfParams = { ...kit.encC.kdfParams, memorySize: 4_000_000 })), recovery, 'KDF_PARAMS_INVALID'));
    await test.step('Argon2id with weaker parameters in the envelope', () =>
      expectAbort(h, mutate((kit) => void (kit.encC.kdfParams = { ...kit.encC.kdfParams, iterations: 1 })), recovery, 'DECRYPT_FAILED'));

    await test.step('file that is not a kit', () => expectInvalidKit(h, '{"v":1}'));
    await test.step('kit from another domain', async () => {
      await h.popup.goto(`${VAULT}/recover`);
      await h.recoverWithKit(mutate((kit) => void (kit.rpId = 'other.example')), recovery);
      await expect(h.P('flow-error')).toHaveAttribute('data-code', 'WRONG_RP');
      await expect(h.P('recover-bc-submit')).toBeDisabled();
    });
  });

  test('A+C with tampered server data: aborts before reconstructing', async ({ h }) => {
    const account = await h.activate(await h.register());

    // A failure leaves the operation open in the popup. Reloading it repeats it with fresh data from the server.
    await h.T('recover-button').click();
    const attempt = async (expected: string) => {
      await h.popup.reload();
      await h.P('recovery-code-input').fill(account.recovery);
      await h.P('recover-ac-submit').click();
      await expect(h.P('flow-error'), `expected ${expected}`).toHaveAttribute('data-code', expected);
      await expect(h.P('recover-ac-result')).toHaveCount(0);
      await expect(h.P('wallet-address')).toHaveCount(0);
    };
    const alterShares = (change: (set: Record<string, any>) => void) =>
      h.context.route('**/api/shares', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        change(body);
        await route.fulfill({ response, json: body });
      });

    await alterShares((set) => void (set.signature = flipB64(set.signature)));
    await attempt('MANIFEST_INVALID');
    await h.context.unroute('**/api/shares');

    await alterShares((set) => void (set.encC.ct = flipB64(set.encC.ct)));
    await attempt('DECRYPT_FAILED');
    await h.context.unroute('**/api/shares');

    // A server that returns a well-formed share A that is not the signed one. The worker requests it.
    let intercepted = 0;
    await h.context.route('**/api/shares/a?*', async (route) => {
      intercepted += 1;
      await route.fulfill({ json: { shareA: account.shares.B } });
    });
    await attempt('SHARE_TAMPERED');
    expect(intercepted, "the route must intercept the worker's request").toBeGreaterThan(0);
    await h.context.unroute('**/api/shares/a?*');

    // Control: untampered, it works.
    await h.popup.reload();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await expect(h.P('recover-ac-result')).toBeVisible();
  });
});

async function expectInvalidKit(h: Harness, kit: unknown): Promise<void> {
  await h.popup.goto(`${VAULT}/recover`);
  await h.recoverWithKit(kit, 'XXXX');
  await expect(h.P('flow-error')).toHaveAttribute('data-code', 'INVALID_KIT');
  await expect(h.P('recover-bc-submit')).toBeDisabled();
}
