import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeHandoff, fetchRecoveryChallenge, fetchRegisterChallenge, fetchShareSet, postRecoveryAssertion, requestRelinkChallenge } from '../../lib/vault-api';
import type { AssertionJson } from '@wl-embedded-wallet/core/types';

const limited = () => new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429, headers: { 'Retry-After': '30' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('vault page API client', () => {
  // Before, a 429 reached the user and the app as INTERNAL, as if the vault had failed.
  it.each([
    ['token redemption', () => exchangeHandoff('token', 'https://app.test')],
    ['the register challenge', () => fetchRegisterChallenge()],
    ['the share set', () => fetchShareSet()],
    ['the kit-free recovery challenge', () => fetchRecoveryChallenge()],
    ['the kit-free recovery assertion', () => postRecoveryAssertion({} as AssertionJson)],
    ['the relink nonce', () => requestRelinkChallenge('0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002')],
  ])('%s: a 429 becomes RATE_LIMITED', async (_name, run) => {
    vi.stubGlobal('fetch', vi.fn(async () => limited()));
    await expect(run()).rejects.toMatchObject({ name: 'WalletError', code: 'RATE_LIMITED' });
  });

  it('other server failures are still INTERNAL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(fetchRegisterChallenge()).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(fetchRecoveryChallenge()).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
