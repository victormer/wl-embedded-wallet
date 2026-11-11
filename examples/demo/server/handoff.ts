import { createHandoffToken, ed25519PublicJwk, handoffPublicJwk, type HandoffClaims, type HandoffPublicJwk } from '@wl-embedded-wallet/sdk/server';

interface HandoffConfig {
  privateKey: string;
  kid: string;
  // The login shared across apps, the same in all of them. The `origin` is specific to each app.
  issuer: string;
  audience: string;
  origin: string;
}

/** `null` if anything is missing: the token and JWKS endpoints respond with an error, without further detail. */
export function handoffConfig(): HandoffConfig | null {
  const { DEMO_HANDOFF_PRIVATE_KEY: privateKey, DEMO_HANDOFF_KID: kid, ORIGIN: origin, VAULT_ORIGIN: audience } = process.env;
  const issuer = process.env.DEMO_HANDOFF_ISSUER || origin;
  return privateKey && kid && issuer && audience && origin ? { privateKey, kid, issuer, audience, origin } : null;
}

/**
 * Dedicated token for the vault, issued from the already authenticated session. It is not the demo's
 * session cookie. `origin` comes from configuration, never from the client: it authorizes this app to use the wallet.
 */
export function mintVaultToken(user: { id: string; email: string }, chain?: HandoffClaims['chain']): string {
  const config = handoffConfig();
  if (!config) throw new Error('Handoff token configuration is missing');
  return createHandoffToken(
    { sub: user.id, label: user.email, iss: config.issuer, aud: config.audience, origin: config.origin, kid: config.kid, ...(chain ? { chain } : {}) },
    config.privateKey,
  );
}

/** The signing key, plus the ones that stay published during a rotation. Never private material. */
export function publishedJwks(): { keys: HandoffPublicJwk[] } | null {
  const config = handoffConfig();
  if (!config) return null;
  try {
    const others = JSON.parse(process.env.DEMO_HANDOFF_PUBLISHED_KEYS || '[]') as { kid: string; publicKey: string }[];
    return { keys: [handoffPublicJwk(config.privateKey, config.kid), ...others.map(({ kid, publicKey }) => ed25519PublicJwk(publicKey, kid))] };
  } catch {
    return null;
  }
}
