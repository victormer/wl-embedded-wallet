// `@wl-embedded-wallet/sdk/server`: everything an integrator backend (Node.js) needs.
// - Handoff tokens: the short-lived, single-use JWT that lets the vault popup act for a signed-in user.
// - JWKS publication, so the vault can verify those tokens.
// - The server-to-server account client.
// - Safe 4337 helpers to verify the signatures the vault returns (ERC-1271 and UserOperations).
// Keys are always passed as arguments: nothing here reads the environment.

export { createHandoffToken, ed25519PublicJwk, HANDOFF_TTL_SECONDS, HandoffError, handoffPublicJwk, type HandoffClaims, type HandoffPublicJwk } from './handoff';
export { createHandoffSigner, generateHandoffSigner, type HandoffAlgorithm, type HandoffSigner, type HandoffTokenInput, type PublicHandoffJwk } from './signer';
export { jwks, jwksHandler, jwksResponse, JWKS_MAX_AGE_SECONDS, type Jwks } from './jwks';
export { createVaultServiceClient, VaultUnavailableError, type VaultServiceAccount, type VaultServiceClient, type VaultServiceClientOptions } from './service-client';
export * from '@wl-embedded-wallet/core/safe';
export type { TypedDataRequest, UserOperationJson, UserOperationRequest, VaultCall, VaultSignRequest } from '@wl-embedded-wallet/core/operations';
