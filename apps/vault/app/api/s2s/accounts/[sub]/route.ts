import type { NextRequest } from 'next/server';
import { ChainError, chainStatus } from '@/server/chains';
import { constantTimeEquals, fail, json } from '@/server/http';
import { parsePositiveInteger, rateLimitRule } from '@/server/limits';
import { consumeLimit, rateLimit, rateLimited } from '@/server/rate-limit';
import { getAccount, getActiveSet } from '@/server/store';

export const runtime = 'nodejs';
// Several upstream calls (RPC, bundler, paymaster, JWKS), each capped at 10 s: explicit so it does not depend on the plan.
export const maxDuration = 60;

const BEARER = 'Bearer ';
// The handoff `sub` pattern (`server/handoff.ts`): no account can have any other.
const SUB = /^[A-Za-z0-9_-]{1,64}$/;
const CHAIN_ID = /^[1-9][0-9]{0,15}$/;

/** A positive safe integer: a larger one would be rounded by `Number`, and answer for another chain. */
function chainIdOf(value: string): number | null {
  return CHAIN_ID.test(value) ? parsePositiveInteger(value) : null;
}

/**
 * For the app's server only. Returns public data only. The input is validated, and the limits counted, before
 * anything is looked up: the answers and the budgets are the same whether or not the account exists.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ sub: string }> }) {
  // Per IP before the bearer check, so guessing the token is throttled too.
  const limited = await rateLimit(request, 's2s');
  if (limited) return limited;
  const expected = process.env.VAULT_SERVICE_TOKEN;
  const header = request.headers.get('authorization') ?? '';
  if (!expected || !header.startsWith(BEARER) || !constantTimeEquals(header.slice(BEARER.length), expected)) {
    return fail('UNAUTHORIZED', 401);
  }
  const { sub } = await context.params;
  if (!SUB.test(sub)) return fail('INVALID_SUB', 400);
  const chainIdParam = request.nextUrl.searchParams.get('chainId');
  const chainId = chainIdParam === null ? null : chainIdOf(chainIdParam);
  if (chainIdParam !== null && chainId === null) return fail('INVALID_CHAIN_ID', 400);
  // Per `sub` only after the bearer check: an anonymous caller cannot spend a user's budget.
  const rule = rateLimitRule('s2s');
  if (rule.sub !== null) {
    const { allowed, retryAfterSeconds } = await consumeLimit(`s2s:sub:${sub}`, rule.sub, rule.windowMs);
    if (!allowed) return rateLimited(retryAfterSeconds);
  }

  const account = await getAccount(sub);
  if (chainId === null || !account.exists) return json(account);

  const { expectedAddress, smartAccount } = (await getActiveSet(sub))!.manifest;
  try {
    const status = await chainStatus({ chainId, rpcUrl: request.nextUrl.searchParams.get('rpcUrl') }, expectedAddress, smartAccount);
    return json({ ...account, chainId, deployed: status.deployed, deployable: status.deployable, sponsored: status.sponsored, transactionsSponsored: status.transactionsSponsored });
  } catch (error) {
    return json({ ...account, chainId, deployed: null, deployable: false, chainError: error instanceof ChainError ? error.code : 'CHAIN_UNAVAILABLE' });
  }
}
