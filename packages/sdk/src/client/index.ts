import {
  VAULT_PROTOCOL,
  VAULT_WINDOW_NAME,
  type TypedDataRequest,
  type UserOperationJson,
  type UserOperationRequest,
  type VaultCall,
  type VaultChain,
  type VaultAction,
  type VaultRequest,
  type VaultSignRequest,
} from '../protocol';

export * from '../protocol';

const POPUP_FEATURES = 'popup,width=480,height=760';
const CLOSED_POLL_MS = 500;
// Browsers store timer delays as 32-bit signed integers: a longer delay fires immediately.
const MAX_TIMEOUT_MS = 2_147_483_647;

export type VaultErrorCode =
  | 'INVALID_REQUEST'
  | 'POPUP_BLOCKED'
  | 'POPUP_CLOSED'
  | 'TOKEN_UNAVAILABLE'
  | 'SUPERSEDED'
  | 'NOT_IN_BROWSER'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'INTERNAL';

export class VaultError extends Error {
  readonly code: string;

  constructor(code: VaultErrorCode | (string & {})) {
    super(code);
    this.name = 'VaultError';
    this.code = code;
  }
}

export type VaultAccount = { address: `0x${string}`; owner: `0x${string}` };
export type VaultSignature = VaultAccount & { signature: `0x${string}` };
export type VaultUserOperationSignature = VaultSignature & { userOperation: UserOperationJson };
export type VaultDeployment = VaultAccount & { userOpHash?: `0x${string}`; transactionHash?: `0x${string}` };

/** One call from the user's deployed Safe. `value` is in wei (default 0) and is paid by the Safe itself. */
export interface VaultTransactionRequest {
  chain: VaultChain;
  to: `0x${string}`;
  value?: bigint | string;
  data?: `0x${string}`;
}

/** The UserOperation was included on-chain and its call succeeded. */
export type VaultTransactionResult = VaultAccount & { chainId: number; userOpHash: `0x${string}`; transactionHash: `0x${string}` };

export interface VaultPopup {
  closed: boolean;
  postMessage(message: unknown, targetOrigin: string): void;
  focus?(): void;
  /** Only used when `timeoutMs` expires. */
  close?(): void;
}

/** The parts of `window` the SDK uses. Injected in tests. */
export interface VaultHost {
  open(url: string, target: string, features: string): VaultPopup | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export interface VaultClientOptions {
  vaultOrigin: string;
  /**
   * Requests a fresh token from the app's server. Called every time the popup signals `ready`.
   * The server signs the network and its RPC into the token: it must never accept an RPC from the browser.
   */
  getToken: (chain?: VaultChain) => Promise<string>;
  /**
   * Rejects a pending operation with `TIMEOUT` after this many milliseconds from opening the popup, and closes it.
   * Default: no timeout. Must be a positive finite number of at most 2147483647.
   */
  timeoutMs?: number;
  host?: VaultHost;
}

export interface VaultClient {
  activate(): Promise<VaultAccount>;
  deploy(chain: VaultChain): Promise<VaultDeployment>;
  signMessage(chain: VaultChain, message: string): Promise<VaultSignature>;
  signTypedData(chain: VaultChain, typedData: TypedDataRequest): Promise<VaultSignature>;
  signUserOperation(chain: VaultChain, userOperation: UserOperationRequest): Promise<VaultUserOperationSignature>;
  /**
   * Sends one call from the user's Safe, which must already be deployed on `chain`. The vault server builds the
   * UserOperation (nonce, gas, fees and, where the vault sponsors transactions on that chain, the paymaster); the user
   * reviews and approves it in the vault, which waits for the receipt. Rejects with `INVALID_REQUEST` before opening the
   * popup if the call is malformed.
   */
  sendTransaction(request: VaultTransactionRequest): Promise<VaultTransactionResult>;
  unlock(): Promise<VaultAccount>;
  recover(): Promise<VaultAccount>;
  /** Opens the export flow in the vault. The seed never reaches the SDK. */
  export(): Promise<VaultAccount>;
  /** For an account without a wallet: recovers an existing wallet in the vault and links it to this account. The previous account loses access. */
  relink(): Promise<VaultAccount>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^(?:0|[1-9][0-9]{0,77})$/;

const isAddress = (value: unknown): value is `0x${string}` => typeof value === 'string' && ADDRESS.test(value);
const isHash = (value: unknown): value is `0x${string}` => typeof value === 'string' && HASH.test(value);
const isBytes = (value: unknown): value is `0x${string}` => typeof value === 'string' && BYTES.test(value);
const isSignature = (value: unknown): value is `0x${string}` => isBytes(value) && value.length > 2;
const isQuantity = (value: unknown): value is string => typeof value === 'string' && QUANTITY.test(value);
const orNull = <T>(check: (value: unknown) => value is T) => (value: unknown): value is T | null => value === null || check(value);

const USER_OPERATION_FIELDS: Record<keyof UserOperationJson, (value: unknown) => boolean> = {
  sender: isAddress,
  nonce: isQuantity,
  factory: orNull(isAddress),
  factoryData: orNull(isBytes),
  callData: isBytes,
  callGasLimit: isQuantity,
  verificationGasLimit: isQuantity,
  preVerificationGas: isQuantity,
  maxFeePerGas: isQuantity,
  maxPriorityFeePerGas: isQuantity,
  paymaster: orNull(isAddress),
  paymasterVerificationGasLimit: orNull(isQuantity),
  paymasterPostOpGasLimit: orNull(isQuantity),
  paymasterData: orNull(isBytes),
  signature: isSignature,
};

/** A copy with only the known fields, or `null` if any of them is malformed. */
function parseUserOperation(value: unknown): UserOperationJson | null {
  if (!isRecord(value)) return null;
  const operation: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(USER_OPERATION_FIELDS)) {
    if (!check(value[key])) return null;
    operation[key] = value[key];
  }
  return operation as UserOperationJson;
}

// One parser per action, matching what each vault page posts. A parser returns `null` for a malformed `ok: true`
// result. Fields the action does not define are dropped, so nothing else (a seed, for example) reaches the app.
type ResultParser<T> = (data: Record<string, unknown>) => T | null;

const parseAccount: ResultParser<VaultAccount> = (data) => (isAddress(data.address) && isAddress(data.owner) ? { address: data.address, owner: data.owner } : null);

// Both hashes or neither: without them, the Safe was already deployed and nothing was sent.
const parseDeployment: ResultParser<VaultDeployment> = (data) => {
  const account = parseAccount(data);
  if (!account) return null;
  if (data.userOpHash === undefined && data.transactionHash === undefined) return account;
  if (!isHash(data.userOpHash) || !isHash(data.transactionHash)) return null;
  return { ...account, userOpHash: data.userOpHash, transactionHash: data.transactionHash };
};

// The receipt of a sent call: both hashes, and the network it was asked for.
const parseTransaction =
  (chainId: number): ResultParser<VaultTransactionResult> =>
  (data) => {
    const account = parseAccount(data);
    if (!account || data.chainId !== chainId || !isHash(data.userOpHash) || !isHash(data.transactionHash)) return null;
    return { ...account, chainId, userOpHash: data.userOpHash, transactionHash: data.transactionHash };
  };

const MAX_UINT256 = (1n << 256n) - 1n;

/** The call as the vault expects it (`value` in decimal wei, no empty `data`), or `null` if it is malformed. */
function toVaultCall(request: VaultTransactionRequest): VaultCall | null {
  if (!isRecord(request) || !isAddress(request.to)) return null;
  const raw = request.value ?? '0';
  let value: bigint;
  if (typeof raw === 'bigint') value = raw;
  else if (isQuantity(raw)) value = BigInt(raw);
  else return null;
  if (value < 0n || value > MAX_UINT256) return null;
  if (request.data !== undefined && !isBytes(request.data)) return null;
  return { to: request.to, value: value.toString(), ...(request.data && request.data !== '0x' ? { data: request.data } : {}) };
}

function isChain(chain: unknown): chain is VaultChain {
  return isRecord(chain) && typeof chain.chainId === 'number' && Number.isSafeInteger(chain.chainId) && chain.chainId > 0;
}

const parseSignature: ResultParser<VaultSignature> = (data) => {
  const account = parseAccount(data);
  return account && isSignature(data.signature) ? { ...account, signature: data.signature } : null;
};

// The vault returns the operation it signed: for the user's Safe, carrying the same signature.
const parseUserOperationSignature: ResultParser<VaultUserOperationSignature> = (data) => {
  const signed = parseSignature(data);
  const userOperation = parseUserOperation(data.userOperation);
  if (!signed || !userOperation) return null;
  if (userOperation.sender.toLowerCase() !== signed.address.toLowerCase() || userOperation.signature !== signed.signature) return null;
  return { ...signed, userOperation };
};

function validTimeout(timeoutMs: unknown): timeoutMs is number | undefined {
  return timeoutMs === undefined || (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS);
}

// The window has a fixed name, shared across clients too: a new operation cancels the previous one
// and removes its listener, so it does not answer the next operation's `ready`.
const currentOperation = new WeakMap<object, () => void>();

export function createVaultClient({ vaultOrigin, getToken, timeoutMs, host }: VaultClientOptions): VaultClient {
  const origin = new URL(vaultOrigin).origin;
  if (!validTimeout(timeoutMs)) throw new RangeError('INVALID_TIMEOUT');

  // Runs synchronously up to `open`: it must happen within the user gesture.
  function run<T>(action: VaultAction, parse: ResultParser<T>, chain?: VaultChain): Promise<T> {
    return new Promise((resolve, reject) => {
      const target = host ?? (globalThis.window as unknown as VaultHost | undefined);
      if (!target) {
        reject(new VaultError('NOT_IN_BROWSER'));
        return;
      }

      currentOperation.get(target)?.();

      let popup: VaultPopup | null;
      try {
        popup = target.open(`${origin}/${action.kind}`, VAULT_WINDOW_NAME, POPUP_FEATURES);
      } catch {
        reject(new VaultError('INTERNAL'));
        return;
      }
      if (!popup) {
        reject(new VaultError('POPUP_BLOCKED'));
        return;
      }
      const vaultWindow = popup;
      vaultWindow.focus?.();

      const id = crypto.randomUUID();
      let readyCount = 0;
      let settled = false;

      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        target.removeEventListener('message', onMessage);
        target.clearInterval(closedPoll);
        if (deadline !== undefined) target.clearInterval(deadline);
        currentOperation.delete(target);
        complete();
      };
      const fail = (code: VaultErrorCode | (string & {})) => finish(() => reject(new VaultError(code)));

      // The vault signals every time it loads a route. The token is single-use, so every
      // `ready` needs a fresh one, and only the most recent one is answered.
      const answerReady = async () => {
        const current = ++readyCount;
        let token: unknown;
        try {
          token = await getToken(chain);
        } catch {
          token = null;
        }
        if (settled || current !== readyCount) return;
        // The vault ignores a request without a string token: the operation would wait for nothing.
        if (typeof token !== 'string' || token === '') {
          fail('TOKEN_UNAVAILABLE');
          return;
        }
        const request: VaultRequest = { protocol: VAULT_PROTOCOL, type: 'request', id, token, action };
        try {
          vaultWindow.postMessage(request, origin);
        } catch {
          // For example, a request that cannot be cloned.
          fail('INTERNAL');
        }
      };

      function onMessage(event: MessageEvent) {
        if (event.origin !== origin || event.source !== (vaultWindow as unknown)) return;
        const data: unknown = event.data;
        if (!isRecord(data) || data.protocol !== VAULT_PROTOCOL) return;

        if (data.type === 'ready') {
          void answerReady();
          return;
        }
        if (data.type !== 'result' || data.id !== id) return;

        // A result for this operation that does not have the expected shape will not be followed by another one.
        if (data.ok === true) {
          const outcome = parse(data);
          if (outcome) finish(() => resolve(outcome));
          else fail('PROTOCOL_ERROR');
        } else if (data.ok === false && typeof data.code === 'string' && data.code !== '') {
          fail(data.code);
        } else {
          fail('PROTOCOL_ERROR');
        }
      }

      const closedPoll = target.setInterval(() => {
        if (vaultWindow.closed) fail('POPUP_CLOSED');
      }, CLOSED_POLL_MS);
      // A one-shot timer on `setInterval`, so `VaultHost` needs nothing else. `finish` clears it.
      const deadline =
        timeoutMs === undefined
          ? undefined
          : target.setInterval(() => {
              finish(() => {
                // Nobody listens any more: the user must not keep approving in the popup.
                try {
                  vaultWindow.close?.();
                } catch {
                  // The popup may already be gone.
                }
                reject(new VaultError('TIMEOUT'));
              });
            }, timeoutMs);
      target.addEventListener('message', onMessage);
      currentOperation.set(target, () => fail('SUPERSEDED'));
    });
  }

  const sign = <T>(chain: VaultChain, request: VaultSignRequest, parse: ResultParser<T>) => run({ kind: 'sign', chain: { chainId: chain.chainId }, request }, parse, chain);

  return {
    activate: () => run({ kind: 'activate' }, parseAccount),
    deploy: (chain) => run({ kind: 'deploy', chain: { chainId: chain.chainId } }, parseDeployment, chain),
    unlock: () => run({ kind: 'unlock' }, parseAccount),
    recover: () => run({ kind: 'recover' }, parseAccount),
    export: () => run({ kind: 'export' }, parseAccount),
    relink: () => run({ kind: 'relink' }, parseAccount),
    signMessage: (chain, message) => sign(chain, { kind: 'message', message }, parseSignature),
    signTypedData: (chain, typedData) => sign(chain, { kind: 'typedData', typedData }, parseSignature),
    signUserOperation: (chain, userOperation) => sign(chain, { kind: 'userOperation', userOperation }, parseUserOperationSignature),
    sendTransaction: (request) => {
      const transaction = toVaultCall(request);
      if (!transaction || !isChain(request.chain)) return Promise.reject(new VaultError('INVALID_REQUEST'));
      const { chain } = request;
      return run({ kind: 'transaction', chain: { chainId: chain.chainId }, transaction }, parseTransaction(chain.chainId), chain);
    },
  };
}
