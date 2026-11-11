import { handleWorkerRequest, type SignerDeps } from '@wl-embedded-wallet/core/signer';
import { WalletError, type WorkerMessage, type WorkerResponse } from '@wl-embedded-wallet/core/types';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: WorkerResponse): void;
  close(): void;
};

const noBackend = async (): Promise<never> => {
  throw new WalletError('NETWORK');
};

// This page has no server: B+C and kit with code call none of these.
const deps: Omit<SignerDeps, 'manifestPubKey'> = { fetchShareA: noBackend, postShares: noBackend, fetchChainStatus: noBackend };

scope.onmessage = async ({ data }) => {
  const response = await handleWorkerRequest(data.request, { ...deps, manifestPubKey: data.manifestPubKey });
  scope.postMessage(response);
  scope.close();
};
