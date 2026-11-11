'use client';

import { useState } from 'react';
import { toUiError, uiError, type UiError } from '@/lib/error-text';
import { DERIVATION_PATH } from '@wl-embedded-wallet/core/manifest';
import { getPrfOutput } from '@/lib/prf';
import { downloadSeedFile } from '@/lib/seed-file';
import { runSigner } from '@/lib/signer-client';
import type { Envelope, SignedManifest } from '@wl-embedded-wallet/core/types';
import { markSeedExported } from '@/lib/vault-api';
import { ErrorNote, Note, Working } from './ui';

export interface ExportSource {
  signed: SignedManifest;
  encB: Envelope;
  credentialId: string;
  exportedAt: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US');
}

/** Optional export. The seed only exists in this thread while the file is being generated. */
export function ExportPanel({ source, onExported }: { source: ExportSource; onExported?: (address: `0x${string}`, owner: `0x${string}`) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [exportedAt, setExportedAt] = useState(source.exportedAt);
  const [justExported, setJustExported] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const prf = await getPrfOutput(source.credentialId);
      const response = await runSigner({ op: 'export', signed: source.signed, encB: source.encB, prf });
      if (!response.ok) return setError(uiError(response.code));
      if (!response.mnemonic) return setError(uiError('INTERNAL'));
      downloadSeedFile(response.mnemonic, response.owner, DERIVATION_PATH);
      setJustExported(true);
      setConfirmed(false);
      setExportedAt(await markSeedExported());
      onExported?.(response.address, response.owner);
    } catch (cause) {
      setError(toUiError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="export-panel">
      <h2>Download the seed (optional)</h2>
      {exportedAt && (
        <Note data-testid="export-already">
          You already downloaded the seed on {formatDate(exportedAt)}.
        </Note>
      )}
      <Note tone="caution" data-testid="export-warning">
        The file contains your full seed, unencrypted. Whoever has it controls your funds, and no one can revoke it.
        Rotating the shares does not change the seed: if it leaks, you must create a new wallet and move the funds.
      </Note>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          data-testid="export-confirm"
        />
        <span>I understand the risk and want to download my seed on this device.</span>
      </label>
      <button className="button button-secondary" type="button" disabled={!confirmed || busy} onClick={start} data-testid="export-start">
        Confirm with passkey and download
      </button>
      {busy && <Working text="Reconstructing the seed on this device." />}
      {justExported && (
        <Note tone="success" role="status" data-testid="export-done">
          File downloaded. Move it to a safe offline location.
        </Note>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
