// Generates the secrets for a new deployment. No dependencies, so it also runs inside the image:
//   docker run --rm IMAGE node scripts/generate-secrets.mjs > .env
// stdout is the vault's environment. The handoff key goes to stderr, so that redirecting stdout
// never leaves it next to the vault: it belongs to the integrator's backend, which publishes its
// public part in its JWKS. It is optional: the integrator may use its own EdDSA, ES256 or RS256 key.
// Its variable names are those of packages/sdk/examples/mint-token.ts; the bundled demo reads other names, which the
// output also lists. The vault reads none of them.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

const hex = (bytes) => randomBytes(bytes).toString('hex');
const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('hex');

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: fromBase64Url(publicKey.export({ format: 'jwk' }).x), privateKey: fromBase64Url(privateKey.export({ format: 'jwk' }).d) };
}

const manifest = ed25519();
const handoff = ed25519();
const serviceToken = hex(32);

console.log(
  [
    '# Vault. Store this as a secret: losing MASTER_KEY or MANIFEST_SIGNING_KEY affects every user.',
    `MASTER_KEY=${hex(32)}`,
    `MANIFEST_SIGNING_KEY=${manifest.privateKey}`,
    `VAULT_SERVICE_TOKEN=${serviceToken}`,
    `POSTGRES_PASSWORD=${hex(24)}`,
  ].join('\n'),
);
console.error(
  [
    '',
    '# Integrator backend. Never put this in the vault or in the browser.',
    '# Names as read by packages/sdk/examples/mint-token.ts; your backend may store them under any name.',
    '# The bundled demo (examples/demo) reads the key and kid as DEMO_HANDOFF_PRIVATE_KEY and DEMO_HANDOFF_KID.',
    `VAULT_HANDOFF_PRIVATE_KEY=${handoff.privateKey}`,
    `VAULT_HANDOFF_KID=handoff-${createHash('sha256').update(handoff.publicKey).digest('hex').slice(0, 16)}`,
    `VAULT_SERVICE_TOKEN=${serviceToken}`,
  ].join('\n'),
);
