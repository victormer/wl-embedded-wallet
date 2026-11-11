import { NextResponse, type NextRequest } from 'next/server';
import { checkHandoffRequest, HandoffError, spendHandoffToken, type HandoffClaims } from '@/server/handoff';
import { fail, json, originError, readJson, sessionToken, setSessionCookie } from '@/server/http';
import { rateLimitRule } from '@/server/limits';
import { consumeLimit, rateLimit, rateLimited } from '@/server/rate-limit';
import { createSession, deleteSession, setSessionChain, upsertUser } from '@/server/store';

export const runtime = 'nodejs';
// Several upstream calls (RPC, bundler, paymaster, JWKS), each capped at 10 s: explicit so it does not depend on the plan.
export const maxDuration = 60;

function rejection(error: unknown): NextResponse {
  if (error instanceof HandoffError) {
    if (error.reason === 'ORIGIN_MISMATCH' || error.reason === 'ORIGIN_NOT_ALLOWED') return fail(error.reason, 403);
    // The popup's network must be the one the app backend signed.
    if (error.reason === 'CHAIN_REQUEST_MISMATCH') return fail(error.reason, 400);
  }
  return fail('INVALID_TOKEN', 401);
}

export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  // Before verifying: a flood of forged tokens costs signature checks and JWKS refreshes.
  const limitedIp = await rateLimit(request, 'handoff');
  if (limitedIp) return limitedIp;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  if (typeof body?.token !== 'string') return fail('INVALID_TOKEN', 401);

  let claims: HandoffClaims;
  try {
    // Every rejection happens here, before the `jti` is spent: a token refused for the request can still be redeemed.
    claims = await checkHandoffRequest(body.token, { origin: body.origin, chainId: body.chainId });
  } catch (error) {
    return rejection(error);
  }
  // Only a signed `sub` has its own budget (the IP was counted above). A token refused for it is not spent either.
  const rule = rateLimitRule('handoff');
  if (rule.sub !== null) {
    const { allowed, retryAfterSeconds } = await consumeLimit(`handoff:sub:${claims.sub}`, rule.sub, rule.windowMs);
    if (!allowed) return rateLimited(retryAfterSeconds);
  }
  try {
    await spendHandoffToken(claims);
  } catch (error) {
    return rejection(error);
  }

  await upsertUser(claims.sub, claims.label);

  // Each token opens its own session and this browser's previous one is closed: it never carries over to another `sub`.
  const previous = sessionToken(request);
  if (previous) await deleteSession(previous);
  const token = await createSession(claims.sub, { appOrigin: claims.origin });
  await setSessionChain(token, claims.chain ?? null);

  const response = json({ userId: claims.sub, label: claims.label, origin: claims.origin });
  setSessionCookie(response, token);
  return response;
}
