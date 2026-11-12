import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { splitMnemonic } from '@tetherto/wdk-utils';
import {
  buildUserOperation,
  isAllowedTransactionCall,
  isDeploymentOperation,
  isTransactionOperation,
  requestHash,
  safeMessageTypedData,
  signSafeOperation,
  smartAccountFor,
} from './safe';
import type { UserOperationJson } from './operations';
import { openSeedBackup, sealSeedBackup } from './seed-backup';
import { mnemonicToAccount } from 'viem/accounts';
import { hexDecode, hexEncode, zero } from './encoding';
import { openShareB, sealShareB } from './envelope';
import {
  assertManifestFormat,
  assertSmartAccount,
  canonicalize,
  DERIVATION_PATH,
  deriveAddress,
  matchesExpectedWallet,
  SHARES_K,
  SHARES_N,
  shareDigest,
  verifyManifest,
  verifyShare,
  WDK_UTILS_VERSION,
} from './manifest';
import { DEFAULT_ARGON2_PARAMS, openShareC, parseArgon2Params, sealShareC } from './recovery-code';
import { relinkTypedData } from './relink';
import {
  WalletError,
  type ChainStatus,
  type CreateSharesBody,
  type DeployWorkerRequest,
  type EnrollRequest,
  type Envelope,
  type ExportWorkerRequest,
  type Manifest,
  type WalletErrorCode,
  secretBuffersOf,
  type ExportRecoveredWorkerRequest,
  type RecoverKitCode,
  type RecoverRequest,
  type SeedBackup,
  type SendTransactionWorkerRequest,
  type ShareName,
  type SignedManifest,
  type SignRecoveredWorkerRequest,
  type SignRelinkWorkerRequest,
  type SignRequest,
  type SignWorkerRequest,
  type UpgradeKitWorkerRequest,
  type WorkerRequest,
  type WorkerResponse,
} from './types';
import { recoverMnemonic, verifyRecovery } from './shamir';

/** What the worker injects. Tests pass in-memory implementations. */
export interface SignerDeps {
  manifestPubKey: string;
  fetchShareA(setId: string): Promise<string>;
  postShares(body: CreateSharesBody): Promise<SignedManifest>;
  /** Status on the session's network. The worker asks the server for it; the page does not supply it. */
  fetchChainStatus(): Promise<ChainStatus>;
}

const SEED_STRENGTH_BITS = 128;

function shareToBytes(share: string): Uint8Array<ArrayBuffer> {
  try {
    return hexDecode(share);
  } catch {
    throw new WalletError('SHARE_TAMPERED');
  }
}

async function decryptToHex(open: () => Promise<Uint8Array>): Promise<string> {
  const plaintext = await open();
  try {
    return hexEncode(plaintext);
  } finally {
    zero(plaintext);
  }
}

function decryptB(encB: Envelope, prf: Uint8Array, manifest: Manifest): Promise<string> {
  return decryptToHex(() => openShareB(encB, prf, manifest));
}

function decryptC(encC: Envelope, code: Uint8Array, manifest: Manifest): Promise<string> {
  return decryptToHex(() => openShareC(encC, code, manifest));
}

async function loadShares(req: Exclude<RecoverRequest, RecoverKitCode>, deps: SignerDeps): Promise<Map<string, ShareName>> {
  const { manifest } = req.signed;
  // Local shares are decrypted first: a wrong passkey or code never gets as far as requesting A from the server.
  switch (req.combo) {
    case 'A+B': {
      const shareB = await decryptB(req.encB, req.prf, manifest);
      return new Map([[await deps.fetchShareA(manifest.setId), 'A'], [shareB, 'B']]);
    }
    case 'A+C': {
      const shareC = await decryptC(req.encC, req.code, manifest);
      return new Map([[await deps.fetchShareA(manifest.setId), 'A'], [shareC, 'C']]);
    }
    case 'B+C': {
      const shareB = await decryptB(req.encB, req.prf, manifest);
      const shareC = await decryptC(req.encC, req.code, manifest);
      return new Map([[shareB, 'B'], [shareC, 'C']]);
    }
  }
}

/** Fixed order: signature → format → decryption → per-share digest → `combineMnemonic` → address. */
async function recoverSeed(req: RecoverRequest, deps: SignerDeps): Promise<string> {
  verifyManifest(req.signed, deps.manifestPubKey);
  const { manifest } = req.signed;
  assertManifestFormat(manifest);
  assertSmartAccount(manifest);
  if (req.combo === 'kit+code') {
    // No shares: the backup is authenticated by the code and the AAD, and it must still be the manifest's wallet.
    const mnemonic = await openSeedBackup(req.seedBackup, req.code, manifest.expectedAddress);
    if (!matchesExpectedWallet(mnemonic, manifest)) throw new WalletError('ADDRESS_MISMATCH');
    return mnemonic;
  }
  const shares = await loadShares(req, deps);
  return recoverMnemonic([...shares.keys()], {
    threshold: manifest.k,
    verifyShare: (share) => verifyShare(share, shares.get(share)!, manifest),
    matchesExpectedWallet: (mnemonic) => matchesExpectedWallet(mnemonic, manifest),
  });
}

function identity(manifest: Manifest): { address: `0x${string}`; owner: `0x${string}` } {
  return { address: manifest.smartAccount.address, owner: manifest.expectedAddress as `0x${string}` };
}

/** Encrypts the backup and opens it again before continuing: a kit that does not open is useless on the day it is needed. */
async function sealVerifiedBackup(mnemonic: string, code: Uint8Array, owner: string, params = DEFAULT_ARGON2_PARAMS): Promise<SeedBackup> {
  const seedBackup = await sealSeedBackup(mnemonic, code, owner, params);
  if ((await openSeedBackup(seedBackup, code, owner)) !== mnemonic) throw new WalletError('INTERNAL');
  return seedBackup;
}

async function enroll(req: EnrollRequest, deps: SignerDeps): Promise<WorkerResponse> {
  const { userId, setId, credentialId, prf, code, source, linkedOwner, registration } = req;
  // Another user's kit is not a rotation, unless it is the wallet the server has already linked to this session.
  if (source && source.signed.manifest.userId !== userId && source.signed.manifest.expectedAddress !== linkedOwner) {
    throw new WalletError('MANIFEST_INVALID');
  }

  const mnemonic = source ? await recoverSeed(source, deps) : generateMnemonic(wordlist, SEED_STRENGTH_BITS);
  const expectedAddress = deriveAddress(mnemonic);
  // A rotation keeps the signed parameters, and with them the Safe address.
  const smartAccount = source ? source.signed.manifest.smartAccount : smartAccountFor(expectedAddress);
  const [shareA, shareB, shareC] = await splitMnemonic(mnemonic, { shares: SHARES_N, threshold: SHARES_K });
  const names = new Map<string, ShareName>([[shareA, 'A'], [shareB, 'B'], [shareC, 'C']]);
  const shareDigests: Record<ShareName, string> = {
    A: await shareDigest(shareA),
    B: await shareDigest(shareB),
    C: await shareDigest(shareC),
  };

  const verify = async (share: string) => (await shareDigest(share)) === shareDigests[names.get(share)!];
  for (const pair of [[shareA, shareB], [shareA, shareC], [shareB, shareC]]) {
    await verifyRecovery(mnemonic, pair, { threshold: SHARES_K, verifyShare: verify });
  }

  const bytesB = shareToBytes(shareB);
  const bytesC = shareToBytes(shareC);
  let encB: Envelope;
  let encC: Envelope;
  try {
    encB = await sealShareB(bytesB, prf, { userId, setId });
    encC = await sealShareC(bytesC, code, { userId, setId });
  } finally {
    zero(bytesB, bytesC);
  }

  // Same parameters as C, with its own salt and nonce. Checked before anything is sent to the server.
  const seedBackup = await sealVerifiedBackup(mnemonic, code, expectedAddress, parseArgon2Params(encC.kdfParams));

  const signed = await deps.postShares({
    setId,
    credentialId,
    shareA,
    encB,
    encC,
    shareDigests,
    expectedAddress,
    smartAccount,
    wdkUtilsVersion: WDK_UTILS_VERSION,
    ...(registration ? { registration } : {}),
  });

  verifyManifest(signed, deps.manifestPubKey);
  assertManifestFormat(signed.manifest);
  assertSmartAccount(signed.manifest);
  const { manifest } = signed;
  if (
    manifest.userId !== userId ||
    manifest.setId !== setId ||
    manifest.expectedAddress !== expectedAddress ||
    canonicalize(manifest.smartAccount) !== canonicalize(smartAccount) ||
    canonicalize(manifest.shareDigests) !== canonicalize(shareDigests)
  ) {
    throw new WalletError('MANIFEST_INVALID');
  }

  return {
    ok: true,
    ...identity(manifest),
    wdkVersionMismatch: manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
    enrolled: { signed, encB, encC, seedBackup },
  };
}

function assertSignRequest(request: SignRequest): void {
  const known =
    (request?.kind === 'message' && typeof request.message === 'string') ||
    (request?.kind === 'typedData' && typeof request.typedData === 'object' && request.typedData !== null) ||
    (request?.kind === 'userOperation' && typeof request.userOperation === 'object' && request.userOperation !== null);
  if (!known) throw new WalletError('INTERNAL');
}

function ownerSigner(mnemonic: string) {
  const account = mnemonicToAccount(mnemonic, { path: DERIVATION_PATH });
  return { account, signer: { address: account.address, signHash: (hash: `0x${string}`) => account.sign({ hash }) } };
}

async function signWithSeed(mnemonic: string, manifest: Manifest, chainId: number, request: SignRequest) {
  const { account, signer } = ownerSigner(mnemonic);
  const { smartAccount } = manifest;
  if (request.kind === 'userOperation') {
    const operation = buildUserOperation(smartAccount.address, request.userOperation, smartAccount);
    const signature = (await signSafeOperation(operation, chainId, smartAccount, signer)) as `0x${string}`;
    return { signature, userOperation: { ...operation, signature } };
  }
  // Safe signature: the owner signs the `SafeMessage` of the hash, bound to this Safe and this network.
  return { signature: await account.signTypedData(safeMessageTypedData(smartAccount.address, chainId, requestHash(request))) };
}

/** The actual gate: a signature only exists on a network where the Safe is deployed. */
async function assertChain(chainId: number, deps: SignerDeps): Promise<ChainStatus> {
  const status = await deps.fetchChainStatus();
  if (status.chainId !== chainId) throw new WalletError('CHAIN_MISMATCH');
  return status;
}

/** Reconstructs with A+B for this signature only. Sends nothing to the chain. */
async function sign(req: SignWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  assertSignRequest(req.request);
  const { signed, encB, prf, chainId } = req;
  const status = await assertChain(chainId, deps);
  if (!status.deployed) throw new WalletError('WALLET_NOT_DEPLOYED');
  const mnemonic = await recoverSeed({ op: 'recover', combo: 'A+B', signed, encB, prf }, deps);
  return {
    ok: true,
    ...identity(signed.manifest),
    wdkVersionMismatch: signed.manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
    ...(await signWithSeed(mnemonic, signed.manifest, chainId, req.request)),
  };
}

/** Only signs the deployment of this owner's Safe. Anything else never gets to use the seed. */
async function deploy(req: DeployWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  const { signed, encB, prf, chainId, userOperation } = req;
  verifyManifest(signed, deps.manifestPubKey);
  const { manifest } = signed;
  assertSmartAccount(manifest);
  const status = await assertChain(chainId, deps);
  if (status.deployed || !status.deployable) throw new WalletError('CHAIN_NOT_SUPPORTED');
  if (!isDeploymentOperation(userOperation as UserOperationJson, manifest.expectedAddress, manifest.smartAccount)) {
    throw new WalletError('INTERNAL');
  }
  const mnemonic = await recoverSeed({ op: 'recover', combo: 'A+B', signed, encB, prf }, deps);
  const signature = (await signSafeOperation(userOperation, chainId, manifest.smartAccount, ownerSigner(mnemonic).signer)) as `0x${string}`;
  return {
    ok: true,
    ...identity(manifest),
    wdkVersionMismatch: manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
    signature,
    userOperation: { ...userOperation, signature },
  };
}

/**
 * Only signs an operation that executes exactly the reviewed call from this deployed Safe. The server chose nonce,
 * gas, fees and paymaster, which the page showed; the call itself is checked here, before the seed exists.
 */
async function sendTransaction(req: SendTransactionWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  const { signed, encB, prf, chainId, transaction, userOperation } = req;
  verifyManifest(signed, deps.manifestPubKey);
  const { manifest } = signed;
  assertSmartAccount(manifest);
  const safe = manifest.smartAccount.address;
  if (!isAllowedTransactionCall(safe, transaction)) throw new WalletError('CALL_NOT_ALLOWED');
  if (!isTransactionOperation(userOperation as UserOperationJson, transaction, safe, manifest.smartAccount)) throw new WalletError('INTERNAL');
  const status = await assertChain(chainId, deps);
  if (!status.deployed) throw new WalletError('WALLET_NOT_DEPLOYED');
  const mnemonic = await recoverSeed({ op: 'recover', combo: 'A+B', signed, encB, prf }, deps);
  const signature = (await signSafeOperation(userOperation, chainId, manifest.smartAccount, ownerSigner(mnemonic).signer)) as `0x${string}`;
  return {
    ok: true,
    ...identity(manifest),
    wdkVersionMismatch: manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
    signature,
    userOperation: { ...userOperation, signature },
  };
}

/** Same checks as `sign`. Only this response (and `export-recovered`'s) carries the seed, and only the vault's main thread uses it. */
async function exportSeed(req: ExportWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  const { signed, encB, prf } = req;
  const mnemonic = await recoverSeed({ op: 'recover', combo: 'A+B', signed, encB, prf }, deps);
  return {
    ok: true,
    ...identity(signed.manifest),
    wdkVersionMismatch: signed.manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
    mnemonic,
  };
}

const recovered = (signed: SignedManifest) => ({
  ok: true as const,
  ...identity(signed.manifest),
  wdkVersionMismatch: signed.manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
});

/** Without share A. The chain is not queried: the signature is only valid if the Safe is deployed on that network. */
async function signRecovered(req: SignRecoveredWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  assertSignRequest(req.request);
  if (!Number.isSafeInteger(req.chainId) || req.chainId <= 0) throw new WalletError('CHAIN_NOT_SUPPORTED');
  const mnemonic = await recoverSeed(req.source, deps);
  return { ...recovered(req.source.signed), ...(await signWithSeed(mnemonic, req.source.signed.manifest, req.chainId, req.request)) };
}

async function exportRecovered(req: ExportRecoveredWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  return { ...recovered(req.source.signed), mnemonic: await recoverSeed(req.source, deps) };
}

/** A direct owner signature, not a Safe signature: the server verifies it without depending on any network. */
async function signRelink(req: SignRelinkWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  const { relink, source } = req;
  const { manifest } = source.signed;
  if (relink.owner.toLowerCase() !== manifest.expectedAddress.toLowerCase() || relink.safe.toLowerCase() !== manifest.smartAccount.address.toLowerCase()) {
    throw new WalletError('ADDRESS_MISMATCH');
  }
  const mnemonic = await recoverSeed(source, deps);
  const { account } = ownerSigner(mnemonic);
  return { ...recovered(source.signed), signature: await account.signTypedData(relinkTypedData(relink)) };
}

/** The code is not stored, so it must be requested, and C tells whether it belongs to this set. */
async function upgradeKit(req: UpgradeKitWorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  const { source, encC, code } = req;
  const mnemonic = await recoverSeed(source, deps);
  const { manifest } = source.signed;
  const shareC = await decryptC(encC, code, manifest);
  if (!(await verifyShare(shareC, 'C', manifest))) throw new WalletError('SHARE_TAMPERED');
  const seedBackup = await sealVerifiedBackup(mnemonic, code, manifest.expectedAddress, parseArgon2Params(encC.kdfParams));
  return { ...recovered(source.signed), seedBackup };
}

function toErrorCode(error: unknown): WalletErrorCode {
  return error instanceof WalletError ? error.code : 'INTERNAL';
}

function wipeRequest(req: WorkerRequest): void {
  zero(...secretBuffersOf(req));
}

/**
 * Worker entry point. Never throws, and an error response carries only the code.
 * The seed does not leave here: a successful response carries the address (and any signature), never
 * the seed, except for the explicit `export` and `export-recovered` operations, which return `mnemonic`.
 */
export async function handleWorkerRequest(req: WorkerRequest, deps: SignerDeps): Promise<WorkerResponse> {
  try {
    if (req.op === 'enroll') return await enroll(req, deps);
    if (req.op === 'sign') return await sign(req, deps);
    if (req.op === 'deploy') return await deploy(req, deps);
    if (req.op === 'send-transaction') return await sendTransaction(req, deps);
    if (req.op === 'export') return await exportSeed(req, deps);
    if (req.op === 'sign-recovered') return await signRecovered(req, deps);
    if (req.op === 'export-recovered') return await exportRecovered(req, deps);
    if (req.op === 'sign-relink') return await signRelink(req, deps);
    if (req.op === 'upgrade-kit') return await upgradeKit(req, deps);
    await recoverSeed(req, deps);
    const { manifest } = req.signed;
    return {
      ok: true,
      ...identity(manifest),
      wdkVersionMismatch: manifest.wdkUtilsVersion !== WDK_UTILS_VERSION,
    };
  } catch (error) {
    return { ok: false, code: toErrorCode(error) };
  } finally {
    wipeRequest(req);
  }
}
