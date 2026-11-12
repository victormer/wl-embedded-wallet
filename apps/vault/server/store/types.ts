import type { Envelope, Manifest } from '@wl-embedded-wallet/core/types';

export type SetStatus = 'pending' | 'active' | 'revoked';

export interface UserRecord {
  userId: string;
  label: string;
  /** ISO. Audit only: it stores no seed data. */
  exportedAt: string | null;
}

export interface SessionRecord {
  userId: string;
  expiresAt: number;
  // Verified origin of the app that opened the session. Each redemption creates a new session.
  appOrigin: string | null;
  // Network from the last token: the `jti` is single-use and later routes need it.
  chain: { chainId: number; rpcUrl: string | null } | null;
}

export interface ShareSetRecord {
  setId: string;
  userId: string;
  status: SetStatus;
  credentialId: string;
  manifest: Manifest;
  signature: string;
  createdAt: string;
  // Deleted when the set is revoked.
  encA?: Envelope;
  encB?: Envelope;
  encC?: Envelope;
  // Only if enrollment registered the passkey on the server. Without this there is no kit-free recovery.
  credential?: { publicKey: string; counter: number };
  // SHA-256 of the session that created it (`sessionHash` in `server/http.ts`). Absent for sets created before migration 6.
  createdSessionHash?: string | null;
}

export type WebauthnPurpose = 'register' | 'recover';

export interface RelinkNonceRecord {
  nonce: string;
  // The new `sub`: only it can spend it.
  userId: string;
  safe: string;
  owner: string;
  // Who had the wallet when it was issued. If that changes before it is spent, it is no longer valid: of two attempts only one wins.
  fromUser: string | null;
  expiresAt: number;
}

export interface WalletRelinkRecord {
  safe: string;
  owner: string;
  oldSub: string;
  newSub: string;
  issuer: string;
  vaultOrigin: string;
  appOrigin: string | null;
  nonce: string;
  signature: string;
  linkedAt: string;
}

/** Audit trail of each share A release. Holds nothing secret, and is never deleted. */
export interface ShareAReleaseRecord {
  userId: string;
  setId: string;
  setStatus: 'pending' | 'active';
  sessionHash: string;
  appOrigin: string | null;
  /** ISO. */
  releasedAt: string;
}

export type SponsoredDeploymentStatus = 'prepared' | 'submitting' | 'sent';

/** One sponsored deployment per Safe and chain. `safe` is always lowercase. */
export interface SponsoredDeploymentRecord {
  chainId: number;
  safe: string;
  userId: string;
  status: SponsoredDeploymentStatus;
  /** Opaque JSON text: the store does not read it. */
  operation: string;
  operationHash: string;
  userOpHash: string | null;
  preparedAt: number;
  updatedAt: number;
}

export type PreparedTransactionStatus = 'prepared' | 'submitting' | 'sent';

/** One UserOperation the server built for a deployed Safe, keyed by chain, Safe and its hash. `safe` and `operationHash` always lowercase. */
export interface PreparedTransactionRecord {
  chainId: number;
  safe: string;
  userId: string;
  /** `userOperationHash` of the prepared operation (the signature is not part of it). */
  operationHash: string;
  status: PreparedTransactionStatus;
  /** Opaque JSON text: the store does not read it. */
  operation: string;
  sponsored: boolean;
  userOpHash: string | null;
  preparedAt: number;
  updatedAt: number;
}

export type RelinkResult = 'LINKED' | 'NONCE_INVALID' | 'STALE' | 'HAS_WALLET';

// Short: each operation brings its own app token.
export const SESSION_TTL_MS = 15 * 60 * 1000;

/** Every operation that relies on atomicity remains atomic with several replicas. */
export interface VaultStore {
  /** Checks the connection. Throws if the database does not respond. */
  ping(): Promise<void>;
  close(): Promise<void>;

  upsertUser(userId: string, label: string): Promise<void>;
  getUser(userId: string): Promise<UserRecord | null>;
  markExported(userId: string, exportedAt: string): Promise<boolean>;

  createSession(userId: string, options?: { ttlMs?: number; appOrigin?: string }): Promise<string>;
  getSession(token: string | undefined): Promise<SessionRecord | null>;
  setSessionChain(token: string, chain: { chainId: number; rpcUrl?: string } | null): Promise<void>;
  deleteSession(token: string): Promise<void>;

  /** `true` only the first time. Two concurrent requests cannot consume the same `jti`. */
  consumeJti(jti: string, expiresAtMs: number): Promise<boolean>;

  /** The set starts as `pending`. Returns `null` if the `setId` already exists, and throws if the user does not exist. */
  createSet(record: Omit<ShareSetRecord, 'status'>): Promise<ShareSetRecord | null>;
  getSet(userId: string, setId: string): Promise<ShareSetRecord | null>;
  getActiveSet(userId: string): Promise<ShareSetRecord | null>;
  /** For `GET /api/s2s/accounts/:sub`. */
  getAccount(userId: string): Promise<{ exists: boolean; address: string | null; owner: string | null }>;
  /**
   * Moves the set from `pending` to `active`, revokes the previous active one and deletes its encrypted material.
   * Returns `null` if it does not exist. A set that is not `pending` is returned unchanged: the API
   * responds `410` if it is `revoked`. If there is another active set with a different address, it stays `pending`:
   * replacing it would leave the funds inaccessible.
   */
  activateSet(userId: string, setId: string): Promise<ShareSetRecord | null>;
  /** Active sets with that owner, whatever their `sub`. */
  findActiveSetsByOwner(owner: string): Promise<ShareSetRecord[]>;

  /**
   * WebAuthn challenge. Expired ones are deleted when another is created. With `maxLive`, it is only created if fewer
   * than `maxLive` unexpired challenges of that purpose exist, exactly even across replicas; returns whether it was.
   */
  createWebauthnChallenge(challenge: string, purpose: WebauthnPurpose, userId: string | null, ttlMs: number, maxLive?: number): Promise<boolean>;
  /** `true` only the first time, and only with that purpose and that user, before it expires. */
  consumeWebauthnChallenge(challenge: string, purpose: WebauthnPurpose, userId: string | null): Promise<boolean>;
  /** The active set of a credential with a registered public key. */
  getActiveSetByCredential(credentialId: string): Promise<ShareSetRecord | null>;
  /** Raises the counter if it is still at `expected`: two concurrent assertions cannot both pass. */
  advanceCredentialCounter(setId: string, expected: number, next: number): Promise<boolean>;

  createRelinkNonce(record: RelinkNonceRecord): Promise<void>;
  /** Does not spend it. Returns `null` if it does not exist, belongs to another `sub` or has expired. */
  getRelinkNonce(nonce: string, userId: string): Promise<RelinkNonceRecord | null>;
  /**
   * In one transaction: spends the nonce, checks that the wallet is still where it was when the nonce was issued and
   * that the new `sub` has no other wallet, moves all sets, closes the previous `sub`'s sessions and records the audit trail.
   */
  relinkWallet(input: { nonce: string; userId: string; signature: string; issuer: string; vaultOrigin: string; appOrigin: string | null }): Promise<RelinkResult>;
  listWalletRelinks(owner: string): Promise<WalletRelinkRecord[]>;

  /**
   * Fixed window: counts one hit on `bucket` in the current `windowMs` window, in a single atomic statement, and
   * returns the hits so far in that window and when it ends (epoch ms). Expired buckets are purged now and then.
   */
  hitRateLimit(bucket: string, windowMs: number): Promise<{ hits: number; resetAt: number }>;

  recordShareARelease(record: ShareAReleaseRecord): Promise<void>;
  /** Oldest first. */
  listShareAReleases(userId: string): Promise<ShareAReleaseRecord[]>;

  getSponsoredDeployment(chainId: number, safe: string): Promise<SponsoredDeploymentRecord | null>;
  /**
   * Writes the operation as `prepared`, replacing what was there only if it is `prepared`, `submitting` and stale
   * (`updated_at <= now - staleSubmittingMs`), or `sent` long enough ago (`updated_at <= now - retrySentAfterMs`).
   * Returns whether it was written.
   */
  prepareSponsoredDeployment(input: {
    chainId: number;
    safe: string;
    userId: string;
    operation: string;
    operationHash: string;
    now: number;
    staleSubmittingMs: number;
    retrySentAfterMs: number;
  }): Promise<boolean>;
  /** `prepared` (or stale `submitting`) with that hash to `submitting`. Of several concurrent callers only one wins. */
  claimSponsoredDeployment(input: { chainId: number; safe: string; operationHash: string; now: number; staleSubmittingMs: number }): Promise<boolean>;
  /** `submitting` with that hash to `sent`, with the bundler's hash. */
  completeSponsoredDeployment(input: { chainId: number; safe: string; operationHash: string; userOpHash: string; now: number }): Promise<boolean>;
  /** `submitting` with that hash back to `prepared`, after a submission that did not go through. */
  releaseSponsoredDeployment(input: { chainId: number; safe: string; operationHash: string; now: number }): Promise<boolean>;

  /**
   * Inserts the operation as `prepared`. Returns `false` (and changes nothing) if a row with that chain, Safe and hash
   * already exists. In the same call, deletes every `prepared` row (any Safe) with `updated_at <= expireBefore`: they can no longer be sent.
   */
  createPreparedTransaction(input: {
    chainId: number;
    safe: string;
    userId: string;
    operationHash: string;
    operation: string;
    sponsored: boolean;
    now: number;
    expireBefore: number;
  }): Promise<boolean>;
  getPreparedTransaction(chainId: number, safe: string, operationHash: string): Promise<PreparedTransactionRecord | null>;
  /** `prepared` (or `submitting` with `updated_at <= now - staleSubmittingMs`) to `submitting`. Of several concurrent callers only one wins. */
  claimPreparedTransaction(input: { chainId: number; safe: string; operationHash: string; now: number; staleSubmittingMs: number }): Promise<boolean>;
  /** `submitting` to `sent`, with the bundler's hash. */
  completePreparedTransaction(input: { chainId: number; safe: string; operationHash: string; userOpHash: string; now: number }): Promise<boolean>;
  /** `submitting` back to `prepared`, after a submission that did not go through. */
  releasePreparedTransaction(input: { chainId: number; safe: string; operationHash: string; now: number }): Promise<boolean>;
  /** `true` if this Safe has a `sent` transaction on that chain with that bundler hash (case-insensitive). For `eth_getUserOperationReceipt`. */
  isSentTransaction(chainId: number, safe: string, userOpHash: string): Promise<boolean>;
}
