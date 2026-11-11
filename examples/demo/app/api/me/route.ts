import { fail, json, sessionUser } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await sessionUser(request);
  if (!user) return fail('UNAUTHORIZED', 401);
  return json({ userId: user.id, email: user.email });
}
