import { ed25519 } from '@noble/curves/ed25519.js';
import { hexEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import { buildManifest, signManifest } from '@wl-embedded-wallet/core/manifest';
import { generateRecoveryCode, recoveryCodeToBytes } from '@wl-embedded-wallet/core/recovery-code';
import type { SignerDeps } from '@wl-embedded-wallet/core/signer';
import type { ChainStatus, CreateSharesBody, Envelope, SignedManifest, WorkerResponse } from '@wl-embedded-wallet/core/types';
import { openShareA, sealShareA } from '../../server/kms';

export const USER = 'alice';
export const SET_ID = '11111111-1111-4111-8111-111111111111';
export const CHAIN_ID = 31001;

process.env.MASTER_KEY = hexEncode(randomBytes(32));

export function flipBit(b64url: string): string {
  const bytes = Buffer.from(b64url, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

export function makeKeys() {
  const { secretKey, publicKey } = ed25519.keygen();
  return { signingKey: hexEncode(secretKey), manifestPubKey: hexEncode(publicKey) };
}

export function makeSecrets() {
  const codeText = generateRecoveryCode();
  const prf = randomBytes(32);
  return {
    codeText,
    prf: () => prf.slice(),
    code: () => recoveryCodeToBytes(codeText),
  };
}

/** In-memory server with the real cryptography (`kms` and manifest signing). */
export function makeServer(userId = USER) {
  const keys = makeKeys();
  const sets = new Map<string, { encA: Envelope; body: CreateSharesBody }>();
  const fetched: string[] = [];
  const posted: CreateSharesBody[] = [];
  const chain: { status: ChainStatus } = {
    status: { chainId: CHAIN_ID, chainName: 'Local', nativeCurrency: 'ETH', rpcHost: '127.0.0.1:1', deployed: true, deployable: false, sponsored: true, bundler: true, balance: null },
  };

  const deps: SignerDeps = {
    manifestPubKey: keys.manifestPubKey,
    async fetchShareA(setId) {
      fetched.push(setId);
      const set = sets.get(setId);
      if (!set) throw new Error('not found');
      return openShareA(set.encA, { userId, setId });
    },
    async postShares(body): Promise<SignedManifest> {
      posted.push(body);
      sets.set(body.setId, { encA: await sealShareA(body.shareA, { userId, setId: body.setId }), body });
      const manifest = buildManifest({
        userId,
        setId: body.setId,
        shareDigests: body.shareDigests,
        expectedAddress: body.expectedAddress,
        smartAccount: body.smartAccount,
        wdkUtilsVersion: body.wdkUtilsVersion,
      });
      return signManifest(manifest, keys.signingKey);
    },
    async fetchChainStatus() {
      return chain.status;
    },
  };

  return { ...keys, deps, sets, fetched, posted, chain };
}

export function expectOk(response: WorkerResponse) {
  if (!response.ok) throw new Error(`expected ok, got ${response.code}`);
  return response;
}
