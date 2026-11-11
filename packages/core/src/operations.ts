// Signing request and UserOperation shapes shared by the vault, the core signer and the SDK. Pure data.

export type TypedDataRequest = {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Amounts in wei as decimal strings, so they are JSON-serializable.
export type VaultCall = {
  to: `0x${string}`;
  value: string;
  data?: `0x${string}`;
};

// For an already deployed Safe: never carries `factory`. It is signed, not sent.
export type UserOperationRequest = {
  calls: VaultCall[];
  nonce: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

// Full v0.7 UserOperation. Quantities are decimal strings.
export type UserOperationJson = {
  sender: `0x${string}`;
  nonce: string;
  factory: string | null;
  factoryData: string | null;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster: string | null;
  paymasterVerificationGasLimit: string | null;
  paymasterPostOpGasLimit: string | null;
  paymasterData: string | null;
  signature: string;
};

export type VaultSignRequest =
  | { kind: 'message'; message: string }
  | { kind: 'typedData'; typedData: TypedDataRequest }
  | { kind: 'userOperation'; userOperation: UserOperationRequest };
