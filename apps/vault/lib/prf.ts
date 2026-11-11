import { b64urlDecode, b64urlEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import { passkeyUserHandle, prfSalt } from '@wl-embedded-wallet/core/prf';
import { readRuntimeConfig } from './runtime-config';
import type { AssertionJson, RegistrationJson } from '@wl-embedded-wallet/core/types';

const PRF_OUTPUT_BYTES = 32;
const TIMEOUT_MS = 60_000;

export type PrfSource = 'create' | 'get';
export type PrfFailure = 'PRF_UNSUPPORTED' | 'PRF_NOT_RETURNED' | 'CANCELLED' | 'WEBAUTHN_FAILED';

const FAILURE_MESSAGES: Record<PrfFailure, string> = {
  PRF_UNSUPPORTED: 'This passkey does not support the PRF extension. Try another provider: there is no fallback.',
  PRF_NOT_RETURNED: 'The passkey provider claims to support PRF but returned no result.',
  CANCELLED: 'The passkey operation was cancelled or timed out.',
  WEBAUTHN_FAILED: 'The passkey operation failed.',
};

export class PrfError extends Error {
  readonly reason: PrfFailure;

  constructor(reason: PrfFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = 'PrfError';
    this.reason = reason;
  }
}

export { passkeyUserHandle, prfSalt };

export interface RegisteredPasskey {
  credentialId: string;
  prfOutput: Uint8Array<ArrayBuffer>;
  prfSource: PrfSource;
  // Only if the server issued the challenge. That is what lets it store the public key.
  registration?: RegistrationJson;
}

function toPrfBytes(result: BufferSource | undefined): Uint8Array<ArrayBuffer> | undefined {
  if (!result) return undefined;
  const bytes = ArrayBuffer.isView(result)
    ? new Uint8Array(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer)
    : new Uint8Array(result);
  return bytes.length === PRF_OUTPUT_BYTES ? bytes : undefined;
}

async function callWebAuthn<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrfError) throw error;
    const name = (error as { name?: string } | undefined)?.name;
    throw new PrfError(name === 'NotAllowedError' || name === 'AbortError' ? 'CANCELLED' : 'WEBAUTHN_FAILED');
  }
}

export async function getPrfOutput(
  credentialId: string,
  options: { rpId?: string; credentials?: CredentialsContainer } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const credentials = options.credentials ?? navigator.credentials;
  const assertion = (await callWebAuthn(async () =>
    credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: options.rpId ?? readRuntimeConfig().rpId,
        allowCredentials: [{ type: 'public-key', id: b64urlDecode(credentialId) }],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: await prfSalt() } } },
      },
    }),
  )) as PublicKeyCredential | null;
  const output = toPrfBytes(assertion?.getClientExtensionResults().prf?.results?.first);
  if (!output) throw new PrfError('PRF_NOT_RETURNED');
  return output;
}

function toB64url(buffer: ArrayBuffer | null | undefined): string | undefined {
  return buffer ? b64urlEncode(new Uint8Array(buffer)) : undefined;
}

/** Copies field by field: the browser's `toJSON()` could include the PRF output, which is secret. */
function registrationJson(credential: PublicKeyCredential): RegistrationJson {
  const response = credential.response as AuthenticatorAttestationResponse;
  const id = b64urlEncode(new Uint8Array(credential.rawId));
  const results = credential.getClientExtensionResults() as { credProps?: { rk?: boolean } };
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: toB64url(response.clientDataJSON) as string,
      attestationObject: toB64url(response.attestationObject) as string,
      ...(response.getTransports ? { transports: response.getTransports() } : {}),
    },
    clientExtensionResults: results.credProps ? { credProps: { rk: results.credProps.rk } } : {},
  };
}

export interface DiscoveredPasskey {
  assertion: AssertionJson;
  // Stays in the browser: the assertion sent to the server does not carry it.
  prfOutput: Uint8Array<ArrayBuffer>;
  credentialId: string;
}

/** No `allowCredentials`: the user picks their passkey without saying who they are. A single assertion yields both the identity and the PRF. */
export async function discoverPasskey(
  challenge: string,
  options: { rpId?: string; credentials?: CredentialsContainer } = {},
): Promise<DiscoveredPasskey> {
  const credentials = options.credentials ?? navigator.credentials;
  const credential = (await callWebAuthn(async () =>
    credentials.get({
      publicKey: {
        challenge: b64urlDecode(challenge),
        rpId: options.rpId ?? readRuntimeConfig().rpId,
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: await prfSalt() } } },
      },
    }),
  )) as PublicKeyCredential | null;
  if (!credential) throw new PrfError('WEBAUTHN_FAILED');
  const prfOutput = toPrfBytes(credential.getClientExtensionResults().prf?.results?.first);
  if (!prfOutput) throw new PrfError('PRF_NOT_RETURNED');
  const response = credential.response as AuthenticatorAssertionResponse;
  const credentialId = b64urlEncode(new Uint8Array(credential.rawId));
  const userHandle = toB64url(response.userHandle);
  return {
    credentialId,
    prfOutput,
    assertion: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: toB64url(response.clientDataJSON) as string,
        authenticatorData: toB64url(response.authenticatorData) as string,
        signature: toB64url(response.signature) as string,
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
    },
  };
}

/** No fallback: if the passkey does not provide PRF, enrollment is aborted. */
export async function registerPasskeyWithPrf(options: {
  userId: string;
  setId: string;
  rpId?: string;
  rpName?: string;
  credentials?: CredentialsContainer;
  // Server challenge, in b64url. Without it, the public key cannot be registered.
  challenge?: string;
}): Promise<RegisteredPasskey> {
  const { userId, setId } = options;
  const rpId = options.rpId ?? readRuntimeConfig().rpId;
  const credentials = options.credentials ?? navigator.credentials;

  const credential = (await callWebAuthn(async () =>
    credentials.create({
      publicKey: {
        challenge: options.challenge ? b64urlDecode(options.challenge) : randomBytes(32),
        rp: { id: rpId, name: options.rpName ?? readRuntimeConfig().brand },
        user: { id: await passkeyUserHandle(userId, setId), name: userId, displayName: userId },
        pubKeyCredParams: [
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        timeout: TIMEOUT_MS,
        extensions: { credProps: true, prf: { eval: { first: await prfSalt() } } },
      },
    }),
  )) as PublicKeyCredential | null;
  if (!credential) throw new PrfError('WEBAUTHN_FAILED');
  const registration = options.challenge ? registrationJson(credential) : undefined;

  const credentialId = b64urlEncode(new Uint8Array(credential.rawId));
  const prf = credential.getClientExtensionResults().prf;

  const fromCreate = toPrfBytes(prf?.results?.first);
  if (fromCreate) return { credentialId, prfOutput: fromCreate, prfSource: 'create', ...(registration ? { registration } : {}) };
  if (prf?.enabled !== true) throw new PrfError('PRF_UNSUPPORTED');

  const fromGet = await getPrfOutput(credentialId, { rpId, credentials });
  return { credentialId, prfOutput: fromGet, prfSource: 'get', ...(registration ? { registration } : {}) };
}
