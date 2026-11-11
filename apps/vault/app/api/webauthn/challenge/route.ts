import { NextResponse, type NextRequest } from 'next/server';
import { json, originError, requireSession } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { issueChallenge } from '@/server/webauthn';

export const runtime = 'nodejs';

/** Challenge for creating the passkey, bound to this session. `POST /api/shares` spends it when storing the public key. */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const limited = await rateLimit(request, 'enroll', { sub: guard.session.userId });
  if (limited) return limited;
  return json({ challenge: await issueChallenge('register', guard.session.userId) });
}
