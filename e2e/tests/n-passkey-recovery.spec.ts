import { APP, RP_ID } from '../support/env.ts';
import { expect, test, type Harness } from '../support/harness.ts';

/** The state of someone who has lost their login: no cookies, no kit and no app. */
async function openPasskeyTab(h: Harness): Promise<void> {
  await h.context.clearCookies();
  await h.openStandaloneRecover();
  await h.P('recover-tab-passkey').click();
  await h.P('recover-passkey').waitFor();
  await expect(h.P('passkey-recovery-limit')).toContainText('cannot use this option until they re-enroll');
}

/** Counts passkey reads and records their options. */
async function spyOnPasskey(h: Harness): Promise<void> {
  await h.popup.evaluate(() => {
    const original = navigator.credentials.get.bind(navigator.credentials);
    const calls: { allowCredentials?: unknown; userVerification?: string; rpId?: string }[] = [];
    (window as unknown as { __passkeyCalls: typeof calls }).__passkeyCalls = calls;
    navigator.credentials.get = (options) => {
      const { allowCredentials, userVerification, rpId } = options?.publicKey ?? {};
      calls.push({ allowCredentials, userVerification, rpId });
      return original(options);
    };
  });
}

const passkeyCalls = (h: Harness) => h.popup.evaluate(() => (window as unknown as { __passkeyCalls: { allowCredentials?: unknown; userVerification?: string; rpId?: string }[] }).__passkeyCalls);

test.describe('N · recover without a kit, with a resident passkey and code', () => {
  test('a single discoverable assertion: no JWT and no kit, never share A, no session and the PRF never leaves', async ({ h }) => {
    h.captureResponseBodies();
    const account = await h.activate(await h.register());
    const prf = await h.readPrf(account.kit.credentialId);
    const prfHex = Buffer.from(prf).toString('hex');
    const prfB64 = Buffer.from(prf).toString('base64url');
    h.registerSecret(prfHex);
    h.registerSecret(prfB64);

    // Before opening the tab: the challenge is requested on load, because the passkey call must happen within the user gesture.
    const from = h.traffic.length;
    await openPasskeyTab(h);
    await spyOnPasskey(h);
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-passkey-submit').click();
    await h.P('done-panel').waitFor();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
    await expect(h.P('wallet-owner')).toHaveText(account.owner);

    // The PRF salt is fixed: a single touch yields the identity and the PRF, without `allowCredentials`.
    const calls = await passkeyCalls(h);
    expect(calls).toHaveLength(1);
    expect(calls[0].allowCredentials).toBeUndefined();
    expect(calls[0]).toMatchObject({ userVerification: 'required', rpId: RP_ID });

    await h.trafficSettled();
    const during = h.traffic.slice(from);
    const paths = during.filter(({ method }) => method !== 'RESPONSE').map(({ method, url }) => `${method} ${new URL(url).pathname}`).filter((line) => line.includes('/api/'));
    expect(paths).toEqual(['POST /api/recovery/passkey/challenge', 'POST /api/recovery/passkey']);
    const bodies = during.map(({ body }) => body).join('\n');
    expect(bodies).toContain(account.kit.encB.ct);
    expect(bodies).toContain(account.kit.encC.ct);
    expect(bodies).not.toContain('shareA');
    expect(bodies).not.toContain(account.shares.A);
    expect(bodies).not.toContain('seedBackup');

    // The PRF output has never been sent, not even during enrollment.
    const everything = h.traffic.map(({ url, body }) => `${url}\n${body}`).join('\n');
    expect(everything).not.toContain(prfHex);
    expect(everything).not.toContain(prfB64);
    expect(everything).not.toMatch(/"prf"/);

    // No session is opened: someone holding only the passkey does not get share A.
    expect((await h.context.cookies()).filter(({ domain }) => domain === RP_ID)).toEqual([]);
    const shareA = await h.popup.evaluate(async ({ setId, app }) => (await fetch(`/api/shares/a?setId=${setId}`, { headers: { 'X-Vault-App-Origin': app } })).status, { setId: account.kit.manifest.setId, app: APP });
    expect(shareA).toBe(401);

    await h.P('recovered-export-confirm').check();
    expect(await h.nextDownload(() => h.P('recovered-export-start').click())).toContain(account.seed);
  });

  test('wrong code and reused challenge', async ({ h }) => {
    const account = await h.activate(await h.register());
    await openPasskeyTab(h);

    const assertions: string[] = [];
    h.popup.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/recovery/passkey') assertions.push(request.postData() as string);
    });

    // The passkey is valid and the server hands over B and C, but without the code there is nothing.
    await h.P('recovery-code-input').fill(`${account.recovery.slice(0, -1)}${account.recovery.endsWith('0') ? '1' : '0'}`);
    await h.P('recover-passkey-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'DECRYPT_FAILED');
    await expect(h.P('done-panel')).toHaveCount(0);
    expect(assertions).toHaveLength(1);

    // Another attempt with a new challenge works. Replaying the same assertion does not.
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-passkey-submit').click();
    await h.P('done-panel').waitFor();

    const replay = await h.popup.evaluate(async (body) => {
      const response = await fetch('/api/recovery/passkey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      return { status: response.status, body: await response.json() };
    }, assertions[0]);
    expect(replay).toEqual({ status: 401, body: { error: 'RECOVERY_FAILED' } });
    h.tolerate(/401/);
  });

  test('wallet enrolled without a public key: the flow rejects it and explains why, until re-enrollment', async ({ h }) => {
    h.tolerate(/401/);
    const email = await h.register();
    // What enrollment did before this feature.
    await h.context.route('**/api/shares', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const body = request.postDataJSON() as Record<string, unknown>;
      delete body.registration;
      return route.continue({ postData: JSON.stringify(body) });
    });
    const account = await h.activate(email);
    await h.context.unroute('**/api/shares');

    await h.T('recover-button').click();
    await h.P('recover-tab-passkey').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-passkey-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'RECOVERY_FAILED');
    await expect(h.P('flow-error')).toContainText('predate this feature');
    await expect(h.P('passkey-recovery-limit')).toBeVisible();

    // Re-enrolling stores the new passkey's key, and from then on this option works.
    await h.loseAuthenticator();
    await h.addAuthenticator();
    await h.P('recover-tab-ac').click();
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await h.P('re-enroll-start').click();
    const { recovery } = await h.enrollSteps();
    await h.P('re-enrolled').waitFor();

    await openPasskeyTab(h);
    await h.P('recovery-code-input').fill(recovery);
    await h.P('recover-passkey-submit').click();
    await h.P('done-panel').waitFor();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
  });

  test('an unknown passkey yields nothing, with the generic response', async ({ h }) => {
    h.tolerate(/401/);
    const account = await h.activate(await h.register());
    await h.loseAuthenticator();
    await h.addAuthenticator();
    // A resident credential for this RP that the server does not know: same RP ID, never enrolled in the vault.
    await h.popup.evaluate(async (rpId) => {
      await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: rpId, name: 'Test' },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'x', displayName: 'x' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: {} },
        } as PublicKeyCredentialCreationOptions,
      });
    }, RP_ID);
    await openPasskeyTab(h);
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-passkey-submit').click();
    await expect(h.P('flow-error')).toHaveAttribute('data-code', 'RECOVERY_FAILED');
    await expect(h.P('done-panel')).toHaveCount(0);
  });
});
