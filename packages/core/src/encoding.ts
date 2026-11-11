/** WebCrypto APIs require `ArrayBuffer`; `SharedArrayBuffer` is never used here. */
export function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/** Best-effort wipe. Ignores buffers that were already transferred. */
export function zero(...buffers: Array<Uint8Array | undefined>): void {
  for (const buffer of buffers) buffer?.fill(0);
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Rejects non-canonical encodings, so that each text represents exactly one value. */
export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length % 4 === 1) {
    throw new Error('invalid base64url');
  }
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (b64urlEncode(bytes) !== text) throw new Error('invalid base64url');
  return bytes;
}

export function hexEncode(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function hexDecode(hex: string): Uint8Array<ArrayBuffer> {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(bytes)));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexEncode(await sha256(bytes));
}
