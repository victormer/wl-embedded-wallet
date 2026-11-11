import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { b64urlDecode, b64urlEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import { isB64url, isRecord } from '@wl-embedded-wallet/core/schema';
import type { AssertionJson, RegistrationJson } from '@wl-embedded-wallet/core/types';
import { consumeWebauthnChallenge, createWebauthnChallenge, type ShareSetRecord, type WebauthnPurpose } from './store';

const CHALLENGE_BYTES = 32;
// The `recover` one is used right away. The `register` one waits for the user to save their code, and lasts at most as long as the session.
const CHALLENGE_TTL_MS: Record<WebauthnPurpose, number> = { recover: 5 * 60 * 1000, register: 15 * 60 * 1000 };

/** The reason never leaves here: the caller always responds the same way. */
export class CredentialRejected extends Error {
  constructor() {
    super('CREDENTIAL_REJECTED');
    this.name = 'CredentialRejected';
  }
}

function relyingParty(): { expectedOrigin: string; expectedRPID: string } {
  const expectedOrigin = process.env.ORIGIN;
  const expectedRPID = process.env.RP_ID;
  if (!expectedOrigin || !expectedRPID) throw new CredentialRejected();
  return { expectedOrigin, expectedRPID };
}

/** `null` when `maxLive` unexpired challenges of that purpose already exist: nothing is stored then. */
export async function issueChallenge(purpose: WebauthnPurpose, userId: string | null, options: { maxLive?: number } = {}): Promise<string | null> {
  const challenge = b64urlEncode(randomBytes(CHALLENGE_BYTES));
  return (await createWebauthnChallenge(challenge, purpose, userId, CHALLENGE_TTL_MS[purpose], options.maxLive)) ? challenge : null;
}

function challengeOf(clientDataJSON: string): string | null {
  try {
    const { challenge } = JSON.parse(new TextDecoder().decode(b64urlDecode(clientDataJSON))) as { challenge?: unknown };
    return isB64url(challenge, 256) ? challenge : null;
  } catch {
    return null;
  }
}

/** Single-use challenge: it is spent before verifying, even if verification then fails. */
async function spendChallenge(clientDataJSON: string, purpose: WebauthnPurpose, userId: string | null): Promise<string> {
  const challenge = challengeOf(clientDataJSON);
  if (!challenge || !(await consumeWebauthnChallenge(challenge, purpose, userId))) throw new CredentialRejected();
  return challenge;
}

function isRegistration(value: unknown): value is RegistrationJson {
  if (!isRecord(value) || !isRecord(value.response) || value.type !== 'public-key') return false;
  return isB64url(value.id, 1024) && value.rawId === value.id && isB64url(value.response.clientDataJSON, 8192) && isB64url(value.response.attestationObject, 65536);
}

export function isAssertion(value: unknown): value is AssertionJson {
  if (!isRecord(value) || !isRecord(value.response) || value.type !== 'public-key') return false;
  const { clientDataJSON, authenticatorData, signature } = value.response;
  return isB64url(value.id, 1024) && value.rawId === value.id && isB64url(clientDataJSON, 8192) && isB64url(authenticatorData, 8192) && isB64url(signature, 8192);
}

/**
 * Checks challenge, origin, RP ID and user verification with `@simplewebauthn/server`, and returns the public key.
 * `credProps.rk` is declared by the browser, unsigned: the real guarantee is `residentKey: 'required'` at creation.
 */
export async function verifyRegistration(registration: unknown, credentialId: unknown, userId: string): Promise<{ publicKey: string; counter: number }> {
  if (!isRegistration(registration) || registration.id !== credentialId) throw new CredentialRejected();
  if (registration.clientExtensionResults?.credProps?.rk === false) throw new CredentialRejected();
  const expectedChallenge = await spendChallenge(registration.response.clientDataJSON, 'register', userId);
  try {
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: { ...registration, clientExtensionResults: {} } as unknown as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge,
      ...relyingParty(),
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!verified || registrationInfo.credential.id !== credentialId) throw new CredentialRejected();
    return { publicKey: b64urlEncode(registrationInfo.credential.publicKey), counter: registrationInfo.credential.counter };
  } catch {
    throw new CredentialRejected();
  }
}

/** Challenge, origin, RP ID, signature with the stored key, user verification and counter. Returns the new counter. */
export async function verifyAssertion(assertion: AssertionJson, set: ShareSetRecord): Promise<number> {
  if (!set.credential) throw new CredentialRejected();
  try {
    const expectedChallenge = challengeOf(assertion.response.clientDataJSON);
    if (!expectedChallenge) throw new CredentialRejected();
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: assertion as unknown as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge,
      ...relyingParty(),
      credential: { id: set.credentialId, publicKey: b64urlDecode(set.credential.publicKey), counter: set.credential.counter },
      requireUserVerification: true,
    });
    if (!verified) throw new CredentialRejected();
    return authenticationInfo.newCounter;
  } catch {
    throw new CredentialRejected();
  }
}

export { spendChallenge };
