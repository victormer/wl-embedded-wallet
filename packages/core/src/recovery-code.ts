import { argon2id } from 'hash-wasm';
import { randomBytes, zero } from './encoding';
import { openEnvelope, sealEnvelope, type EnvelopeSlot } from './envelope';
import { WalletError } from './errors';
import type { Argon2Params, Envelope } from './types';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 26;

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

const ARGON2_LIMITS = { memorySize: 1048576, iterations: 10, parallelism: 4, hashLength: 32 };

export function normalizeRecoveryCode(input: string): string {
  const normalized = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (normalized.length !== CODE_LENGTH || [...normalized].some((c) => !CROCKFORD.includes(c))) {
    throw new WalletError('BAD_RECOVERY_CODE');
  }
  return normalized;
}

/** ASCII bytes of the normalized code: this is what is transferred to the worker. */
export function recoveryCodeToBytes(input: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(normalizeRecoveryCode(input)) as Uint8Array<ArrayBuffer>;
}

export function assertRecoveryCodeBytes(code: Uint8Array): void {
  if (code.length !== CODE_LENGTH || [...code].some((byte) => !CROCKFORD.includes(String.fromCharCode(byte)))) {
    throw new WalletError('BAD_RECOVERY_CODE');
  }
}

/** `kdfParams` arrives in the envelope and is untrusted: it is bounded to prevent a DoS through a tampered kit. */
export function parseArgon2Params(params: Record<string, unknown>): Argon2Params {
  const { memorySize, iterations, parallelism, hashLength } = params ?? {};
  const inRange = (value: unknown, min: number, max: number) =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
  if (
    !inRange(parallelism, 1, ARGON2_LIMITS.parallelism) ||
    !inRange(iterations, 1, ARGON2_LIMITS.iterations) ||
    !inRange(memorySize, 8 * (parallelism as number), ARGON2_LIMITS.memorySize) ||
    hashLength !== ARGON2_LIMITS.hashLength
  ) {
    throw new WalletError('KDF_PARAMS_INVALID');
  }
  return {
    memorySize: memorySize as number,
    iterations: iterations as number,
    parallelism: parallelism as number,
    hashLength: hashLength as number,
  };
}

/** Non-extractable AES-256-GCM key derived from the code. The salt separates each use. */
export async function deriveRecoveryKey(code: Uint8Array, salt: Uint8Array, params: Argon2Params): Promise<CryptoKey> {
  const raw = await argon2id({ password: code, salt, ...params, outputType: 'binary' });
  try {
    return await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    zero(raw);
  }
}

const GROUP_LENGTH = 4;

function encodeCrockford(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += CROCKFORD[(value << (5 - bits)) & 31];
  return output;
}

function groupCode(code: string): string {
  return code.match(new RegExp(`.{1,${GROUP_LENGTH}}`, 'g'))!.join('-');
}

/** 128 random bits in 26 grouped characters: `XXXX-XXXX-...-XX`. */
export function generateRecoveryCode(): string {
  const entropy = randomBytes(16);
  const code = groupCode(encodeCrockford(entropy));
  zero(entropy);
  return code;
}

/** Zero-based indices of the groups requested to confirm that the code has been saved. */
export function pickConfirmationGroups(count = 2): number[] {
  const groups = Math.ceil(CODE_LENGTH / GROUP_LENGTH);
  const picked = new Set<number>();
  while (picked.size < count) picked.add(randomBytes(1)[0] % groups);
  return [...picked].sort((a, b) => a - b);
}

export function confirmationMatches(code: string, answers: Record<number, string>): boolean {
  const groups = groupCode(normalizeRecoveryCode(code)).split('-');
  const entries = Object.entries(answers);
  if (entries.length === 0) return false;
  return entries.every(([index, answer]) => {
    const normalized = answer.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
    return groups[Number(index)] === normalized;
  });
}

export function sealShareC(
  plaintext: Uint8Array,
  code: Uint8Array,
  ids: { userId: string; setId: string },
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Envelope> {
  assertRecoveryCodeBytes(code);
  const slot: EnvelopeSlot = { ...ids, share: 'C' };
  return sealEnvelope({
    slot,
    kdf: 'argon2id',
    kdfParams: { ...params },
    plaintext,
    deriveKey: (salt) => deriveRecoveryKey(code, salt, params),
  });
}

export function openShareC(
  envelope: Envelope,
  code: Uint8Array,
  ids: { userId: string; setId: string },
): Promise<Uint8Array<ArrayBuffer>> {
  assertRecoveryCodeBytes(code);
  const slot: EnvelopeSlot = { ...ids, share: 'C' };
  return openEnvelope({
    envelope,
    slot,
    kdf: 'argon2id',
    deriveKey: (salt) => deriveRecoveryKey(code, salt, parseArgon2Params(envelope.kdfParams)),
  });
}
