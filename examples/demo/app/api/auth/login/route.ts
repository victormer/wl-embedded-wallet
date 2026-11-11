import { parseCredentials } from '@/server/credentials';
import { createSession, getUserByEmail } from '@/server/db';
import { fail, json, readJson, rejectForeignOrigin, sessionCookie } from '@/server/http';
import { burnPasswordCheck, verifyPassword } from '@/server/password';
import { limitByIp } from '@/server/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;
  // Before scrypt: the limit must cost less than the work it protects.
  const limited = await limitByIp(request, 'login');
  if (limited) return limited;

  const credentials = parseCredentials(await readJson(request));
  if (!credentials) return fail('INVALID_CREDENTIALS', 401);

  const user = await getUserByEmail(credentials.email);
  if (!user) {
    await burnPasswordCheck(credentials.password);
    return fail('INVALID_CREDENTIALS', 401);
  }
  if (!(await verifyPassword(credentials.password, user))) return fail('INVALID_CREDENTIALS', 401);

  // The password alone does not open the session. An account created before 2FA sets it up now.
  const session = await createSession(user.id, { secondFactorDone: false });
  return json({ next: user.totpConfirmed ? 'totp' : 'totp-setup' }, 200, { 'Set-Cookie': sessionCookie(session) });
}
