import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

// Without the SDK, with any supported algorithm: EdDSA, ES256 or RS256.
export async function createSigner(alg: 'EdDSA' | 'ES256' | 'RS256', kid: string) {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return { alg, kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

// GET /.well-known/jwks.json. `jwk` only holds the public part.
export function jwksResponse(signers: { jwk: object }[]): Response {
  return Response.json({ keys: signers.map(({ jwk }) => jwk) }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}

export function mintVaultToken(
  signer: { alg: string; kid: string; privateKey: CryptoKey },
  user: { id: string; email: string },
  config: { iss: string; aud: string; origin: string },
): Promise<string> {
  return new SignJWT({ label: user.email, origin: config.origin })
    .setProtectedHeader({ alg: signer.alg, kid: signer.kid, typ: 'JWT' })
    .setIssuer(config.iss)
    .setAudience(config.aud)
    .setSubject(user.id)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(signer.privateKey);
}
