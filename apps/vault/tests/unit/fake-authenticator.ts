import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { AssertionJson, RegistrationJson } from '@wl-embedded-wallet/core/types';

const b64 = (bytes: Uint8Array | Buffer | string) => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array | Buffer | string) => createHash('sha256').update(bytes).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function cborBytes(bytes: Buffer): Buffer {
  const { length } = bytes;
  if (length < 24) return Buffer.concat([Buffer.from([0x40 + length]), bytes]);
  if (length < 256) return Buffer.concat([Buffer.from([0x58, length]), bytes]);
  return Buffer.concat([Buffer.from([0x59, length >> 8, length & 0xff]), bytes]);
}

const cborText = (text: string) => Buffer.concat([Buffer.from([0x60 + text.length]), Buffer.from(text)]);

export interface FakeContext {
  origin: string;
  rpId: string;
}

/**
 * A real authenticator, as far as the server can tell: real authenticator data, CBOR and ES256 signature.
 * That way `@simplewebauthn/server` verifies exactly what it would with a passkey, and every field can be forged.
 */
export class FakeAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly id = b64(this.credentialId);
  counter = 1;
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;

  constructor(private readonly context: FakeContext) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    const coordinate = (value: string | undefined) => Buffer.from(value as string, 'base64url');
    // { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
    this.cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), cborBytes(coordinate(jwk.x)), Buffer.from([0x22]), cborBytes(coordinate(jwk.y))]);
  }

  private authData(rpId: string, flags: number, counter: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(challenge: string, options: Partial<FakeContext> & { flags?: number; rk?: boolean; type?: string } = {}): RegistrationJson {
    const { origin, rpId } = { ...this.context, ...options };
    const clientData = this.clientData(options.type ?? 'webauthn.create', challenge, origin);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, this.cose]);
    const authData = this.authData(rpId, options.flags ?? FLAG_UP | FLAG_UV | FLAG_AT, 0, attested);
    const attestationObject = Buffer.concat([Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]), cborText('authData'), cborBytes(authData)]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject) },
      clientExtensionResults: { credProps: { rk: options.rk ?? true } },
    };
  }

  assert(challenge: string, options: Partial<FakeContext> & { flags?: number; counter?: number; id?: string; type?: string; signer?: FakeAuthenticator } = {}): AssertionJson {
    const { origin, rpId } = { ...this.context, ...options };
    const clientData = this.clientData(options.type ?? 'webauthn.get', challenge, origin);
    const counter = options.counter ?? (this.counter += 1);
    const authData = this.authData(rpId, options.flags ?? FLAG_UP | FLAG_UV, counter);
    const signature = createSign('sha256')
      .update(Buffer.concat([authData, sha256(clientData)]))
      .sign((options.signer ?? this).privateKey);
    const id = options.id ?? this.id;
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) },
      clientExtensionResults: {},
    };
  }
}

export const NO_UV = FLAG_UP;
export const NO_UV_ATTESTED = FLAG_UP | FLAG_AT;
