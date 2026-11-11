import { readRuntimeConfig } from './runtime-config';
import { currentAppOrigin } from './vault-api';
import { secretBuffersOf, type WorkerMessage, type WorkerRequest, type WorkerResponse } from '@wl-embedded-wallet/core/types';

/** `prf` and `code` are transferred: they are left empty on the main thread after the call. */
export function transferablesOf(request: WorkerRequest): Transferable[] {
  return [...new Set(secretBuffersOf(request).map((bytes) => bytes.buffer as ArrayBuffer))];
}

let workerFactory: () => Worker = () => new Worker(new URL('./signer.worker.ts', import.meta.url), { type: 'module' });

/** The static recovery page loads its worker from a different file. The logic is the same. */
export function setSignerWorkerFactory(factory: () => Worker): void {
  workerFactory = factory;
}

/** Each operation uses a new worker, which replies exactly once and then closes. */
export function runSigner(
  request: WorkerRequest,
  createWorker: () => Worker = workerFactory,
  manifestPubKey?: string,
): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    const finish = (response: WorkerResponse) => {
      worker?.terminate();
      resolve(response);
    };
    const fail = () => finish({ ok: false, code: 'INTERNAL' });
    try {
      worker = createWorker();
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => finish(event.data);
      worker.onerror = fail;
      worker.onmessageerror = fail;
      const message: WorkerMessage = { request, appOrigin: currentAppOrigin(), manifestPubKey: manifestPubKey ?? readRuntimeConfig().manifestPubKey };
      worker.postMessage(message, transferablesOf(request));
    } catch {
      fail();
    }
  });
}
