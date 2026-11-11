import { NextResponse, type NextRequest } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { b64urlEncode, randomBytes } from '@wl-embedded-wallet/core/encoding';
import type { RelinkChallenge } from '@wl-embedded-wallet/core/types';
import { fail, json, originError, readJson, requireSession } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { createRelinkNonce, findActiveSetsByOwner, getActiveSet } from '@/server/store';

export const runtime = 'nodejs';

const NONCE_BYTES = 32;
const TTL_SECONDS = 5 * 60;

/**
 * Always responds the same way, whether or not the wallet exists: this route does not reveal which addresses are in the vault.
 * Without exactly one wallet with that owner and that Safe, the nonce is created with no source wallet and its use will be rejected.
 */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const { userId } = guard.session;
  const limited = await rateLimit(request, 'relink-nonce', { sub: userId });
  if (limited) return limited;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const { safe, owner } = body ?? {};
  if (typeof safe !== 'string' || !isAddress(safe) || typeof owner !== 'string' || !isAddress(owner)) return fail('INVALID_BODY', 400);
  if (await getActiveSet(userId)) return fail('WALLET_ALREADY_EXISTS', 409);

  const candidates = (await findActiveSetsByOwner(owner)).filter((set) => getAddress(set.manifest.smartAccount.address) === getAddress(safe));
  const nonce = b64urlEncode(randomBytes(NONCE_BYTES));
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  await createRelinkNonce({
    nonce,
    userId,
    safe: getAddress(safe),
    owner: getAddress(owner),
    fromUser: candidates.length === 1 ? candidates[0].userId : null,
    expiresAt: expiresAt * 1000,
  });
  const challenge: RelinkChallenge = {
    safe: getAddress(safe),
    owner: getAddress(owner),
    newSub: userId,
    issuer: process.env.HANDOFF_ISSUER ?? '',
    vaultOrigin: process.env.ORIGIN ?? '',
    nonce,
    expiresAt,
  };
  return json(challenge);
}
