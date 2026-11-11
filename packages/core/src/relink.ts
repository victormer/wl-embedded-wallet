import type { RelinkChallenge } from './types';

export const RELINK_PURPOSE = 'wl-embedded-wallet/relink-wallet/v1';

// No `chainId` and no contract: relinking does not depend on any network.
const DOMAIN = { name: 'wl-embedded-wallet/relink-wallet', version: '1' } as const;

const TYPES = {
  WalletRelink: [
    { name: 'purpose', type: 'string' },
    { name: 'safe', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'newSub', type: 'string' },
    { name: 'issuer', type: 'string' },
    { name: 'vaultOrigin', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

/** The server rebuilds this from its own values: the browser supplies only the signature. */
export function relinkTypedData(challenge: RelinkChallenge) {
  return {
    domain: DOMAIN,
    types: TYPES,
    primaryType: 'WalletRelink' as const,
    message: {
      purpose: RELINK_PURPOSE,
      safe: challenge.safe,
      owner: challenge.owner,
      newSub: challenge.newSub,
      issuer: challenge.issuer,
      vaultOrigin: challenge.vaultOrigin,
      nonce: challenge.nonce,
      expiresAt: BigInt(challenge.expiresAt),
    },
  };
}
