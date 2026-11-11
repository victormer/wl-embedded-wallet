'use client';

import { useState, type FormEvent } from 'react';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { buildKit, kitFileName } from '@wl-embedded-wallet/core/kit';
import { getPrfOutput } from '@/lib/prf';
import { recoveryCodeToBytes } from '@wl-embedded-wallet/core/recovery-code';
import { readRuntimeConfig } from '@/lib/runtime-config';
import { downloadText } from '@/lib/seed-file';
import { runSigner } from '@/lib/signer-client';
import type { Envelope, SignedManifest, UpgradeKitWorkerRequest } from '@wl-embedded-wallet/core/types';
import { KIT_AND_CODE_WARNING, KitDeliverySteps, useRecoveryTool } from './recovery-tool';
import { ErrorNote, Note, Working } from './ui';

export interface KitUpgradeWallet {
  signed: SignedManifest;
  encB: Envelope;
  encC: Envelope;
  credentialId: string;
}

/**
 * For a wallet with an old kit, without a seed backup. The code is not stored, so it has to be asked for,
 * and the worker checks it by decrypting C. It does not create a new set: the kit still opens with that same code.
 * Without `offersTool` (the static page, which cannot fetch the tool) no kit is handed out.
 */
export function KitUpgradePanel({ wallet, combo, offersTool = true }: { wallet: KitUpgradeWallet; combo: 'A+B' | 'B+C'; offersTool?: boolean }) {
  if (!offersTool) {
    return (
      <section className="panel" data-testid="kit-upgrade-unavailable">
        <h2>New kit with seed backup</h2>
        <p className="muted">
          A new kit is always delivered with the recovery tool, and this page cannot download it. Generate it from the vault: when
          unlocking your wallet, or in Recover, Without the server tab.
        </p>
      </section>
    );
  }
  return <KitUpgradeForm wallet={wallet} combo={combo} />;
}

function KitUpgradeForm({ wallet, combo }: { wallet: KitUpgradeWallet; combo: 'A+B' | 'B+C' }) {
  const tool = useRecoveryTool();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tool.ready) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const bytes = recoveryCodeToBytes(code);
      const prf = await getPrfOutput(wallet.credentialId);
      const { signed, encB, encC, credentialId } = wallet;
      const source: UpgradeKitWorkerRequest['source'] =
        combo === 'A+B' ? { op: 'recover', combo, signed, encB, prf } : { op: 'recover', combo, signed, encB, encC, prf, code: bytes.slice() };
      // `bytes` is transferred: it is left empty here, and the worker overwrites it.
      const response = await runSigner({ op: 'upgrade-kit', source, encC, code: bytes });
      if (!response.ok) return setError(uiError(response.code, 'code'));
      if (!response.seedBackup) return setError(uiError('INTERNAL'));
      const kit = buildKit({ rpId: readRuntimeConfig().rpId, credentialId, encB, encC, signed, seedBackup: response.seedBackup });
      downloadText(JSON.stringify(kit, null, 2), kitFileName(signed.manifest.setId), 'application/json');
      setCode('');
      setDone(true);
    } catch (cause) {
      setError(toUiError(cause, 'code'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="kit-upgrade">
      <h2>New kit with seed backup</h2>
      <p className="muted">If your kit is old and has no seed backup, generate a new one. You need your recovery code and your passkey.</p>
      <Note tone="caution">{KIT_AND_CODE_WARNING}</Note>
      <KitDeliverySteps tool={tool} kitTitle="Generate and download the new kit" primary={false}>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span className="label">Recovery code</span>
            <input className="input input-code" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} data-testid="kit-upgrade-code" />
          </label>
          <button className="button button-secondary" type="submit" disabled={!tool.ready || busy || code.trim() === ''} data-testid="kit-upgrade-start">
            Generate the new kit
          </button>
        </form>
      </KitDeliverySteps>
      {busy && <Working text="Checking the code and encrypting the backup on this device." />}
      {done && (
        <Note tone="success" role="status" data-testid="kit-upgrade-done">
          Kit downloaded. It still opens with this same code. Destroy the old kit if you no longer need it.
        </Note>
      )}
      {error && <ErrorNote error={error} />}
    </section>
  );
}
