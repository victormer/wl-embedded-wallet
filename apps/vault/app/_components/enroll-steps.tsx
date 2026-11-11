'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { buildKit, kitFileName } from '@wl-embedded-wallet/core/kit';
import { KIT_AND_CODE_WARNING, KitDeliverySteps, useRecoveryTool } from './recovery-tool';
import { getPrfOutput, registerPasskeyWithPrf, type PrfSource } from '@/lib/prf';
import { readRuntimeConfig } from '@/lib/runtime-config';
import {
  confirmationMatches,
  generateRecoveryCode,
  pickConfirmationGroups,
  recoveryCodeToBytes,
} from '@wl-embedded-wallet/core/recovery-code';
import { downloadText } from '@/lib/seed-file';
import { runSigner } from '@/lib/signer-client';
import type { Enrolled, OfflineSource, RecoverAC, RegistrationJson } from '@wl-embedded-wallet/core/types';
import { zero } from '@wl-embedded-wallet/core/encoding';
import { activateShareSet, fetchRegisterChallenge, fetchShareSet, type ShareSet } from '@/lib/vault-api';
import { ErrorNote, Note, Screen, VersionWarning, Working } from './ui';

export interface EnrollResult {
  address: `0x${string}`;
  owner: `0x${string}`;
  set: ShareSet;
  wdkVersionMismatch: boolean;
}

type Step = 'passkey' | 'code' | 'confirm' | 'enrolling' | 'kit' | 'drill';

// The progress bar: each label covers one or more steps of the flow.
const STEP_LABELS: [string, Step[]][] = [
  ['Passkey', ['passkey']],
  ['Code', ['code', 'confirm']],
  ['Encryption', ['enrolling']],
  ['Kit', ['kit']],
  ['Drill', ['drill']],
];

type Passkey = { credentialId: string; prf: Uint8Array<ArrayBuffer>; prfSource: PrfSource; registration?: RegistrationJson };

/**
 * Enrollment and rotation share these steps. With `source` the seed is reused and the same address must come out.
 * The set is not activated until the A+B drill returns the expected address.
 */
export function EnrollSteps(props: {
  userId: string;
  title: string;
  source?: () => RecoverAC | OfflineSource;
  expectedAddress?: string;
  // This session's owner according to the server, if the wallet arrived here relinked from another account.
  linkedOwner?: string;
  onComplete(result: EnrollResult): void;
}) {
  const { userId, title, source, expectedAddress, linkedOwner, onComplete } = props;
  const setId = useRef<string | null>(null);
  const [step, setStep] = useState<Step>('passkey');
  const [passkey, setPasskey] = useState<Passkey | null>(null);
  const [code, setCode] = useState('');
  const [enrolled, setEnrolled] = useState<{ value: Enrolled; address: `0x${string}`; owner: `0x${string}`; mismatch: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const groups = useMemo(() => pickConfirmationGroups(2), []);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  // Per mount: every enrollment or rotation requires the tool again before the kit.
  const tool = useRecoveryTool();

  // Requested on load: some browsers require the passkey prompt within the user's gesture, without waiting on the network.
  const challenge = useRef<Promise<string> | null>(null);

  const currentSetId = () => (setId.current ??= crypto.randomUUID());

  useEffect(() => {
    challenge.current ??= fetchRegisterChallenge();
    // It is requested again in `createPasskey`, and the failure is reported there.
    challenge.current.catch(() => {
      challenge.current = null;
    });
  }, []);

  useEffect(
    () => () => {
      // On exit, the passkey bytes must not stay in memory.
      if (passkey) zero(passkey.prf);
    },
    [passkey],
  );

  async function createPasskey() {
    setBusy(true);
    setError(null);
    try {
      const created = await registerPasskeyWithPrf({ userId, setId: currentSetId(), challenge: await (challenge.current ?? fetchRegisterChallenge()) });
      setPasskey({ credentialId: created.credentialId, prf: created.prfOutput, prfSource: created.prfSource, registration: created.registration });
      setCode(generateRecoveryCode());
      setStep('code');
    } catch (cause) {
      setError(toUiError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    if (!passkey) return;
    setStep('enrolling');
    setError(null);
    // Copies are transferred: if something fails, the user retries without repeating the passkey.
    const response = await runSigner({
      op: 'enroll',
      userId,
      setId: currentSetId(),
      credentialId: passkey.credentialId,
      prf: passkey.prf.slice(),
      code: recoveryCodeToBytes(code),
      source: source?.(),
      linkedOwner,
      registration: passkey.registration,
    });
    if (!response.ok) {
      setError(uiError(response.code, source ? 'code' : 'passkey'));
      return;
    }
    if (expectedAddress && response.address !== expectedAddress) {
      setError(uiError('ADDRESS_MISMATCH'));
      return;
    }
    if (!response.enrolled) {
      setError(uiError('INTERNAL'));
      return;
    }
    setEnrolled({ value: response.enrolled, address: response.address, owner: response.owner, mismatch: response.wdkVersionMismatch });
    setStep('kit');
  }

  function submitConfirmation(event: FormEvent) {
    event.preventDefault();
    if (!confirmationMatches(code, answers)) {
      setError(uiError('BAD_RECOVERY_CODE'));
      return;
    }
    setError(null);
    void enroll();
  }

  /** Real drill: reads the set from the server and recovers it with a fresh passkey read. */
  async function drill() {
    if (!passkey || !enrolled) return;
    setStep('drill');
    setBusy(true);
    setError(null);
    try {
      const prf = await getPrfOutput(passkey.credentialId);
      const set = await fetchShareSet(currentSetId());
      if (!set) throw new Error('missing set');
      const response = await runSigner({ op: 'recover', combo: 'A+B', signed: set.signed, encB: set.encB, prf });
      if (!response.ok) return setError(uiError(response.code));
      if (response.address !== enrolled.address) return setError(uiError('ADDRESS_MISMATCH'));
      await activateShareSet(set.setId);
      onComplete({ address: response.address, owner: response.owner, set, wdkVersionMismatch: enrolled.mismatch });
    } catch (cause) {
      setError(toUiError(cause));
    } finally {
      setBusy(false);
    }
  }

  function downloadKit() {
    if (!passkey || !enrolled || !tool.ready) return;
    const kit = buildKit({
      rpId: readRuntimeConfig().rpId,
      credentialId: passkey.credentialId,
      encB: enrolled.value.encB,
      encC: enrolled.value.encC,
      signed: enrolled.value.signed,
      seedBackup: enrolled.value.seedBackup,
    });
    downloadText(JSON.stringify(kit, null, 2), kitFileName(currentSetId()), 'application/json');
    void drill();
  }

  return (
    <Screen title={title} testId="enroll">
      <ol className="steps" data-testid="enroll-step" data-step={step}>
        {STEP_LABELS.map(([label, steps], index) => {
          const current = STEP_LABELS.findIndex(([, owned]) => owned.includes(step));
          return (
            <li key={label} className={index === current ? 'current' : index < current ? 'done' : ''} aria-current={index === current ? 'step' : undefined}>
              {label}
            </li>
          );
        })}
      </ol>

      {step === 'passkey' && (
        <section className="stack" data-testid="step-passkey">
          <p>Create a passkey for this vault. It protects one of the three parts of your key.</p>
          <button className="button" type="button" disabled={busy} onClick={createPasskey} data-testid="passkey-create">
            Create passkey
          </button>
        </section>
      )}

      {passkey && (
        // Diagnostic for the test suite only (where the PRF arrived): an attribute, never visible text.
        <span hidden data-testid="prf-source" data-source={passkey.prfSource} />
      )}

      {step === 'code' && (
        <section className="stack" data-testid="step-code">
          <p>This is your recovery code. It is shown only once: store it in a safe place.</p>
          <code className="value value-code" data-testid="recovery-code">
            {code}
          </code>
          <Note tone="caution" data-testid="code-separate-warning">
            {KIT_AND_CODE_WARNING}
          </Note>
          <button className="button" type="button" onClick={() => setStep('confirm')} data-testid="code-saved">
            I've saved it
          </button>
        </section>
      )}

      {step === 'confirm' && (
        <form className="stack" onSubmit={submitConfirmation} data-testid="step-confirm">
          <p>Enter these groups of the code to confirm that you have saved it.</p>
          {groups.map((group) => (
            <label className="field" key={group}>
              <span className="label">Group {group + 1}</span>
              <input
                className="input input-code"
                autoComplete="off"
                value={answers[group] ?? ''}
                onChange={(event) => setAnswers({ ...answers, [group]: event.target.value })}
                data-testid={`confirm-group-${group}`}
                data-group={group}
              />
            </label>
          ))}
          <button className="button" type="submit" data-testid="confirm-submit">
            Confirm
          </button>
        </form>
      )}

      {step === 'enrolling' && !error && <Working text="Generating and encrypting the shares on this device." />}
      {step === 'enrolling' && error && (
        <button className="button" type="button" onClick={() => void enroll()} data-testid="enroll-retry">
          Retry
        </button>
      )}

      {step === 'kit' && (
        <section className="stack" data-testid="step-kit">
          <p>
            Download the recovery tool and then the emergency kit. The kit contains your encrypted data and a backup of your
            seed, encrypted with your code. Next, we will test recovery with your passkey before treating the wallet as active.
          </p>
          <Note tone="caution" data-testid="kit-separate-warning">
            {KIT_AND_CODE_WARNING}
          </Note>
          <KitDeliverySteps tool={tool} kitTitle="Download the emergency kit">
            <button className="button" type="button" disabled={!tool.ready} onClick={downloadKit} data-testid="kit-download">
              Download kit and test recovery
            </button>
          </KitDeliverySteps>
        </section>
      )}

      {step === 'drill' && (
        <section className="stack" data-testid="step-drill">
          {busy && <Working text="Testing recovery with the passkey." />}
          {!busy && error && (
            <button className="button" type="button" onClick={() => void drill()} data-testid="drill-retry">
              Repeat the test
            </button>
          )}
        </section>
      )}

      <VersionWarning show={enrolled?.mismatch ?? false} />
      <ErrorNote error={error} />
    </Screen>
  );
}
