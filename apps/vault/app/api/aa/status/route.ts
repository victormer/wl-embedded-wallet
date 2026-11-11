import { NextResponse, type NextRequest } from 'next/server';
import { ChainError, chainStatus } from '@/server/chains';
import { fail, json, originError, requireSession } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { getActiveSet } from '@/server/store';

export const runtime = 'nodejs';
// Several upstream calls (RPC, bundler, paymaster, JWKS), each capped at 10 s: explicit so it does not depend on the plan.
export const maxDuration = 60;

/** Status of the session's Safe on the session's network. */
export async function GET(request: NextRequest) {
  const forbidden = originError(request, { write: false });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;

  const { userId, chain } = guard.session;
  // Each call costs up to nine node RPC calls.
  const limited = await rateLimit(request, 'aa', { sub: userId });
  if (limited) return limited;
  if (!chain) return fail('CHAIN_NOT_SUPPORTED', 409);
  const set = await getActiveSet(userId);
  if (!set) return fail('NO_WALLET', 404);
  try {
    return json(await chainStatus(chain, set.manifest.expectedAddress, set.manifest.smartAccount));
  } catch (error) {
    return fail(error instanceof ChainError ? error.code : 'CHAIN_UNAVAILABLE', 409);
  }
}
