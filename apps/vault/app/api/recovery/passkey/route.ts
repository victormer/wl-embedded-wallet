import { NextResponse, type NextRequest } from 'next/server';
import { fail, json, originError, readJson } from '@/server/http';
import { rateLimit } from '@/server/rate-limit';
import { advanceCredentialCounter, getActiveSetByCredential } from '@/server/store';
import { CredentialRejected, isAssertion, spendChallenge, verifyAssertion } from '@/server/webauthn';

export const runtime = 'nodejs';

/** The same response for everything: challenge, unknown credential, missing public key, signature or counter. */
const rejected = () => fail('RECOVERY_FAILED', 401);

/**
 * No JWT: the user proves they hold the passkey. Returns only `encB`, `encC` and that credential's manifest.
 * **Share A is never returned**: without the code, none of this reconstructs the seed. It opens no session.
 */
export async function POST(request: NextRequest) {
  const forbidden = originError(request, { write: true });
  if (forbidden) return forbidden;
  // Per IP only, before anything is read: the budget and the answer are the same whether or not the credential exists.
  const limited = await rateLimit(request, 'recovery-assertion');
  if (limited) return limited;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const assertion = body?.assertion;
  if (!isAssertion(assertion)) return rejected();
  try {
    await spendChallenge(assertion.response.clientDataJSON, 'recover', null);
    const set = await getActiveSetByCredential(assertion.id);
    if (!set) return rejected();
    const counter = await verifyAssertion(assertion, set);
    if (!(await advanceCredentialCounter(set.setId, set.credential?.counter ?? 0, counter))) return rejected();
    return json({
      setId: set.setId,
      credentialId: set.credentialId,
      encB: set.encB,
      encC: set.encC,
      manifest: set.manifest,
      signature: set.signature,
    });
  } catch (error) {
    if (error instanceof CredentialRejected) return rejected();
    throw error;
  }
}
