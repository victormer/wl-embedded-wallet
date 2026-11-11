import { createHandoffToken, handoffPublicJwk, type HandoffClaims } from '@wl-embedded-wallet/sdk/server';

function config() {
  const { VAULT_HANDOFF_PRIVATE_KEY: privateKey, VAULT_HANDOFF_KID: kid, LOGIN_ISSUER: iss, VAULT_ORIGIN: aud, APP_ORIGIN: origin } = process.env;
  if (!privateKey || !kid || !iss || !aud || !origin) throw new Error('Missing handoff token configuration');
  return { privateKey, kid, iss, aud, origin };
}

// `origin` comes from your configuration, never from what the client sends: it authorizes that app to use the wallet.
// The user is already authenticated by your backend, with 2FA. `id` is stable and matches ^[A-Za-z0-9_-]{1,64}$.
export function mintVaultToken(user: { id: string; email: string }, chain?: HandoffClaims['chain']): string {
  const { privateKey, kid, iss, aud, origin } = config();
  return createHandoffToken({ sub: user.id, label: user.email, iss, aud, origin, kid, ...(chain ? { chain } : {}) }, privateKey);
}

// GET /.well-known/jwks.json. Public: public keys only.
export function jwksResponse(): Response {
  const { privateKey, kid } = config();
  return Response.json({ keys: [handoffPublicJwk(privateKey, kid)] }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
