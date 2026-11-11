import { findDemoChain } from '@/server/chains';
import { handoffConfig, mintVaultToken } from '@/server/handoff';
import { fail, json, readJson, rejectForeignOrigin, sessionUser } from '@/server/http';

export const runtime = 'nodejs';
// Upstream calls (vault, RPC) have their own 10 s timeouts; this leaves room for a cold database connection.
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;

  const user = await sessionUser(request);
  if (!user) return fail('UNAUTHORIZED', 401);

  if (!handoffConfig()) return fail('INTERNAL', 500);

  // The body only picks a chain from `DEMO_CHAINS`: this server supplies the RPC, never the browser.
  const body = await readJson(request);
  const requested = body?.chainId;
  let chain;
  try {
    chain = requested === undefined ? null : findDemoChain(requested);
  } catch {
    return fail('INTERNAL', 500);
  }
  if (requested !== undefined && !chain) return fail('CHAIN_NOT_SUPPORTED', 400);

  return json({ token: mintVaultToken(user, chain ? { chainId: chain.chainId, rpcUrl: chain.rpcUrl } : undefined) });
}
