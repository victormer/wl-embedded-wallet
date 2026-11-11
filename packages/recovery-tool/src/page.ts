// The offline tool's page. No DOM dependencies outside this file, and always `textContent`.
import { WalletError } from '@wl-embedded-wallet/core/errors';
import { recoverFromKit, type OfflineRecovery } from '@wl-embedded-wallet/core/offline';
import { MISMATCH_TEXT, offlineErrorText } from './messages';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = byId<HTMLFormElement>('form');
const kitInput = byId<HTMLInputElement>('kit');
const codeInput = byId<HTMLInputElement>('code');
const submit = byId<HTMLButtonElement>('submit');
const working = byId('working');
const errorNote = byId('error');
const result = byId('result');
const verdict = byId('verdict');
const seedPanel = byId('seed-panel');
const seedOutput = byId('seed');
const reveal = byId<HTMLButtonElement>('reveal');
const hide = byId<HTMLButtonElement>('hide');

// The seed lives only here until the user asks to see it, and is discarded on every new attempt.
let mnemonic: string | null = null;

function hideSeed(): void {
  seedOutput.textContent = '';
  seedOutput.hidden = true;
  hide.hidden = true;
  reveal.hidden = false;
}

function reset(): void {
  mnemonic = null;
  hideSeed();
  errorNote.hidden = true;
  errorNote.removeAttribute('data-code');
  result.hidden = true;
  seedPanel.hidden = true;
}

function showCheck(id: string, value: string | null, expected: string, matches: boolean): void {
  byId(id).textContent = value ?? 'Cannot be computed';
  const check = byId(`${id}-check`);
  check.textContent = matches ? 'Matches the kit.' : `MISMATCH: the kit says ${expected}.`;
  check.dataset.matches = String(matches);
}

function show(recovery: OfflineRecovery): void {
  showCheck('owner', recovery.derivedOwner, recovery.expectedOwner, recovery.ownerMatches);
  showCheck('safe', recovery.derivedSafe, recovery.expectedSafe, recovery.safeMatches);
  verdict.dataset.state = recovery.ok ? 'ok' : 'mismatch';
  verdict.className = recovery.ok ? 'note note-ok' : 'note note-error';
  verdict.textContent = recovery.ok ? 'Everything matches: this seed controls the kit\'s wallet.' : MISMATCH_TEXT;
  result.hidden = false;
  seedPanel.hidden = !recovery.ok;
  mnemonic = recovery.ok ? recovery.mnemonic : null;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    reset();
    const file = kitInput.files?.[0];
    submit.disabled = true;
    working.hidden = false;
    // Argon2id blocks this thread: let the notice paint before starting.
    await new Promise((done) => setTimeout(done, 30));
    try {
      if (!file) throw new WalletError('INVALID_KIT');
      const recovery = await recoverFromKit(await file.text(), codeInput.value);
      codeInput.value = '';
      show(recovery);
    } catch (error) {
      const code = error instanceof WalletError ? error.code : 'INTERNAL';
      errorNote.dataset.code = code;
      errorNote.textContent = offlineErrorText(code);
      errorNote.hidden = false;
    } finally {
      working.hidden = true;
      submit.disabled = false;
    }
  })();
});

reveal.addEventListener('click', () => {
  if (!mnemonic) return;
  seedOutput.textContent = mnemonic;
  seedOutput.hidden = false;
  reveal.hidden = true;
  hide.hidden = false;
});

hide.addEventListener('click', hideSeed);
