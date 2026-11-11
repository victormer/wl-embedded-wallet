import type { TypedDataRequest, UserOperationRequest, VaultCall, VaultSignRequest } from './operations';
import { hashTypedData, isAddress, type TypedDataDefinition } from 'viem';
import { isRecord } from './schema';
import type { SignRequest } from './types';

const MAX_MESSAGE_CHARS = 10_000;
const MAX_TYPED_DATA_CHARS = 64_000;
const MAX_DATA_CHARS = 128_000;
const MAX_UINT256 = (1n << 256n) - 1n;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX_CALLS = 16;
const USER_OPERATION_KEYS = new Set(['calls', 'nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas']);
const CALL_KEYS = new Set(['to', 'value', 'data']);
const TYPED_DATA_KEYS = new Set(['domain', 'types', 'primaryType', 'message']);

/** The request comes from another app: anything that does not pass through here is neither displayed nor signed. */
export class InvalidSignRequest extends Error {
  constructor() {
    super('INVALID_REQUEST');
    this.name = 'InvalidSignRequest';
  }
}

function require(condition: boolean): asserts condition {
  if (!condition) throw new InvalidSignRequest();
}

function parseAmount(value: unknown): bigint {
  require(typeof value === 'string' && DECIMAL.test(value));
  const amount = BigInt(value as string);
  require(amount <= MAX_UINT256);
  return amount;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Infinity;
  } catch {
    // Circular references or `bigint`, which the contract does not allow.
    return Infinity;
  }
}

function parseTypedData(raw: unknown): TypedDataRequest {
  require(isRecord(raw) && hasOnlyKeys(raw, TYPED_DATA_KEYS));
  const value = raw as Record<string, unknown>;
  require(serializedLength(value) <= MAX_TYPED_DATA_CHARS);
  require(isRecord(value.domain) && isRecord(value.types) && isRecord(value.message));
  require(typeof value.primaryType === 'string' && Object.hasOwn(value.types as object, value.primaryType as string));
  try {
    // viem validates types, domain and values: the same checks it will run when signing.
    hashTypedData(value as unknown as TypedDataDefinition);
  } catch {
    throw new InvalidSignRequest();
  }
  return value as unknown as TypedDataRequest;
}

function parseCall(raw: unknown): VaultCall {
  require(isRecord(raw) && hasOnlyKeys(raw, CALL_KEYS));
  const call = raw as Record<string, unknown>;
  require(typeof call.to === 'string' && isAddress(call.to));
  parseAmount(call.value);
  const data = call.data;
  require(data === undefined || (typeof data === 'string' && data.length <= MAX_DATA_CHARS && HEX_DATA.test(data)));
  return { to: call.to as `0x${string}`, value: call.value as string, ...(data ? { data: data as `0x${string}` } : {}) };
}

/** Does not accept `factory`: signing only exists for a deployed Safe. */
function parseUserOperation(raw: unknown): UserOperationRequest {
  require(isRecord(raw) && hasOnlyKeys(raw, USER_OPERATION_KEYS));
  const value = raw as Record<string, unknown>;
  require(Array.isArray(value.calls) && value.calls.length > 0 && value.calls.length <= MAX_CALLS);
  parseAmount(value.nonce);
  const callGasLimit = parseAmount(value.callGasLimit);
  const verificationGasLimit = parseAmount(value.verificationGasLimit);
  parseAmount(value.preVerificationGas);
  const maxFeePerGas = parseAmount(value.maxFeePerGas);
  const maxPriorityFeePerGas = parseAmount(value.maxPriorityFeePerGas);
  require(callGasLimit > 0n && verificationGasLimit > 0n && maxFeePerGas > 0n && maxPriorityFeePerGas <= maxFeePerGas);
  return {
    calls: (value.calls as unknown[]).map(parseCall),
    nonce: value.nonce as string,
    callGasLimit: value.callGasLimit as string,
    verificationGasLimit: value.verificationGasLimit as string,
    preVerificationGas: value.preVerificationGas as string,
    maxFeePerGas: value.maxFeePerGas as string,
    maxPriorityFeePerGas: value.maxPriorityFeePerGas as string,
  };
}

/** Converts the app's request into the worker's request. Throws `InvalidSignRequest`. */
export function parseSignRequest(raw: unknown): SignRequest {
  require(isRecord(raw));
  const { kind } = raw as { kind?: unknown };
  const value = raw as Record<string, unknown>;
  if (kind === 'message') {
    const { message } = value;
    require(typeof message === 'string' && message.length > 0 && message.length <= MAX_MESSAGE_CHARS);
    return { kind: 'message', message: message as string };
  }
  if (kind === 'typedData') {
    return { kind: 'typedData', typedData: parseTypedData(value.typedData) };
  }
  if (kind === 'userOperation') return { kind: 'userOperation', userOperation: parseUserOperation(value.userOperation) };
  throw new InvalidSignRequest();
}

export type { UserOperationRequest, VaultSignRequest };
