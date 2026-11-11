import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { combineMnemonic } from '@tetherto/wdk-utils';
import { expect, test as base, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { generate } from 'otplib';
import { mnemonicToAccount } from 'viem/accounts';
import { hexEncode } from '../../packages/core/src/encoding.ts';
import { openShareB } from '../../packages/core/src/envelope.ts';
import { openShareC } from '../../packages/core/src/recovery-code.ts';
import { shareDigest } from '../../packages/core/src/manifest.ts';
import type { Envelope, Manifest, SeedBackup } from '../../packages/core/src/types.ts';
import { APP, PASSWORD, RP_ID, RUN_DIR, SECRETS_FILE, STATE_FILE, VAULT, type RunState } from './env.ts';

export interface Kit {
  v: number;
  rpId: string;
  credentialId: string;
  encB: Envelope;
  encC: Envelope;
  manifest: Manifest;
  signature: string;
  seedBackup?: SeedBackup;
}

export interface Account {
  email: string;
  safe: `0x${string}`;
  owner: `0x${string}`;
  recovery: string;
  totpSecret: string;
  kit: Kit;
  seed: string;
  shares: { A: string; B: string; C: string };
}

export type VaultResult = {
  timeout?: boolean;
  ok?: boolean;
  code?: string;
  address?: string;
  owner?: string;
  signature?: `0x${string}`;
  transactionHash?: string;
};

const AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  hasPrf: true,
  automaticPresenceSimulation: true,
} as const;

export function runState(): RunState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState;
}

let emailCounter = 0;
// The demo login's 2FA secret, per account.
const totpSecrets = new Map<string, string>();
// The last TOTP step submitted per secret.
const usedTotpSteps = new Map<string, number>();

export function newEmail(): string {
  emailCounter += 1;
  return `u${Date.now()}-${emailCounter}@example.com`;
}

export class Harness {
  readonly context: BrowserContext;
  app!: Page;
  popup!: Page;
  cdp!: CDPSession;
  authenticatorId = '';
  /** Console output of every page and its workers. */
  readonly consoleLines: string[] = [];
  readonly pageErrors: string[] = [];
  readonly traffic: { method: string; url: string; body: string }[] = [];
  private readonly secrets = new Set<string>();
  private readonly tolerated: RegExp[] = [/Failed to load resource/, /CORS policy/];
  private captureBodies = false;
  private lastEmail = '';
  private readonly pendingBodies: Promise<void>[] = [];

  constructor(context: BrowserContext) {
    this.context = context;
    context.on('console', (message) => {
      const line = message.text();
      this.consoleLines.push(line);
      if (message.type() === 'error' && !this.tolerated.some((pattern) => pattern.test(line))) this.pageErrors.push(`console: ${line}`);
    });
    context.on('weberror', (error) => this.pageErrors.push(`pageerror: ${error.error().message}`));
    context.on('request', (request) => {
      this.traffic.push({ method: request.method(), url: request.url(), body: request.postData() ?? '' });
    });
    context.on('response', (response) => {
      const url = response.url();
      if (!this.captureBodies || new URL(url).pathname.startsWith('/_next/static/')) return;
      // The body of an interrupted navigation or of a download may never resolve.
      const timeout = new Promise<void>((done) => setTimeout(done, 5000));
      this.pendingBodies.push(
        Promise.race([
          response
            .text()
            .then((body) => void this.traffic.push({ method: 'RESPONSE', url, body }))
            .catch(() => undefined),
          timeout,
        ]),
      );
    });
  }

  async start(): Promise<void> {
    this.app = await this.context.newPage();
    await this.app.goto(`${APP}/`);
  }

  /** Console errors expected in this test, such as those it triggers on purpose. */
  tolerate(pattern: RegExp): void {
    this.tolerated.push(pattern);
  }

  captureResponseBodies(): void {
    this.captureBodies = true;
  }

  async trafficSettled(): Promise<void> {
    await Promise.all(this.pendingBodies);
  }

  T(id: string): Locator {
    return this.app.getByTestId(id);
  }

  P(id: string): Locator {
    return this.popup.getByTestId(id);
  }

  currentEmail(): string {
    return this.lastEmail;
  }

  registerSecret(secret: string): void {
    this.secrets.add(secret);
    appendFileSync(SECRETS_FILE, `${secret}\n`);
  }

  findLeaks(): string[] {
    const text = this.consoleLines.join('\n').toLowerCase();
    return [...this.secrets].filter((secret) => text.includes(secret.toLowerCase()));
  }

  assertClean(): void {
    expect(this.findLeaks(), 'secrets in console.*').toEqual([]);
    expect(this.pageErrors, 'console or page errors').toEqual([]);
  }

  apiRequests(from = 0): string[] {
    return this.traffic.slice(from).filter(({ url, method }) => method !== 'RESPONSE' && new URL(url).pathname.startsWith('/api/')).map(({ method, url }) => `${method} ${url}`);
  }

  async shot(page: Page, name: string): Promise<void> {
    const dir = process.env.E2E_SCREENSHOTS_DIR ?? resolve(RUN_DIR, 'screenshots');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
  }

  /** The same tab moves to another site, like a link: it stays the popup's opener and keeps its authenticator. */
  async navigateApp(url: string): Promise<void> {
    await this.app.evaluate((target) => {
      window.location.href = target;
    }, url).catch(() => undefined);
    await this.app.waitForURL(`${url}**`);
  }

  /** Up to the QR screen: correct password, without the second factor. */
  async startRegistration(email = newEmail()): Promise<string> {
    await this.T('auth-tab-register').click();
    await this.T('auth-email').fill(email);
    await this.T('auth-password').fill(PASSWORD);
    await this.T('auth-submit').click();
    await this.T('totp-qr').waitFor();
    return email;
  }

  async register(email = newEmail()): Promise<string> {
    await this.startRegistration(email);
    const secret = await this.T('totp-secret').innerText();
    totpSecrets.set(email, secret);
    this.lastEmail = email;
    this.registerSecret(secret);
    await this.passTotp(secret);
    await this.T('wallet-empty').waitFor();
    return email;
  }

  async login(email: string): Promise<void> {
    await this.T('auth-tab-login').click();
    await this.T('auth-email').fill(email);
    await this.T('auth-password').fill(PASSWORD);
    await this.T('auth-submit').click();
    await this.T('totp-step').waitFor();
    await this.passTotp(totpSecrets.get(email) as string);
  }

  async logout(): Promise<void> {
    await this.T('logout-button').click();
    await this.T('auth-email').waitFor();
  }

  async addAuthenticator(): Promise<void> {
    this.cdp ??= await this.context.newCDPSession(this.popup);
    await this.cdp.send('WebAuthn.enable');
    const { authenticatorId } = await this.cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR });
    this.authenticatorId = authenticatorId;
  }

  /** Makes the next passkey read fail as if the user had cancelled it. */
  async refusePasskey(): Promise<void> {
    await this.popup.evaluate(() => {
      navigator.credentials.get = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
    });
  }

  async allowPasskey(): Promise<void> {
    await this.popup.evaluate(() => {
      delete (navigator.credentials as unknown as { get?: unknown }).get;
    });
  }

  async loseAuthenticator(): Promise<void> {
    await this.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: this.authenticatorId });
  }

  /** Clicks a demo button that opens the vault. The first time, it sets up the popup and its authenticator. */
  async openPopup(trigger: () => Promise<void>): Promise<void> {
    if (this.popup) return trigger();
    const opened = this.context.waitForEvent('page');
    await trigger();
    this.popup = await opened;
    await this.addAuthenticator();
  }

  /** Full enrollment from the demo button. Also checks the real secrets of the created set. */
  async activate(email: string, options: { screenshot?: boolean; wrongConfirmation?: boolean } = {}): Promise<Account> {
    await this.openPopup(() => this.T('activate-button').click());
    const { recovery, kit } = await this.enrollSteps(options);
    await this.P('done-panel').waitFor();
    const safe = (await this.P('wallet-address').innerText()) as `0x${string}`;
    const owner = (await this.P('wallet-owner').innerText()) as `0x${string}`;
    await expect(this.T('wallet-address')).toHaveText(safe);
    await expect(this.T('wallet-owner')).toHaveText(owner);
    const { seed, shares } = await this.provenSecrets(kit, recovery, owner);
    return { email, safe, owner, recovery, totpSecret: totpSecrets.get(email) as string, kit, seed, shares };
  }

  async passTotp(secret: string): Promise<void> {
    // The demo accepts each step once per account: a second sign-in within the same 30 s uses the next step's code
    // (within the demo's tolerance), as a user waiting for the next code would.
    const step = Math.max(Math.floor(Date.now() / 1000 / 30), (usedTotpSteps.get(secret) ?? -1) + 1);
    // More than one step ahead is outside the tolerance: wait until it is the next one.
    const wait = (step - 1) * 30_000 - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    usedTotpSteps.set(secret, step);
    await this.T('totp-input').fill(await generate({ secret, epoch: step * 30 }));
    await this.T('totp-submit').click();
  }

  /** Passkey, code, confirmation, tool, kit and drill. Used for enrollment and for rotation. */
  async enrollSteps(options: { screenshot?: boolean; wrongConfirmation?: boolean } = {}): Promise<{ recovery: string; kit: Kit }> {
    const recovery = await this.reachKitStep(options);
    // The tool first: until it is downloaded, the kit cannot be downloaded.
    await expect(this.P('kit-download')).toBeDisabled();
    await this.downloadToolStep();
    return { recovery, kit: await this.downloadKit() };
  }

  /** From enrollment or rotation up to the kit step. Returns the recovery code. */
  async reachKitStep(options: { screenshot?: boolean; wrongConfirmation?: boolean } = {}): Promise<string> {
    await this.P('passkey-create').click();
    await this.P('recovery-code').waitFor();
    const source = await this.P('prf-source').getAttribute('data-source');
    console.log(`[prf] In this Chromium the PRF arrives during: ${source}`);
    const recovery = await this.P('recovery-code').innerText();
    this.registerSecret(recovery);
    this.registerSecret(recovery.replaceAll('-', ''));
    if (options.screenshot) await this.shot(this.popup, 'activate-recovery-code');
    await expect(this.P('code-separate-warning')).toContainText('store them separately');
    await this.P('code-saved').click();
    const groups = recovery.split('-');
    const inputs = await this.popup.locator('[data-group]').all();
    expect(inputs).toHaveLength(2);
    if (options.wrongConfirmation) {
      for (const input of inputs) await input.fill('ZZZZ');
      await this.P('confirm-submit').click();
      await expect(this.P('flow-error')).toHaveAttribute('data-code', 'BAD_RECOVERY_CODE');
      await expect(this.P('step-confirm')).toBeVisible();
    }
    for (const input of inputs) await input.fill(groups[Number(await input.getAttribute('data-group'))]);
    await this.P('confirm-submit').click();
    await this.P('kit-download').waitFor();
    await expect(this.P('kit-separate-warning')).toContainText('store them separately');
    return recovery;
  }

  /** Downloads the kit, with the tool already downloaded, and starts the drill. */
  async downloadKit(): Promise<Kit> {
    await expect(this.P('kit-download')).toBeEnabled();
    const downloading = this.popup.waitForEvent('download');
    await this.P('kit-download').click();
    const download = await downloading;
    const kit = JSON.parse(readFileSync(await download.path(), 'utf8')) as Kit;
    await download.delete();
    return kit;
  }

  /** Reads a passkey's PRF directly, as the vault would. */
  async readPrf(credentialId: string): Promise<Uint8Array> {
    const values = await this.popup.evaluate(
      async ({ credentialId, rpId }) => {
        const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wl-embedded-wallet/share-b/prf/v1'));
        const raw = atob(credentialId.replaceAll('-', '+').replaceAll('_', '/'));
        const credential = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId,
            allowCredentials: [{ type: 'public-key', id: Uint8Array.from(raw, (char) => char.charCodeAt(0)) }],
            userVerification: 'required',
            extensions: { prf: { eval: { first: salt } } },
          } as PublicKeyCredentialRequestOptions,
        })) as PublicKeyCredential;
        const results = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
        return Array.from(new Uint8Array(results.prf?.results?.first as ArrayBuffer));
      },
      { credentialId, rpId: RP_ID },
    );
    return Uint8Array.from(values);
  }

  /** Without a credential, the browser may wait until the timeout: it is enough that nothing comes back in that time. */
  async passkeyAvailable(credentialId: string): Promise<boolean> {
    const pending = this.readPrf(credentialId).then(
      () => true,
      () => false,
    );
    return Promise.race([pending, new Promise<boolean>((done) => setTimeout(() => done(false), 5000))]);
  }

  /**
   * Actually obtains the three shares and the seed, and proves they are the authentic ones against the manifest
   * and the address. They are registered, so none of them may appear in the console during the whole suite.
   */
  async provenSecrets(kit: Kit, recovery: string, owner: string): Promise<{ seed: string; shares: { A: string; B: string; C: string } }> {
    const ids = { userId: kit.manifest.userId, setId: kit.manifest.setId };
    const appOrigin = new URL(this.app.url()).origin;
    const response = await this.popup.evaluate(async ({ setId, appOrigin }) => {
      const result = await fetch(`/api/shares/a?setId=${setId}`, { headers: { 'X-Vault-App-Origin': appOrigin } });
      return { status: result.status, body: (await result.json()) as { shareA?: string } };
    }, { setId: ids.setId, appOrigin });
    expect(response.status).toBe(200);
    const A = response.body.shareA as string;
    const prf = await this.readPrf(kit.credentialId);
    const B = hexEncode(await openShareB(kit.encB, prf, ids));
    const C = hexEncode(await openShareC(kit.encC, new TextEncoder().encode(recovery.replaceAll('-', '')), ids));

    expect(await shareDigest(A)).toBe(kit.manifest.shareDigests.A);
    expect(await shareDigest(B)).toBe(kit.manifest.shareDigests.B);
    expect(await shareDigest(C)).toBe(kit.manifest.shareDigests.C);

    const seed = await combineMnemonic([A, B]);
    expect(await combineMnemonic([A, C])).toBe(seed);
    expect(await combineMnemonic([B, C])).toBe(seed);
    expect(mnemonicToAccount(seed).address).toBe(owner);

    for (const secret of [seed, A, B, C]) this.registerSecret(secret);
    return { seed, shares: { A, B, C } };
  }

  /** What an XSS in the app would do: requests a token and talks to the popup, bypassing the demo UI. */
  async direct(kind: string, action: Record<string, unknown>, tokenChainId?: number, vault: string = VAULT): Promise<VaultResult> {
    return this.app.evaluate(
      async ({ kind, action, tokenChainId, vault }) => {
        const response = await fetch('/api/vault/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tokenChainId === undefined ? {} : { chainId: tokenChainId }),
        });
        const { token } = (await response.json()) as { token: string };
        const popup = window.open(`${vault}/${kind}`, 'wl-embedded-wallet-vault', 'popup,width=480,height=760') as Window;
        return new Promise<VaultResult>((resolve) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => resolve({ timeout: true }), 30_000);
          const onMessage = (event: MessageEvent) => {
            if (event.origin !== vault) return;
            if (event.data.type === 'ready') popup.postMessage({ protocol: 'wl-embedded-wallet/protocol/v1', type: 'request', id, token, action }, vault);
            if (event.data.type === 'result' && event.data.id === id) {
              clearTimeout(timer);
              window.removeEventListener('message', onMessage);
              resolve(event.data as VaultResult);
            }
          };
          window.addEventListener('message', onMessage);
        });
      },
      { kind, action, tokenChainId, vault },
    );
  }

  async selectChain(chainId: number, expectedDeployed: 'true' | 'false'): Promise<void> {
    await this.T('chain-select').selectOption(String(chainId));
    await expect(this.T('wallet-deployed')).toHaveAttribute('data-deployed', expectedDeployed);
  }

  async selectUnsupportedChain(chainId: number, code: string): Promise<void> {
    await this.T('chain-select').selectOption(String(chainId));
    await expect(this.T('wallet-deployed')).toHaveAttribute('data-code', code);
  }

  async deploy(): Promise<string> {
    await this.T('deploy-button').click();
    await this.P('deploy-approve').waitFor();
    await this.P('deploy-approve').click();
    await this.P('deploy-tx').waitFor();
    await expect(this.T('wallet-deployed')).toHaveAttribute('data-deployed', 'true');
    return this.P('deploy-tx').innerText();
  }

  /** Signs from a demo form and waits for the server verification. */
  async signFromForm(submit: string, kind: string): Promise<{ valid: string | null; erc1271: string | null; signature: string }> {
    await this.T(submit).click();
    await this.P('sign-approve').waitFor();
    await this.P('sign-approve').click();
    await expect(this.T('sign-result')).toHaveAttribute('data-kind', kind);
    await this.T('sign-verified').waitFor();
    return {
      valid: await this.T('sign-verified').getAttribute('data-valid'),
      erc1271: (await this.T('sign-erc1271').count()) ? await this.T('sign-erc1271').getAttribute('data-valid') : null,
      signature: await this.T('sign-signature').innerText(),
    };
  }

  /** Clears `window.opener` and opens /recover: the state of someone arriving with their kit, without the app. */
  async openStandaloneRecover(): Promise<void> {
    await this.popup.evaluate(() => {
      window.opener = null;
    });
    await this.popup.goto(`${VAULT}/recover`);
    await this.P('recover-bc').waitFor();
    await expect(this.P('no-opener')).toHaveCount(0);
    await expect(this.P('recover-tab-ac')).toHaveCount(0);
  }

  /**
   * Step 1 of a kit delivery: downloads the tool, checks that the displayed hash is that of the download
   * and that the step is marked done. Returns the hash.
   */
  async downloadToolStep(): Promise<string> {
    await expect(this.P('delivery-kit')).toHaveAttribute('data-locked', 'true');
    const downloading = this.popup.waitForEvent('download');
    await this.P('tool-download').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('wl-embedded-wallet-recovery.html');
    const bytes = readFileSync(await download.path());
    await download.delete();
    await expect(this.P('delivery-tool')).toHaveAttribute('data-done', 'true');
    await expect(this.P('delivery-kit')).toHaveAttribute('data-locked', 'false');
    const hash = (await this.P('tool-hash').locator('code').innerText()).trim();
    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    return hash;
  }

  /** Downloads the offline tool from the vault and returns its local path and the hash shown by the UI. */
  async downloadTool(dir: string): Promise<{ path: string; hash: string }> {
    const downloading = this.popup.waitForEvent('download');
    await this.P('tool-download').click();
    const download = await downloading;
    const path = resolve(dir, download.suggestedFilename());
    await download.saveAs(path);
    await this.P('tool-hash').waitFor();
    return { path, hash: (await this.P('tool-hash').locator('code').innerText()).trim() };
  }

  /** Saves the next file the popup downloads and returns it as text. */
  async nextDownload(trigger: () => Promise<void>): Promise<string> {
    const downloading = this.popup.waitForEvent('download');
    await trigger();
    const download = await downloading;
    const text = readFileSync(await download.path(), 'utf8');
    await download.delete();
    return text;
  }

  async recoverWithKit(kit: unknown, code: string): Promise<void> {
    const buffer = Buffer.from(typeof kit === 'string' ? kit : JSON.stringify(kit));
    await this.P('kit-file').setInputFiles({ name: 'kit.json', mimeType: 'application/json', buffer });
    await this.P('recovery-code-input').fill(code);
  }
}

export const test = base.extend<{ h: Harness }>({
  h: async ({ browser }, use) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const harness = new Harness(context);
    await harness.start();
    await use(harness);
    // Checked at the end of each test, with the secrets known up to that point.
    harness.assertClean();
    await context.close();
  },
});

export { expect };
