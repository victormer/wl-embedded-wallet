import { NextResponse, type NextRequest } from 'next/server';
import { getAddress, isHex, recoverTypedDataAddress } from 'viem';
import { relinkTypedData } from '@wl-embedded-wallet/core/relink';
import { fail, json, originError, readJson, requireSession } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { getRelinkNonce, relinkWallet } from '@/server/store';

export const runtime = 'nodejs';

/** Nonce spent or expired, bad signature, wallet moved: the reason is not disclosed. */
const rejected = () => fail('RELINK_REJECTED', 403);

/**
 * A valid JWT only says who the new `sub` is. What moves the wallet is the owner's signature over a message
 * that the server rebuilds from its own values: the browser only supplies the nonce and the signature.
 */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const { userId, appOrigin } = guard.session;
  const limited = await rateLimit(request, 'relink', { sub: userId });
  if (limited) return limited;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const { nonce, signature } = body ?? {};
  if (typeof nonce !== 'string' || typeof signature !== 'string' || !isHex(signature)) return fail('INVALID_BODY', 400);

  const record = await getRelinkNonce(nonce, userId);
  if (!record) return rejected();
  const issuer = process.env.HANDOFF_ISSUER ?? '';
  const vaultOrigin = process.env.ORIGIN ?? '';
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({
      ...relinkTypedData({
        safe: record.safe as `0x${string}`,
        owner: record.owner as `0x${string}`,
        newSub: userId,
        issuer,
        vaultOrigin,
        nonce,
        expiresAt: record.expiresAt / 1000,
      }),
      signature,
    });
  } catch {
    return rejected();
  }
  if (getAddress(signer) !== getAddress(record.owner)) return rejected();

  const result = await relinkWallet({ nonce, userId, signature, issuer, vaultOrigin, appOrigin });
  if (result === 'HAS_WALLET') return fail('WALLET_ALREADY_EXISTS', 409);
  if (result !== 'LINKED') return rejected();
  return json({ address: record.safe, owner: record.owner });
}
