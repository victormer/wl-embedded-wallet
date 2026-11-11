// Local anvil chains with the real Safe and EntryPoint contracts, plus a small bundler and paymaster
// that speak JSON-RPC and actually execute `EntryPoint.handleOps`. Test use only.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { concat, createPublicClient, createWalletClient, decodeEventLog, http, numberToHex, pad, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const CONTRACTS = load('contracts');
const PAYMASTER_ARTIFACT = load('TestVerifyingPaymaster');

// Well-known public anvil keys, only valid on these local chains.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYMASTER_SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PAYMASTER_DEPOSIT = 10n ** 19n;
const STUB_SIGNATURE = `0x${'00'.repeat(64)}1b`;
const ESTIMATE = { callGasLimit: 100_000n, verificationGasLimit: 1_000_000n, preVerificationGas: 100_000n };
const PAYMASTER_GAS = { paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 1n };

const USER_OP_TUPLE = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
const ENTRY_POINT_ABI = parseAbi([
  `function handleOps(${USER_OP_TUPLE}[] ops, address beneficiary)`,
  `function getUserOpHash(${USER_OP_TUPLE} op) view returns (bytes32)`,
  'function depositTo(address account) payable',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
]);
const PAYMASTER_HASH_ABI = parseAbi([`function getHash(${USER_OP_TUPLE} op) view returns (bytes32)`]);

function packUint128s(high, low) {
  return pad(toHex((BigInt(high) << 128n) | BigInt(low)), { size: 32 });
}

function paymasterAndData(op, signatureOverride) {
  if (!op.paymaster) return '0x';
  return concat([
    op.paymaster,
    pad(toHex(BigInt(op.paymasterVerificationGasLimit ?? 0)), { size: 16 }),
    pad(toHex(BigInt(op.paymasterPostOpGasLimit ?? 0)), { size: 16 }),
    signatureOverride ?? op.paymasterData ?? '0x',
  ]);
}

function packUserOperation(op, signatureOverride) {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x',
    callData: op.callData,
    accountGasLimits: packUint128s(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: packUint128s(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: paymasterAndData(op, signatureOverride),
    signature: op.signature ?? '0x',
  };
}

function rpcServer(port, methods, bindHost) {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', async () => {
      let id = null;
      let body;
      try {
        const parsed = JSON.parse(raw);
        id = parsed.id;
        const handler = methods[parsed.method];
        if (!handler) throw Object.assign(new Error(`method not found: ${parsed.method}`), { code: -32601 });
        body = { jsonrpc: '2.0', id, result: await handler(...(parsed.params ?? [])) };
      } catch (error) {
        body = { jsonrpc: '2.0', id, error: { code: error.code ?? -32000, message: error.reason ?? error.shortMessage ?? error.message ?? 'error' } };
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => resolve(server));
  });
}

function bundlerMethods(publicClient, walletClient, entryPoint, requests) {
  const receipts = new Map();
  return {
    // Fixed, generous values: this is a test bundler, it does not really estimate.
    eth_estimateUserOperationGas: async () => ({
      callGasLimit: numberToHex(ESTIMATE.callGasLimit),
      verificationGasLimit: numberToHex(ESTIMATE.verificationGasLimit),
      preVerificationGas: numberToHex(ESTIMATE.preVerificationGas),
    }),
    eth_sendUserOperation: async (op, requestedEntryPoint) => {
      requests.push({ method: 'eth_sendUserOperation', sender: op.sender });
      if (requestedEntryPoint.toLowerCase() !== entryPoint.toLowerCase()) throw new Error('unsupported entrypoint');
      const packed = packUserOperation(op);
      const beneficiary = walletClient.account.address;
      const contract = { address: entryPoint, abi: ENTRY_POINT_ABI };
      // Real simulation: if the Safe or the paymaster rejects the signature, this reverts with its AA code.
      try {
        await publicClient.simulateContract({ ...contract, functionName: 'handleOps', args: [[packed], beneficiary], account: walletClient.account });
      } catch (error) {
        const revert = error.walk?.((cause) => cause.data?.errorName === 'FailedOp' || cause.data?.errorName === 'FailedOpWithRevert');
        throw Object.assign(new Error(revert?.data?.args?.[1] ?? error.shortMessage ?? 'handleOps reverted'), { code: -32500 });
      }
      const hash = await walletClient.writeContract({ ...contract, functionName: 'handleOps', args: [[packed], beneficiary], gas: 3_000_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const userOpHash = await publicClient.readContract({ ...contract, functionName: 'getUserOpHash', args: [packed] });
      const event = receipt.logs.flatMap((log) => {
        try {
          return [decodeEventLog({ abi: ENTRY_POINT_ABI, data: log.data, topics: log.topics })];
        } catch {
          return [];
        }
      }).find((decoded) => decoded.eventName === 'UserOperationEvent' && decoded.args.userOpHash === userOpHash);
      receipts.set(userOpHash, { userOpHash, success: event?.args.success ?? false, paymaster: event?.args.paymaster ?? null, receipt: { transactionHash: hash, status: receipt.status } });
      return userOpHash;
    },
    eth_getUserOperationReceipt: async (userOpHash) => receipts.get(userOpHash) ?? null,
  };
}

function paymasterMethods(publicClient, signer, address, chainId, requests) {
  const fields = (paymasterData) => ({
    paymaster: address,
    paymasterData,
    paymasterVerificationGasLimit: numberToHex(PAYMASTER_GAS.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: numberToHex(PAYMASTER_GAS.paymasterPostOpGasLimit),
  });
  const assertChain = (requested) => {
    if (BigInt(requested) !== BigInt(chainId)) throw new Error('wrong chain');
  };
  return {
    pm_getPaymasterStubData: async (op, _entryPoint, requested, context) => {
      assertChain(requested);
      requests.push({ method: 'pm_getPaymasterStubData', sender: op.sender, context });
      return fields(STUB_SIGNATURE);
    },
    pm_getPaymasterData: async (op, _entryPoint, requested, context) => {
      assertChain(requested);
      requests.push({ method: 'pm_getPaymasterData', sender: op.sender, context });
      const withGas = { ...op, paymaster: address, ...fields(STUB_SIGNATURE), signature: '0x' };
      const hash = await publicClient.readContract({ address, abi: PAYMASTER_HASH_ABI, functionName: 'getHash', args: [packUserOperation(withGas)] });
      return fields(await signer.signMessage({ message: { raw: hash } }));
    },
  };
}

async function waitForRpc(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('anvil is not responding');
}

async function startChain({ chainId, port, withContracts, sponsored = true, bindHost = '127.0.0.1' }) {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--host', bindHost, '--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  await waitForRpc(rpcUrl);
  const servers = [];
  const requests = [];
  const info = { chainId, rpcUrl, requests, pid: anvil.pid };
  if (withContracts) {
    const publicClient = createPublicClient({ transport: http(rpcUrl), pollingInterval: 50 });
    const walletClient = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), transport: http(rpcUrl), chain: { id: chainId, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } });
    for (const { address, code } of Object.values(CONTRACTS)) {
      await publicClient.request({ method: 'anvil_setCode', params: [address, code] });
    }
    const entryPoint = CONTRACTS.entryPoint.address;
    const signer = privateKeyToAccount(PAYMASTER_SIGNER_KEY);
    const deployHash = await walletClient.deployContract({ abi: PAYMASTER_ARTIFACT.abi, bytecode: PAYMASTER_ARTIFACT.bytecode, args: [entryPoint, signer.address] });
    const { contractAddress: paymaster } = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const depositHash = await walletClient.writeContract({ address: entryPoint, abi: ENTRY_POINT_ABI, functionName: 'depositTo', args: [paymaster], value: PAYMASTER_DEPOSIT });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    const bundlerPort = port + 1000;
    servers.push(await rpcServer(bundlerPort, bundlerMethods(publicClient, walletClient, entryPoint, requests), bindHost));
    info.bundlerUrl = `http://127.0.0.1:${bundlerPort}`;
    info.paymasterAddress = paymaster;
    if (sponsored) {
      const paymasterPort = port + 2000;
      servers.push(await rpcServer(paymasterPort, paymasterMethods(publicClient, signer, paymaster, chainId, requests), bindHost));
      info.paymasterUrl = `http://127.0.0.1:${paymasterPort}`;
    }
  }
  info.stop = async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    anvil.kill();
  };
  return info;
}

/**
 * Each chain: `{ chainId, port, withContracts, sponsored }`. Without `withContracts` it is a chain
 * with no factory: the vault must reject it as `CHAIN_NOT_SUPPORTED`.
 */
export async function startAaStack(chains) {
  const started = await Promise.all(chains.map(startChain));
  return { chains: started, stop: () => Promise.all(started.map((chain) => chain.stop())) };
}

/** `AA_CHAINS` for the vault. `name` and `rpcUrl` can be omitted to test the RPC sent in the token. */
export function aaChainsConfig(chains, { includeRpc = false } = {}) {
  return Object.fromEntries(
    chains
      .filter((chain) => chain.bundlerUrl)
      .map((chain) => [
        String(chain.chainId),
        {
          name: `Local ${chain.chainId}`,
          ...(includeRpc ? { rpcUrl: chain.rpcUrl } : {}),
          bundlerUrl: chain.bundlerUrl,
          ...(chain.paymasterUrl ? { paymasterUrl: chain.paymasterUrl, paymasterContext: { sponsorshipPolicyId: 'test-policy' } } : {}),
        },
      ]),
  );
}

