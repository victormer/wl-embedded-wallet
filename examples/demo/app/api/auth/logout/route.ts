import { deleteSession } from '@/server/db';
import { clearedSessionCookie, json, rejectForeignOrigin, sessionTokenFrom } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;

  const token = sessionTokenFrom(request);
  if (token) await deleteSession(token);
  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
}
