import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from '@wl-embedded-wallet/core/encoding';
import { runSigner, transferablesOf } from '../../lib/signer-client';
import type { WorkerRequest } from '@wl-embedded-wallet/core/types';

const signed = { manifest: {}, signature: '' } as never;
const env = {} as never;

function fakeWorker() {
  const worker = {
    terminate: vi.fn(),
    postMessage: vi.fn(),
    onmessage: null as null | ((event: unknown) => void),
    onerror: null as null | (() => void),
    onmessageerror: null as null | (() => void),
  };
  return worker;
}

describe('transferablesOf', () => {
  it('includes only the operation buffers, without duplicates', () => {
    const prf = randomBytes(32);
    const code = randomBytes(26);
    const code2 = randomBytes(26);
    expect(transferablesOf({ op: 'recover', combo: 'A+B', signed, encB: env, prf })).toEqual([prf.buffer]);
    expect(transferablesOf({ op: 'recover', combo: 'A+C', signed, encC: env, code })).toEqual([code.buffer]);
    expect(transferablesOf({ op: 'recover', combo: 'B+C', signed, encB: env, encC: env, prf, code })).toEqual([prf.buffer, code.buffer]);
    expect(
      transferablesOf({ op: 'sign', chainId: 1, signed, encB: env, prf, request: { kind: 'message', message: 'x' } }),
    ).toEqual([prf.buffer]);
    expect(
      transferablesOf({
        op: 'enroll', userId: 'u', setId: 's', credentialId: 'c', prf, code,
        source: { op: 'recover', combo: 'A+C', signed, encC: env, code: code2 },
      }),
    ).toEqual([prf.buffer, code.buffer, code2.buffer]);
    expect(
      transferablesOf({
        op: 'enroll', userId: 'u', setId: 's', credentialId: 'c', prf, code,
        source: { op: 'recover', combo: 'A+C', signed, encC: env, code },
      }),
    ).toEqual([prf.buffer, code.buffer]);
  });
});

describe('runSigner', () => {
  const request: WorkerRequest = { op: 'recover', combo: 'A+B', signed, encB: env, prf: randomBytes(32) };

  it('returns the single response and terminates the worker', async () => {
    const worker = fakeWorker();
    const promise = runSigner(request, () => worker as never, 'public-key');
    expect(worker.postMessage).toHaveBeenCalledWith({ request, appOrigin: null, manifestPubKey: 'public-key' }, [request.op === 'recover' && request.combo === 'A+B' ? request.prf.buffer : null]);
    worker.onmessage!({ data: { ok: true, address: '0x1', wdkVersionMismatch: false } });
    await expect(promise).resolves.toEqual({ ok: true, address: '0x1', wdkVersionMismatch: false });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('a worker error becomes INTERNAL', async () => {
    const worker = fakeWorker();
    const promise = runSigner(request, () => worker as never, 'public-key');
    worker.onerror!();
    await expect(promise).resolves.toEqual({ ok: false, code: 'INTERNAL' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('returns INTERNAL if the worker cannot be created', async () => {
    await expect(
      runSigner(request, () => {
        throw new Error('x');
      }),
    ).resolves.toEqual({ ok: false, code: 'INTERNAL' });
  });
});
