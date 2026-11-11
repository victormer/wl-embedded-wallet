import { generateSecret, generateURI } from 'otplib';
import { setTotpSecret } from '@/server/db';
import { fail, json, pendingSessionUser, rejectForeignOrigin } from '@/server/http';
import { limitByIp, limitByUser } from '@/server/rate-limit';
import { sealTotpSecret } from '@/server/totp';

export const runtime = 'nodejs';

const ISSUER = 'Acme Wallet Demo';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;
  const limitedIp = await limitByIp(request, 'totp-setup');
  if (limitedIp) return limitedIp;

  const user = await pendingSessionUser(request);
  if (!user) return fail('UNAUTHORIZED', 401);
  const limitedUser = await limitByUser(user.id, 'totp-setup');
  if (limitedUser) return limitedUser;

  const secret = generateSecret();
  let sealed: string;
  try {
    sealed = sealTotpSecret(secret, user.id);
  } catch {
    return fail('INTERNAL', 500);
  }
  if (!(await setTotpSecret(user.id, sealed))) return fail('TOTP_ALREADY_ENROLLED', 409);
  return json({ secret, otpauthUri: generateURI({ issuer: ISSUER, label: user.email, secret }) });
}
