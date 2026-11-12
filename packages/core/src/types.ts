import { WalletError, type WalletErrorCode } from './errors';
import type { UserOperationJson, VaultCall, VaultSignRequest } from './operations';
import type { SmartAccountInfo } from './safe';

export { WalletError };
export type { WalletErrorCode };

export type ShareName = 'A' | 'B' | 'C';
export type Kdf = 'kms' | 'prf-hkdf-sha256' | 'argon2id';

export interface Argon2Params {
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export interface Envelope {
  v: 1;
  share: ShareName;
  userId: string;
  setId: string;
  kdf: Kdf;
  kdfParams: Record<string, unknown>;
  salt: string;
  iv: string;
  ct: string;
}

/** Seed backup, encrypted with the recovery code. It lives only in the kit: it never reaches the server. */
export interface SeedBackup {
  v: 1;
  kdf: 'argon2id';
  kdfParams: Argon2Params;
  salt: string;
  iv: string;
  ct: string;
}

export interface Manifest {
  v: 1;
  // The `sub` the envelopes were encrypted under. Relinking to another account does not change it: it is part of their AAD.
  userId: string;
  setId: string;
  n: number;
  k: number;
  format: string;
  wdkUtilsVersion: string;
  shareDigests: Record<ShareName, string>;
  // The owner: the Shamir-split key. The user's account is `smartAccount.address`.
  expectedAddress: string;
  derivationPath: string;
  smartAccount: SmartAccountInfo;
  createdAt: string;
}

export interface SignedManifest {
  manifest: Manifest;
  signature: string;
}

export type RecoverAB = {
  op: 'recover';
  combo: 'A+B';
  signed: SignedManifest;
  encB: Envelope;
  prf: Uint8Array;
};

export type RecoverAC = {
  op: 'recover';
  combo: 'A+C';
  signed: SignedManifest;
  encC: Envelope;
  code: Uint8Array;
};

export type RecoverBC = {
  op: 'recover';
  combo: 'B+C';
  signed: SignedManifest;
  encB: Envelope;
  encC: Envelope;
  prf: Uint8Array;
  code: Uint8Array;
};

/** The kit's seed backup, with the code. No passkey and no server. */
export type RecoverKitCode = {
  op: 'recover';
  combo: 'kit+code';
  signed: SignedManifest;
  seedBackup: SeedBackup;
  code: Uint8Array;
};

export type RecoverRequest = RecoverAB | RecoverAC | RecoverBC | RecoverKitCode;

/** What allows operating without share A: makes no call to the server. */
export type OfflineSource = RecoverBC | RecoverKitCode;

export type EnrollRequest = {
  op: 'enroll';
  userId: string;
  setId: string;
  credentialId: string;
  prf: Uint8Array;
  code: Uint8Array;
  // With source: re-enrollment, same seed.
  source?: RecoverAC | OfflineSource;
  // Owner of this session's active wallet, according to the server. After a relink, the manifest keeps the previous `sub`.
  linkedOwner?: string;
  // From the passkey `create`, so the server can store its public key. No PRF output.
  registration?: RegistrationJson;
};

export type SignRequest = VaultSignRequest;

export type SignWorkerRequest = {
  op: 'sign';
  chainId: number;
  signed: SignedManifest;
  encB: Envelope;
  prf: Uint8Array;
  request: SignRequest;
};

/** Signs the Safe deployment on that network. The main thread submits it to the bundler. */
export type DeployWorkerRequest = {
  op: 'deploy';
  chainId: number;
  signed: SignedManifest;
  encB: Envelope;
  prf: Uint8Array;
  userOperation: UserOperationJson;
};

/**
 * Signs a UserOperation the vault server prepared for one call from the deployed Safe. The worker checks that the
 * operation executes exactly `transaction` (a CALL, never a delegatecall) from this Safe before using the seed.
 */
export type SendTransactionWorkerRequest = {
  op: 'send-transaction';
  chainId: number;
  signed: SignedManifest;
  encB: Envelope;
  prf: Uint8Array;
  transaction: VaultCall;
  userOperation: UserOperationJson;
};

/** Optional seed export. Together with `export-recovered`, the only operations whose response carries `mnemonic`. */
export type ExportWorkerRequest = {
  op: 'export';
  signed: SignedManifest;
  encB: Envelope;
  prf: Uint8Array;
};

/** Signs without share A. Does not ask the chain or the server whether the Safe is deployed, and sends nothing. */
export type SignRecoveredWorkerRequest = {
  op: 'sign-recovered';
  chainId: number;
  source: OfflineSource;
  request: SignRequest;
};

/** Export with B+C or with kit and code. Like `export`, its response carries `mnemonic`. */
export type ExportRecoveredWorkerRequest = {
  op: 'export-recovered';
  source: OfflineSource;
};

/** What the server asks to be signed to link the wallet to this account. */
export interface RelinkChallenge {
  safe: `0x${string}`;
  owner: `0x${string}`;
  newSub: string;
  issuer: string;
  vaultOrigin: string;
  nonce: string;
  expiresAt: number;
}

/** The owner signs the relink. A wallet other than the manifest's never gets to use the seed. */
export type SignRelinkWorkerRequest = {
  op: 'sign-relink';
  source: OfflineSource;
  relink: RelinkChallenge;
};

/** New kit with a seed backup for a wallet that has an old kit. The code is checked by decrypting C. */
export type UpgradeKitWorkerRequest = {
  op: 'upgrade-kit';
  source: RecoverAB | RecoverBC;
  encC: Envelope;
  code: Uint8Array;
};

export type WorkerRequest =
  | EnrollRequest
  | RecoverRequest
  | SignWorkerRequest
  | DeployWorkerRequest
  | SendTransactionWorkerRequest
  | ExportWorkerRequest
  | SignRecoveredWorkerRequest
  | ExportRecoveredWorkerRequest
  | SignRelinkWorkerRequest
  | UpgradeKitWorkerRequest;

/** A request's secret buffers: they are transferred to the worker, which overwrites them. */
export function secretBuffersOf(request: WorkerRequest): Uint8Array[] {
  const ofSource = (source: RecoverRequest): Uint8Array[] => {
    switch (source.combo) {
      case 'A+B':
        return [source.prf];
      case 'A+C':
      case 'kit+code':
        return [source.code];
      case 'B+C':
        return [source.prf, source.code];
    }
  };
  switch (request.op) {
    case 'enroll':
      return [request.prf, request.code, ...(request.source ? ofSource(request.source) : [])];
    case 'sign':
    case 'deploy':
    case 'send-transaction':
    case 'export':
      return [request.prf];
    case 'recover':
      return ofSource(request);
    case 'upgrade-kit':
      return [...ofSource(request.source), request.code];
    default:
      return ofSource(request.source);
  }
}

/** The public key arrives with every request: the server delivers it in the HTML, at runtime. */
export type WorkerMessage = { request: WorkerRequest; manifestPubKey: string; appOrigin?: string | null };

export type Enrolled = {
  signed: SignedManifest;
  encB: Envelope;
  encC: Envelope;
  // Goes in the kit and only in the kit. `CreateSharesBody` has no such field.
  seedBackup: SeedBackup;
};

/** `navigator.credentials.create` response, as JSON. Only `credProps` is read from its extensions: it never carries the PRF output. */
export interface RegistrationJson {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults: { credProps?: { rk?: boolean } };
}

/** `navigator.credentials.get` response, as JSON. No extensions: the PRF output stays in the browser. */
export interface AssertionJson {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
}

export type WorkerResponse =
  | {
      ok: true;
      // The Safe. `owner` is the Shamir-split key.
      address: `0x${string}`;
      owner: `0x${string}`;
      wdkVersionMismatch: boolean;
      signature?: `0x${string}`;
      userOperation?: UserOperationJson;
      enrolled?: Enrolled;
      mnemonic?: string;
      // Only from `upgrade-kit`.
      seedBackup?: SeedBackup;
    }
  | { ok: false; code: WalletErrorCode };

/** Body of `POST /api/shares`. */
export interface CreateSharesBody {
  setId: string;
  credentialId: string;
  shareA: string;
  encB: Envelope;
  encC: Envelope;
  shareDigests: Record<ShareName, string>;
  expectedAddress: string;
  smartAccount: SmartAccountInfo;
  wdkUtilsVersion: string;
  registration?: RegistrationJson;
}

/** Status of the user's Safe on the session's network. */
export interface ChainStatus {
  chainId: number;
  chainName: string;
  /** Symbol of the network's native currency (`ETH`, `POL`…), from the vault's configuration. */
  nativeCurrency: string;
  rpcHost: string;
  deployed: boolean;
  deployable: boolean;
  /** The deployment is sponsored: the chain has a paymaster. */
  sponsored: boolean;
  /** Transactions from the deployed Safe are sponsored too: a paymaster and `sponsorTransactions` in `AA_CHAINS`. */
  transactionsSponsored: boolean;
  bundler: boolean;
  balance: string | null;
}
