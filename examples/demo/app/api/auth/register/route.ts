import { createSession, createUser } from '@/server/db';
import { fail, json, readJson, rejectForeignOrigin, sessionCookie } from '@/server/http';
import { hashPassword } from '@/server/password';
import { parseCredentials } from '@/server/credentials';
import { limitByIp } from '@/server/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;
  // Before scrypt: the limit must cost less than the work it protects.
  const limited = await limitByIp(request, 'register');
  if (limited) return limited;

  const credentials = parseCredentials(await readJson(request));
  if (!credentials) return fail('INVALID_INPUT', 400);

  const user = await createUser({ email: credentials.email, ...(await hashPassword(credentials.password)) });
  if (!user) return fail('EMAIL_TAKEN', 409);

  // Without the second factor, this session can only be used to set it up.
  const session = await createSession(user.id, { secondFactorDone: false });
  return json({ userId: user.id, email: user.email, next: 'totp-setup' }, 201, { 'Set-Cookie': sessionCookie(session) });
}
