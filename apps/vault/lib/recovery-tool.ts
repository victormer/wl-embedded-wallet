import { sha256Hex } from '@wl-embedded-wallet/core/encoding';

export const RECOVERY_TOOL_PATH = '/recovery-tool';
export const RECOVERY_TOOL_FILE = 'wl-embedded-wallet-recovery.html';

export class RecoveryToolUnavailable extends Error {
  constructor() {
    super('RECOVERY_TOOL_UNAVAILABLE');
  }
}

const decoder = new TextDecoder();

/**
 * Only a 200 response with the tool's HTML counts: an error page or an empty response
 * does not unlock the kit. The fingerprint is computed over these same bytes, the ones that will be saved.
 */
export async function fetchRecoveryTool(fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array<ArrayBuffer>; hash: string }> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const response = await fetcher(RECOVERY_TOOL_PATH, { cache: 'no-store' });
    if (!response.ok) throw new RecoveryToolUnavailable();
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new RecoveryToolUnavailable();
  }
  if (!decoder.decode(bytes.subarray(0, 64)).trimStart().toLowerCase().startsWith('<!doctype html')) throw new RecoveryToolUnavailable();
  return { bytes, hash: await sha256Hex(bytes) };
}
