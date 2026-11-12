import { isDeploymentOperation } from '@wl-embedded-wallet/core/safe';
import { NextResponse, type NextRequest } from 'next/server';
import { isRecord } from '@wl-embedded-wallet/core/schema';
import { parseVaultCall } from '@wl-embedded-wallet/core/sign-request';
import { assertRpcChain, ChainError, chainConfig, chainStatus, jsonRpc, resolveRpcUrl } from '@/server/chains';
import { fail, json, originError, readJson, requireSession } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { isRecordedUserOpHash, prepareDeployment, SponsorshipError, submitDeployment, UpstreamError } from '@/server/sponsorship';
import { prepareTransaction, submitTransaction } from '@/server/transactions';
import { getActiveSet, isSentTransaction } from '@/server/store';

export const runtime = 'nodejs';
// Several upstream calls (RPC, bundler, paymaster, JWKS), each capped at 10 s: explicit so it does not depend on the plan.
export const maxDuration = 60;

const PREPARE_METHOD = 'vault_prepareDeployment';
const PREPARE_TRANSACTION_METHOD = 'vault_prepareTransaction';
const SEND_METHOD = 'eth_sendUserOperation';
const RECEIPT_METHOD = 'eth_getUserOperationReceipt';
const METHODS = new Set([PREPARE_METHOD, PREPARE_TRANSACTION_METHOD, SEND_METHOD, RECEIPT_METHOD]);
const USER_OP_HASH = /^0x[0-9a-fA-F]{64}$/;

function failure(error: unknown): NextResponse {
  if (error instanceof SponsorshipError) return fail(error.code, error.status);
  if (error instanceof UpstreamError) return json({ error: 'UPSTREAM_ERROR', rpcMessage: error.rpcMessage }, 502);
  return fail(error instanceof ChainError ? error.code : 'CHAIN_UNAVAILABLE', 409);
}

/**
 * Bundler and paymaster proxy: the API keys never reach the browser. It is not a relay: the server builds the
 * deployment of this session's Safe on this session's network (`vault_prepareDeployment`), or one call from the
 * deployed Safe (`vault_prepareTransaction`), and then only forwards that exact operation signed by its owner, once.
 * Gas, fees and paymaster fields never come from the browser.
 */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const { userId, chain } = guard.session;
  const limited = await rateLimit(request, 'aa', { sub: userId });
  if (limited) return limited;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const method = body?.method;
  const params = body?.params;
  if (typeof method !== 'string' || !Array.isArray(params)) return fail('INVALID_BODY', 400);
  if (!METHODS.has(method)) return fail('METHOD_NOT_ALLOWED', 403);

  if (!chain) return fail('CHAIN_NOT_SUPPORTED', 409);
  const config = chainConfig(chain.chainId);
  if (!config.bundlerUrl) return fail('CHAIN_NOT_SUPPORTED', 409);
  const bundler = { url: config.bundlerUrl, headers: config.bundlerHeaders };
  const set = await getActiveSet(userId);
  if (!set) return fail('NO_WALLET', 404);
  const { expectedAddress: owner, smartAccount: account } = set.manifest;

  try {
    if (method === RECEIPT_METHOD) {
      if (params.length !== 1 || typeof params[0] !== 'string' || !USER_OP_HASH.test(params[0])) return fail('INVALID_BODY', 400);
      const recorded = (await isRecordedUserOpHash(chain.chainId, account.address, params[0])) || (await isSentTransaction(chain.chainId, account.address, params[0]));
      if (!recorded) return fail('OPERATION_NOT_ALLOWED', 403);
      const outcome = await jsonRpc(bundler.url, method, [params[0]], bundler.headers);
      if ('error' in outcome) return json({ error: 'UPSTREAM_ERROR', rpcMessage: outcome.error.message }, 502);
      return json({ result: outcome.result });
    }

    // A fresh status each time: an already deployed Safe spends no more sponsorship.
    const assertDeployable = async () => {
      const status = await chainStatus(chain, owner, account);
      if (status.deployed) throw new SponsorshipError('ALREADY_DEPLOYED');
      if (!status.deployable) throw new ChainError('CHAIN_NOT_SUPPORTED');
    };

    if (method === PREPARE_METHOD) {
      if (params.length !== 0) return fail('INVALID_BODY', 400);
      await assertDeployable();
      // `chainStatus` has just checked this URL's `eth_chainId`.
      const rpcUrl = resolveRpcUrl(chain);
      const operation = await prepareDeployment({ chainId: chain.chainId, userId, owner, account, config, rpcUrl, bundler });
      return json({ result: operation });
    }

    if (method === PREPARE_TRANSACTION_METHOD) {
      let call;
      try {
        if (params.length !== 1) throw new Error('INVALID_BODY');
        call = parseVaultCall(params[0]);
      } catch {
        return fail('INVALID_BODY', 400);
      }
      // Its own budget, on top of `aa`: each prepared transaction may be sponsored, and costs paymaster and bundler calls.
      const limitedTransactions = await rateLimit(request, 'transaction', { sub: userId });
      if (limitedTransactions) return limitedTransactions;
      const rpcUrl = resolveRpcUrl(chain);
      await assertRpcChain(rpcUrl, chain.chainId);
      const operation = await prepareTransaction({ chainId: chain.chainId, userId, owner, account, config, rpcUrl, bundler }, call);
      return json({ result: operation });
    }

    const [operation, entryPoint] = params;
    if (params.length !== 2 || !isRecord(operation) || typeof entryPoint !== 'string' || entryPoint.toLowerCase() !== account.entryPoint.toLowerCase()) {
      return fail('INVALID_BODY', 400);
    }
    // Without `factory` it can only be a transaction from the deployed Safe, and only one this server prepared.
    if (operation.factory === undefined || operation.factory === null) {
      return json({ result: await submitTransaction({ chainId: chain.chainId, owner, account, bundler }, operation) });
    }
    if (!isDeploymentOperation(operation, owner, account)) return fail('OPERATION_NOT_ALLOWED', 403);
    const userOpHash = await submitDeployment({ chainId: chain.chainId, owner, account, bundler }, operation, assertDeployable);
    return json({ result: userOpHash });
  } catch (error) {
    return failure(error);
  }
}
