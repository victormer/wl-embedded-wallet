import type { UserOperationJson } from '@wl-embedded-wallet/sdk/server';
import type { Hex } from 'viem';
import { findDemoChain } from '@/server/chains';
import { fail, json, readJson, rejectForeignOrigin, sessionUser } from '@/server/http';
import { fetchVaultAccount } from '@/server/vault';
import { parseSignRequest, verifySignature } from '@/server/verify';

export const runtime = 'nodejs';
// Upstream calls (vault, RPC) have their own 10 s timeouts; this leaves room for a cold database connection.
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;

  const user = await sessionUser(request);
  if (!user) return fail('UNAUTHORIZED', 401);

  const body = await readJson(request);
  const signRequest = parseSignRequest(body?.request);
  if (!signRequest || typeof body?.signature !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.signature)) {
    return fail('INVALID_INPUT', 400);
  }
  let chain;
  try {
    chain = findDemoChain(body.chainId);
  } catch {
    return fail('INTERNAL', 500);
  }
  if (!chain) return fail('CHAIN_NOT_SUPPORTED', 400);

  let account;
  try {
    account = await fetchVaultAccount(user.id);
  } catch {
    return fail('VAULT_UNAVAILABLE', 502);
  }
  if (!account.exists) return fail('NO_WALLET', 409);

  const result = await verifySignature(signRequest, body.signature as Hex, account, chain, body.userOperation as UserOperationJson | undefined);
  return json({ ...result, expected: account.owner, chainId: chain.chainId });
}
