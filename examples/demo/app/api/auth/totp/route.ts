import { verify } from 'otplib';
import { confirmTotp, consumeTotpStep, createSession, deleteSession } from '@/server/db';
import { fail, json, pendingSessionUser, readJson, rejectForeignOrigin, sessionCookie, sessionTokenFrom } from '@/server/http';
import { limitByIp, limitByUser } from '@/server/rate-limit';
import { openTotpSecret } from '@/server/totp';

export const runtime = 'nodejs';

const TOTP_FORMAT = /^[0-9]{6}$/;
const EPOCH_TOLERANCE_SECONDS = 30;
const PERIOD_SECONDS = 30;

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectForeignOrigin(request);
  if (rejected) return rejected;
  const limitedIp = await limitByIp(request, 'totp');
  if (limitedIp) return limitedIp;

  const user = await pendingSessionUser(request);
  if (!user) return fail('UNAUTHORIZED', 401);
  // Per account, whatever the address: caps guessing the 6-digit code with the password in hand.
  const limitedUser = await limitByUser(user.id, 'totp');
  if (limitedUser) return limitedUser;

  const totp = (await readJson(request))?.totp;
  if (typeof totp !== 'string' || !TOTP_FORMAT.test(totp) || !user.totpSecretEnc) return fail('INVALID_TOTP', 401);

  let secret: string;
  try {
    secret = openTotpSecret(user.totpSecretEnc, user.id);
  } catch {
    return fail('INTERNAL', 500);
  }
  // Each code works once: only a step after the last accepted one counts. The step recorded is the one the code
  // matched, which can be the previous or the next one within the tolerance, not the current one.
  const epoch = Math.floor(Date.now() / 1000);
  const afterTimeStep = user.totpLastStep ?? undefined;
  // otplib throws if `afterTimeStep` is past the newest step in the window; no code can be valid then.
  if (afterTimeStep !== undefined && afterTimeStep >= Math.floor((epoch + EPOCH_TOLERANCE_SECONDS) / PERIOD_SECONDS)) return fail('INVALID_TOTP', 401);
  const result = await verify({ secret, token: totp, epoch, period: PERIOD_SECONDS, epochTolerance: EPOCH_TOLERANCE_SECONDS, afterTimeStep });
  if (!result.valid || !('timeStep' in result) || !(await consumeTotpStep(user.id, result.timeStep))) return fail('INVALID_TOTP', 401);
  if (!user.totpConfirmed && !(await confirmTotp(user.id, user.totpSecretEnc))) return fail('INVALID_TOTP', 401);

  // New token on step-up: the one from the intermediate session stops being valid.
  await deleteSession(sessionTokenFrom(request) as string);
  const session = await createSession(user.id, { secondFactorDone: true });
  return json({ userId: user.id, email: user.email }, 200, { 'Set-Cookie': sessionCookie(session) });
}
