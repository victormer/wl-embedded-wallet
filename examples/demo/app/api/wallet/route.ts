import { findDemoChain } from '@/server/chains';
import { fail, json, sessionUser } from '@/server/http';
import { fetchVaultAccount } from '@/server/vault';

export const runtime = 'nodejs';
// Upstream calls (vault, RPC) have their own 10 s timeouts; this leaves room for a cold database connection.
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await sessionUser(request);
  if (!user) return fail('UNAUTHORIZED', 401);

  const chainIdParam = new URL(request.url).searchParams.get('chainId');
  let chain;
  try {
    chain = chainIdParam === null ? null : findDemoChain(Number(chainIdParam));
  } catch {
    return fail('INTERNAL', 500);
  }
  if (chainIdParam !== null && !chain) return fail('CHAIN_NOT_SUPPORTED', 400);

  try {
    return json(await fetchVaultAccount(user.id, chain ?? undefined));
  } catch {
    return fail('VAULT_UNAVAILABLE', 502);
  }
}
