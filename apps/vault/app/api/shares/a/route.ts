import { NextResponse, type NextRequest } from 'next/server';
import { isUuid } from '@wl-embedded-wallet/core/schema';
import { fail, json, originError, requireSession, serverKeyMismatch, sessionHash } from '@/server/http';
import { openShareA } from '@/server/kms';
import { shareALimits } from '@/server/limits';
import { consumeLimit, rateLimit, rateLimited } from '@/server/rate-limit';
import { getSet, recordShareARelease, SESSION_TTL_MS, type ShareSetRecord } from '@/server/store';

export const runtime = 'nodejs';

/**
 * A `pending` set is only needed by the drill of the enrollment that created it, in that same session. Any other
 * session gets A only once the set is active. Sets created before their session was recorded never qualify.
 */
function releasable(set: ShareSetRecord, session: string, now: number): boolean {
  if (set.status === 'active') return true;
  if (set.status !== 'pending' || !set.createdSessionHash || set.createdSessionHash !== session) return false;
  // A negative age is only clock skew between replicas; an unparsable date is never younger.
  return now - Date.parse(set.createdAt) < SESSION_TTL_MS;
}

export async function GET(request: NextRequest) {
  const forbidden = originError(request, { write: false });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const { userId, appOrigin } = guard.session;
  const limited = await rateLimit(request, 'share-a', { sub: userId });
  if (limited) return limited;

  const setId = request.nextUrl.searchParams.get('setId');
  if (!isUuid(setId)) return fail('INVALID_SET_ID', 400);

  // Counted before the lookup, so the answer is the same whether or not the set exists.
  const session = sessionHash(guard.token);
  const { windowMs, perSession, perUser } = shareALimits();
  const budgets = await Promise.all([
    consumeLimit(`share-a-release:session:${session}`, perSession, windowMs),
    consumeLimit(`share-a-release:sub:${userId}`, perUser, windowMs),
  ]);
  const exceeded = budgets.filter((budget) => !budget.allowed);
  if (exceeded.length) return rateLimited(Math.max(...exceeded.map((budget) => budget.retryAfterSeconds)));

  const set = await getSet(userId, setId);
  if (!set) return fail('NOT_FOUND', 404);
  if (set.status === 'revoked' || !set.encA) return fail('REVOKED', 410);
  // As if it did not exist: whoever is not entitled learns nothing about the set.
  if (!releasable(set, session, Date.now())) return fail('NOT_FOUND', 404);

  let shareA: string;
  try {
    // The manifest's `sub`: relinking to another account moves the set, and A was encrypted with the `sub` of that time.
    shareA = await openShareA(set.encA, { userId: set.manifest.userId, setId });
  } catch {
    return serverKeyMismatch();
  }
  // Recorded before A leaves: a release that cannot be recorded does not happen. Neither A nor the token is stored.
  await recordShareARelease({
    userId,
    setId,
    setStatus: set.status as 'pending' | 'active',
    sessionHash: session,
    appOrigin,
    releasedAt: new Date().toISOString(),
  });
  return json({ shareA });
}
