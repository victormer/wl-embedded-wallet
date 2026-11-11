import { describe, expect, it } from 'vitest';
import { buildKit, parseKit } from '../src/kit';
import { InvalidSignRequest, parseSignRequest } from '../src/sign-request';
import type { Envelope, SignedManifest } from '../src/types';

const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OP = {
  calls: [{ to: TO, value: '1000000000000000' }],
  nonce: '7',
  callGasLimit: '100000',
  verificationGasLimit: '200000',
  preVerificationGas: '60000',
  maxFeePerGas: '30000000000',
  maxPriorityFeePerGas: '1000000000',
};
const TYPED = {
  domain: { name: 'Example', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  types: { Mail: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  primaryType: 'Mail',
  message: { to: TO, amount: '5' },
};

const invalid = (raw: unknown) => expect(() => parseSignRequest(raw)).toThrow(InvalidSignRequest);

describe('parseSignRequest', () => {
  it('accepts a message', () => {
    expect(parseSignRequest({ kind: 'message', message: 'hello' })).toEqual({ kind: 'message', message: 'hello' });
  });

  it('rejects empty, huge or non-text messages', () => {
    invalid({ kind: 'message', message: '' });
    invalid({ kind: 'message', message: 'x'.repeat(10_001) });
    invalid({ kind: 'message', message: 5 });
  });

  it('accepts EIP-712 with string amounts', () => {
    expect(parseSignRequest({ kind: 'typedData', typedData: TYPED }).kind).toBe('typedData');
  });

  it('rejects invalid EIP-712', () => {
    invalid({ kind: 'typedData', typedData: { ...TYPED, primaryType: 'Nope' } });
    invalid({ kind: 'typedData', typedData: { ...TYPED, primaryType: 'constructor' } });
    invalid({ kind: 'typedData', typedData: { ...TYPED, message: { to: 'x', amount: '5' } } });
    invalid({ kind: 'typedData', typedData: { ...TYPED, extra: 1 } });
    invalid({ kind: 'typedData', typedData: { ...TYPED, message: { to: TO, amount: 5n } } });
    invalid({ kind: 'typedData', typedData: null });
  });

  it('accepts a UserOperation without altering its amounts', () => {
    const request = { kind: 'userOperation', userOperation: { ...OP, calls: [{ to: TO, value: '5', data: '0xabcd' }] } };
    expect(parseSignRequest(request)).toEqual(request);
  });

  it.each([
    ['unknown field', { accessList: [] }],
    ['factory: signing only exists for a deployed Safe', { factory: TO }],
    ['deployed', { deployed: false }],
    ['no calls', { calls: [] }],
    ['invalid address', { calls: [{ to: '0x1234', value: '0' }] }],
    ['wrong checksum', { calls: [{ to: TO.replace('C', 'c').replace('b', 'B'), value: '0' }] }],
    ['non-decimal amount', { calls: [{ to: TO, value: '0x10' }] }],
    ['negative amount', { calls: [{ to: TO, value: '-1' }] }],
    ['numeric amount', { calls: [{ to: TO, value: 1 }] }],
    ['amount above 2^256', { calls: [{ to: TO, value: (1n << 256n).toString() }] }],
    ['non-hex data', { calls: [{ to: TO, value: '0', data: 'hello' }] }],
    ['unknown field in a call', { calls: [{ to: TO, value: '0', operation: 1 }] }],
    ['zero gas', { callGasLimit: '0' }],
    ['priority fee above the max fee', { maxPriorityFeePerGas: '30000000001' }],
    ['numeric nonce', { nonce: 7 }],
  ])('rejects a UserOperation with %s', (_label, change) => {
    invalid({ kind: 'userOperation', userOperation: { ...OP, ...change } });
  });

  it('rejects unknown shapes, including the EIP-1559 transaction that no longer exists', () => {
    invalid(null);
    invalid({ kind: 'other' });
    invalid({ kind: 'transaction', transaction: { to: TO } });
    invalid({ kind: 'userOperation', userOperation: null });
  });

});

describe('kit', () => {
  const envelope = (share: 'B' | 'C', kdf: Envelope['kdf']): Envelope => ({
    v: 1,
    share,
    userId: 'alice',
    setId: 'set',
    kdf,
    kdfParams: {},
    salt: 'AAAA',
    iv: 'AAAA',
    ct: 'AAAA',
  });
  const signed = {
    manifest: { userId: 'alice', setId: 'set', shareDigests: {}, expectedAddress: TO, smartAccount: { address: TO } },
    signature: 'AAAA',
  } as unknown as SignedManifest;
  const kit = buildKit({ rpId: 'vault.localhost', credentialId: 'abc', encB: envelope('B', 'prf-hkdf-sha256'), encC: envelope('C', 'argon2id'), signed });

  it('reads a generated kit, which does not contain share A', () => {
    const text = JSON.stringify(kit);
    expect(parseKit(text)).toEqual(kit);
    expect(text).not.toContain('encA');
    expect(text).not.toContain('shareA');
  });

  it('rejects broken JSON and invalid shapes', () => {
    expect(parseKit('{')).toBeNull();
    expect(parseKit('[]')).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, v: 2 }))).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, encB: kit.encC }))).toBeNull();
    expect(parseKit(JSON.stringify({ ...kit, signature: undefined }))).toBeNull();
  });
});
