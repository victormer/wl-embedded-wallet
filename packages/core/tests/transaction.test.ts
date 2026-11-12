import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import type { VaultCall } from '../src/operations';
import {
  buildTransactionOperation,
  DEFAULT_SAFE_PARAMS,
  deploymentFactory,
  dummySafeSignature,
  encodeSafeCalls,
  isAllowedTransactionCall,
  isTransactionOperation,
  predictSafeAddress,
} from '../src/safe';
import { InvalidSignRequest, parseVaultCall } from '../src/sign-request';

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SAFE = predictSafeAddress(OWNER);
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DATA = '0xa9059cbb000000000000000000000000000000000000000000000000000000000000000a';
const CALL: VaultCall = { to: TO, value: '1000000000000000', data: DATA };
const FEES = { maxFeePerGas: '30000000000', maxPriorityFeePerGas: '1000000000' };
// Safe4337Module entry points: abstractionkit encodes the variant that bubbles up the revert reason.
const EXECUTE_USER_OP = parseAbi([
  'function executeUserOp(address to, uint256 value, bytes data, uint8 operation)',
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
]);

const executeUserOp = (call: VaultCall, operation: 0 | 1, functionName: 'executeUserOp' | 'executeUserOpWithErrorString' = 'executeUserOpWithErrorString') =>
  encodeFunctionData({ abi: EXECUTE_USER_OP, functionName, args: [call.to, BigInt(call.value), call.data ?? '0x', operation] });

describe('buildTransactionOperation', () => {
  it('builds an unsigned operation for one call from the deployed Safe', () => {
    const operation = buildTransactionOperation(SAFE, CALL, '7', FEES);
    expect(operation).toEqual({
      sender: SAFE,
      nonce: '7',
      factory: null,
      factoryData: null,
      callData: encodeSafeCalls([CALL]),
      callGasLimit: '0',
      verificationGasLimit: '0',
      preVerificationGas: '0',
      ...FEES,
      paymaster: null,
      paymasterVerificationGasLimit: null,
      paymasterPostOpGasLimit: null,
      paymasterData: null,
      signature: dummySafeSignature(),
    });
  });

  it('the callData is executeUserOpWithErrorString(to, value, data, CALL)', () => {
    expect(buildTransactionOperation(SAFE, CALL, '0', FEES).callData.toLowerCase()).toBe(executeUserOp(CALL, 0).toLowerCase());
    const plain = { to: TO, value: '5' } as const;
    expect(buildTransactionOperation(SAFE, plain, '0', FEES).callData.toLowerCase()).toBe(executeUserOp(plain, 0).toLowerCase());
  });
});

describe('isTransactionOperation', () => {
  const built = () => buildTransactionOperation(SAFE, CALL, '7', FEES);

  it('accepts the built operation, also once signed, with a paymaster and gas filled in', () => {
    expect(isTransactionOperation(built(), CALL, SAFE)).toBe(true);
    expect(
      isTransactionOperation(
        { ...built(), callGasLimit: '100000', paymaster: `0x${'ee'.repeat(20)}`, paymasterData: '0x01', signature: '0x1234' },
        CALL,
        SAFE,
        DEFAULT_SAFE_PARAMS,
      ),
    ).toBe(true);
  });

  it('is agnostic to address and hex case, and to how quantities are written', () => {
    const operation = built();
    expect(isTransactionOperation({ ...operation, sender: SAFE.toLowerCase(), callData: operation.callData.toUpperCase().replace('0X', '0x') }, CALL, SAFE)).toBe(true);
    expect(isTransactionOperation({ ...operation, nonce: '0x7' }, CALL, SAFE)).toBe(true);
    expect(isTransactionOperation(operation, { ...CALL, to: TO.toLowerCase() as `0x${string}`, data: DATA.toUpperCase().replace('0X', '0x') as `0x${string}` }, SAFE)).toBe(true);
    expect(isTransactionOperation({ ...operation, factory: undefined, factoryData: undefined }, CALL, SAFE)).toBe(true);
  });

  it.each([
    ['another recipient', { ...CALL, to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }],
    ['another value', { ...CALL, value: '1000000000000001' }],
    ['other data', { ...CALL, data: '0xa9059cbb' }],
    ['no data', { to: CALL.to, value: CALL.value }],
  ] as [string, VaultCall][])('rejects an operation for the reviewed call when it executes %s', (_label, other) => {
    expect(isTransactionOperation(buildTransactionOperation(SAFE, other, '7', FEES), CALL, SAFE)).toBe(false);
    expect(isTransactionOperation(built(), other, SAFE)).toBe(false);
  });

  it('rejects another sender', () => {
    expect(isTransactionOperation({ ...built(), sender: TO }, CALL, SAFE)).toBe(false);
    expect(isTransactionOperation(built(), CALL, TO)).toBe(false);
    expect(isTransactionOperation({ ...built(), sender: 'not an address' }, CALL, SAFE)).toBe(false);
  });

  it('rejects a factory: only a deployed Safe sends transactions', () => {
    const { factory, factoryData } = deploymentFactory(OWNER);
    expect(isTransactionOperation({ ...built(), factory, factoryData }, CALL, SAFE)).toBe(false);
    expect(isTransactionOperation({ ...built(), factory }, CALL, SAFE)).toBe(false);
    expect(isTransactionOperation({ ...built(), factoryData: '0x' }, CALL, SAFE)).toBe(false);
  });

  it.each(['executeUserOp', 'executeUserOpWithErrorString'] as const)('rejects a delegatecall of the same call through %s', (functionName) => {
    const delegate = executeUserOp(CALL, 1, functionName);
    expect(delegate.toLowerCase()).not.toBe(built().callData.toLowerCase());
    expect(isTransactionOperation({ ...built(), callData: delegate }, CALL, SAFE)).toBe(false);
  });

  it('rejects the same call through the other module entry point', () => {
    expect(isTransactionOperation({ ...built(), callData: executeUserOp(CALL, 0, 'executeUserOp') }, CALL, SAFE)).toBe(false);
  });

  it('rejects a multisend batch, even one that only contains the same call', () => {
    const batch = encodeSafeCalls([CALL, CALL]);
    expect(isTransactionOperation({ ...built(), callData: batch }, CALL, SAFE)).toBe(false);
  });

  it('rejects a missing or malformed operation', () => {
    expect(isTransactionOperation(null, CALL, SAFE)).toBe(false);
    expect(isTransactionOperation(undefined, CALL, SAFE)).toBe(false);
    expect(isTransactionOperation({ ...built(), callData: undefined }, CALL, SAFE)).toBe(false);
    expect(isTransactionOperation({ ...built(), callData: 7 }, CALL, SAFE)).toBe(false);
  });
});

describe('isAllowedTransactionCall', () => {
  it.each([
    ['a call to another address with data', CALL, true],
    ['a transfer to another address', { to: TO, value: '1' }, true],
    ['a transfer of value to the Safe itself', { to: SAFE, value: '1' }, true],
    ['an empty call to the Safe itself', { to: SAFE, value: '0', data: '0x' }, true],
    ['a self-call with data', { to: SAFE, value: '0', data: DATA }, false],
    ['a self-call with data and a lowercase address', { to: SAFE.toLowerCase(), value: '0', data: '0x00' }, false],
  ] as [string, VaultCall, boolean][])('%s → %s', (_label, call, allowed) => {
    expect(isAllowedTransactionCall(SAFE, call)).toBe(allowed);
  });
});

describe('parseVaultCall', () => {
  const invalid = (raw: unknown) => expect(() => parseVaultCall(raw)).toThrow(InvalidSignRequest);

  it('accepts a valid call and keeps only its fields', () => {
    expect(parseVaultCall(CALL)).toEqual(CALL);
    expect(parseVaultCall({ to: TO, value: '0' })).toEqual({ to: TO, value: '0' });
    expect(parseVaultCall({ to: TO.toLowerCase(), value: '0', data: '0x' })).toEqual({ to: TO.toLowerCase(), value: '0', data: '0x' });
    expect(parseVaultCall({ to: TO, value: ((1n << 256n) - 1n).toString() }).value).toBe(((1n << 256n) - 1n).toString());
  });

  it.each([
    ['not an object', 'call'],
    ['null', null],
    ['an extra key', { ...CALL, operation: 1 }],
    ['a missing to', { value: '0' }],
    ['a short address', { to: '0x1234', value: '0' }],
    ['a bad checksum', { to: TO.replace('C51812dc', 'c51812DC'), value: '0' }],
    ['a missing value', { to: TO }],
    ['a numeric value', { to: TO, value: 1 }],
    ['a hex value', { to: TO, value: '0x1' }],
    ['a negative value', { to: TO, value: '-1' }],
    ['a value with decimals', { to: TO, value: '1.5' }],
    ['a value with leading zeros', { to: TO, value: '01' }],
    ['a value above 2^256-1', { to: TO, value: (1n << 256n).toString() }],
    ['odd-length data', { to: TO, value: '0', data: '0x123' }],
    ['data that is not hex', { to: TO, value: '0', data: '0xzz' }],
    ['data without 0x', { to: TO, value: '0', data: 'abcd' }],
    ['data that is not a string', { to: TO, value: '0', data: 12 }],
    ['data that is too long', { to: TO, value: '0', data: `0x${'00'.repeat(64_000)}` }],
  ])('rejects %s', (_label, raw) => {
    invalid(raw);
  });
});
