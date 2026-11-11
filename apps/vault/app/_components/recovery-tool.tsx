'use client';

import { useState, type ReactNode } from 'react';
import { fetchRecoveryTool, RECOVERY_TOOL_FILE } from '@/lib/recovery-tool';
import { downloadBlob } from '@/lib/seed-file';
import { Note } from './ui';

export const KIT_AND_CODE_WARNING = 'Whoever has your kit and your code gets your seed, without a passkey or the server: store them separately.';

export const TOOL_REQUIRED_REASON = 'Without the tool, the kit cannot be opened if this service disappears: store it with the kit.';

export type RecoveryTool = ReturnType<typeof useRecoveryTool>;

/**
 * State of the tool download within a flow. It only counts as done once the server has returned it in full
 * and its download has been triggered: a failed click does not unlock the kit. Each flow has its own.
 */
export function useRecoveryTool() {
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const tool = await fetchRecoveryTool();
      downloadBlob(new Blob([tool.bytes], { type: 'text/html' }), RECOVERY_TOOL_FILE);
      setHash(tool.hash);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return { ready: hash !== null, hash, busy, failed, download };
}

/** The hash is computed over what was downloaded, to compare it with the one published for the reproducible build. */
function ToolControls({ tool, primary }: { tool: RecoveryTool; primary: boolean }) {
  const label = tool.ready ? 'Download it again' : tool.failed ? 'Retry the download' : 'Download the recovery tool';
  return (
    <>
      <button
        className={primary && !tool.ready ? 'button' : 'button button-secondary'}
        type="button"
        disabled={tool.busy}
        onClick={() => void tool.download()}
        data-testid="tool-download"
      >
        {label}
      </button>
      {tool.hash && (
        <p className="muted" data-testid="tool-hash">
          SHA-256 hash: <code>{tool.hash}</code>
        </p>
      )}
      {tool.failed && (
        <Note tone="danger" role="alert" data-testid="tool-error">
          Could not download the tool. Try again.
        </Note>
      )}
    </>
  );
}

/**
 * Every kit delivery goes through here, in this order: first the tool, and the kit only once the tool has been downloaded.
 * It is required on every delivery, including rotation, so that the stored tool matches the current version.
 * `children` is the kit step: it must be disabled while `tool.ready` is false.
 */
export function KitDeliverySteps({ tool, kitTitle, primary = true, children }: { tool: RecoveryTool; kitTitle: string; primary?: boolean; children: ReactNode }) {
  return (
    <ol className="delivery" data-testid="kit-delivery">
      <li className="stack" data-testid="delivery-tool" data-done={tool.ready}>
        <span className="delivery-title">1. Download the recovery tool</span>
        <p className="muted">{TOOL_REQUIRED_REASON}</p>
        <ToolControls tool={tool} primary={primary} />
      </li>
      <li className={tool.ready ? 'stack' : 'stack delivery-locked'} data-testid="delivery-kit" data-locked={!tool.ready}>
        <span className="delivery-title">2. {kitTitle}</span>
        {!tool.ready && (
          <p className="muted" data-testid="kit-locked">
            Enabled once the tool is downloaded.
          </p>
        )}
        {children}
      </li>
    </ol>
  );
}

/** Outside a kit delivery: to download it again, without blocking anything. */
export function RecoveryToolDownload() {
  const tool = useRecoveryTool();
  return (
    <div className="stack" data-testid="recovery-tool">
      <p className="muted">
        Also store the recovery tool with the kit. With it and your code you can recover the seed offline, even if this service disappears.
      </p>
      <ToolControls tool={tool} primary={false} />
    </div>
  );
}
