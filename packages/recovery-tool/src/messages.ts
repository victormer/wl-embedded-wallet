import type { WalletErrorCode } from '@wl-embedded-wallet/core/errors';

// User-facing texts of the offline tool (HTML page and CLI). The logic lives in `@wl-embedded-wallet/core/offline`.
const MESSAGES: Partial<Record<WalletErrorCode, string>> = {
  INVALID_KIT: 'The file is not a valid emergency kit.',
  NO_SEED_BACKUP: 'This kit is old and has no seed backup. The kit and the code alone cannot recover it: you also need your passkey, or the vault server. If you still have access, generate a new kit.',
  BAD_RECOVERY_CODE: 'The recovery code is not well formed: it is 26 characters, with or without hyphens.',
  KDF_PARAMS_INVALID: 'The kit\'s encryption parameters are invalid. The kit has been tampered with.',
  DECRYPT_FAILED: 'Incorrect code or tampered kit. Nothing was decrypted.',
  FORMAT_UNSUPPORTED: 'This kit has a format this tool does not support.',
};

export function offlineErrorText(code: string): string {
  return MESSAGES[code as WalletErrorCode] ?? 'Something went wrong. No data was revealed.';
}

export const MISMATCH_TEXT = 'MISMATCH: what is inside this kit is not the wallet the kit claims. The seed is not shown. The kit has been tampered with: use another copy and do not send funds to these addresses.';
