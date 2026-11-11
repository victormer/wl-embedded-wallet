import { NextResponse, type NextRequest } from 'next/server';
import { json, originError, requireSession } from '@/server/http';
import { markExported } from '@/server/store';

export const runtime = 'nodejs';

/** Audit: the user has downloaded their seed. It receives no data from it. */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;

  const exportedAt = new Date().toISOString();
  await markExported(guard.session.userId, exportedAt);
  return json({ exportedAt });
}
