import { sha256, utf8 } from './encoding';

export const PRF_SALT_LABEL = 'wl-embedded-wallet/share-b/prf/v1';

/**
 * `PRF_SALT = SHA-256("wl-embedded-wallet/share-b/prf/v1")`. It is fixed and public: the per-credential secret is supplied
 * by the authenticator. That is why it is known before knowing which credential the user will pick, and a
 * discoverable passkey yields the PRF output in a single assertion, the same one that authenticates to the server.
 */
export function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(utf8(PRF_SALT_LABEL));
}

/** A fixed `user.id` would make a new passkey replace the previous set's passkey before the recovery drill. */
export function passkeyUserHandle(userId: string, setId: string): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(utf8(`${userId}|${setId}`));
}
