import { NextResponse, type NextRequest } from 'next/server';
import { sha256Hex, hexDecode } from '@wl-embedded-wallet/core/encoding';
import { buildManifest, signManifest } from '@wl-embedded-wallet/core/manifest';
import { isB64url, isDigest, isEnvelope, isRecord, isShareHex, isUuid } from '@wl-embedded-wallet/core/schema';
import { getAddress, isAddress } from 'viem';
import { canonicalize } from '@wl-embedded-wallet/core/manifest';
import { fail, json, originError, readJson, requireSession, sessionHash } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { isNewSmartAccount } from '@/server/safe-check';
import { sealShareA } from '@/server/kms';
import { activateSet, createSet, findActiveSetsByOwner, getActiveSet, getSet, getUser } from '@/server/store';
import { CredentialRejected, verifyRegistration } from '@/server/webauthn';

export const runtime = 'nodejs';
// Several upstream calls (RPC, bundler, paymaster, JWKS), each capped at 10 s: explicit so it does not depend on the plan.
export const maxDuration = 60;

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const { userId } = guard.session;
  const limited = await rateLimit(request, 'enroll', { sub: userId });
  if (limited) return limited;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  if (!body) return fail('INVALID_BODY', 400);
  // The seed backup only lives in the kit. If it arrived here, it would be a client bug: better not to accept it.
  if ('seedBackup' in body) return fail('INVALID_BODY', 400);
  const { setId, credentialId, shareA, encB, encC, shareDigests, expectedAddress, smartAccount, wdkUtilsVersion, registration } = body;
  const valid =
    isUuid(setId) &&
    isB64url(credentialId, 1024) &&
    isShareHex(shareA) &&
    isEnvelope(encB, 'B', 'prf-hkdf-sha256') &&
    isEnvelope(encC, 'C', 'argon2id') &&
    isRecord(shareDigests) &&
    isDigest(shareDigests.A) &&
    isDigest(shareDigests.B) &&
    isDigest(shareDigests.C) &&
    typeof expectedAddress === 'string' &&
    isAddress(expectedAddress) &&
    typeof wdkUtilsVersion === 'string' &&
    VERSION.test(wdkUtilsVersion);
  if (!valid) return fail('INVALID_BODY', 400);
  if (encB.userId !== userId || encC.userId !== userId || encB.setId !== setId || encC.setId !== setId) {
    return fail('ENVELOPE_MISMATCH', 400);
  }
  if ((await sha256Hex(hexDecode(shareA))) !== shareDigests.A) return fail('DIGEST_MISMATCH', 400);
  if (await getSet(userId, setId)) return fail('SET_EXISTS', 409);

  // A rotation keeps the address. A different one would replace the wallet and leave the funds inaccessible.
  const active = await getActiveSet(userId);
  if (active && getAddress(active.manifest.expectedAddress) !== getAddress(expectedAddress)) {
    return fail('WALLET_ALREADY_EXISTS', 409);
  }
  // The client declares the address. One that already belongs to another `sub` can only be obtained by relinking it, with its signature.
  if (!active && (await findActiveSetsByOwner(expectedAddress)).length > 0) return fail('WALLET_ALREADY_EXISTS', 409);
  // A rotation keeps the Safe's signed parameters; a new wallet uses the current ones.
  const accountValid = active
    ? canonicalize(smartAccount) === canonicalize(active.manifest.smartAccount)
    : isNewSmartAccount(smartAccount, expectedAddress);
  if (!accountValid) return fail('SMART_ACCOUNT_MISMATCH', 400);

  // The last step before creating the set: it spends the challenge, so an earlier error allows retrying without repeating the passkey.
  let credential: { publicKey: string; counter: number } | undefined;
  if (registration !== undefined) {
    try {
      credential = await verifyRegistration(registration, credentialId, userId);
    } catch (error) {
      if (error instanceof CredentialRejected) return fail('CREDENTIAL_INVALID', 400);
      throw error;
    }
  }

  const manifest = buildManifest({
    userId,
    setId,
    shareDigests: { A: shareDigests.A as string, B: shareDigests.B as string, C: shareDigests.C as string },
    expectedAddress,
    smartAccount: active ? active.manifest.smartAccount : undefined,
    wdkUtilsVersion,
  });
  const signed = signManifest(manifest, process.env.MANIFEST_SIGNING_KEY ?? '');
  const created = await createSet({
    setId,
    userId,
    credentialId,
    manifest,
    signature: signed.signature,
    createdAt: manifest.createdAt,
    encA: await sealShareA(shareA, { userId, setId }),
    encB,
    encC,
    ...(credential ? { credential } : {}),
    // Only this session can read A of the set while it is pending, for the drill (`GET /api/shares/a`).
    createdSessionHash: sessionHash(guard.token),
  });
  if (!created) return fail('SET_EXISTS', 409);
  return json(signed, 201);
}

export async function GET(request: NextRequest) {
  const forbidden = originError(request, { write: false });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const { userId } = guard.session;

  const setId = request.nextUrl.searchParams.get('setId');
  if (setId !== null && !isUuid(setId)) return fail('INVALID_SET_ID', 400);
  const set = setId === null ? await getActiveSet(userId) : await getSet(userId, setId);
  if (!set) return fail('NOT_FOUND', 404);
  if (set.status === 'revoked') return fail('REVOKED', 410);

  return json({
    setId: set.setId,
    status: set.status,
    encB: set.encB,
    encC: set.encC,
    credentialId: set.credentialId,
    manifest: set.manifest,
    signature: set.signature,
    exportedAt: (await getUser(userId))?.exportedAt ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  const guard = await requireSession(request);
  if (guard instanceof NextResponse) return guard;
  const limited = await rateLimit(request, 'enroll', { sub: guard.session.userId });
  if (limited) return limited;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  if (!isUuid(body?.setId)) return fail('INVALID_SET_ID', 400);
  const set = await activateSet(guard.session.userId, body.setId);
  if (!set) return fail('NOT_FOUND', 404);
  if (set.status === 'revoked') return fail('REVOKED', 410);
  if (set.status === 'pending') return fail('WALLET_ALREADY_EXISTS', 409);
  return json({ status: 'active' });
}
