import type { NextRequest } from 'next/server';
import { json, originError } from '@/server/http';
import { recoveryChallengeMaxLive } from '@/server/limits';
import { rateLimit, rateLimited } from '@/server/rate-limit';
import { issueChallenge } from '@/server/webauthn';

export const runtime = 'nodejs';

// Until a slot frees up: the oldest live challenge expires within its 5-minute lifetime.
const FULL_RETRY_SECONDS = 60;

/**
 * No session: whoever has lost their login has no other way to start. Each call stores a row, so it is limited per IP,
 * and the live challenges are capped for everyone: a flood from many addresses cannot grow the table without bound.
 */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const limited = await rateLimit(request, 'recovery-challenge');
  if (limited) return limited;
  const challenge = await issueChallenge('recover', null, { maxLive: recoveryChallengeMaxLive() });
  // The same answer as the per-IP limit: the client waits and retries either way.
  if (challenge === null) return rateLimited(FULL_RETRY_SECONDS);
  return json({ challenge });
}
