import { handleWorkerRequest, type SignerDeps } from '@wl-embedded-wallet/core/signer';
import { WalletError, type ChainStatus, type CreateSharesBody, type WalletErrorCode, type SignedManifest, type WorkerMessage, type WorkerResponse } from '@wl-embedded-wallet/core/types';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: WorkerResponse): void;
  close(): void;
};

let appOrigin: string | null = null;

function withOrigin(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (appOrigin) headers.set('X-Vault-App-Origin', appOrigin);
  return { credentials: 'same-origin', cache: 'no-store', ...init, headers };
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, withOrigin(init));
  } catch {
    throw new WalletError('NETWORK');
  }
  if (response.status === 401 || response.status === 403) throw new WalletError('UNAUTHORIZED');
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.status === 429) throw new WalletError('RATE_LIMITED');
    throw new WalletError(body?.error === 'SERVER_KEY_MISMATCH' ? 'SERVER_KEY_MISMATCH' : 'INTERNAL');
  }
  return response;
}

const deps: Omit<SignerDeps, 'manifestPubKey'> = {
  async fetchShareA(setId: string) {
    const response = await request(`/api/shares/a?setId=${encodeURIComponent(setId)}`);
    const { shareA } = (await response.json()) as { shareA: string };
    return shareA;
  },

  async fetchChainStatus() {
    const response = await fetch('/api/aa/status', withOrigin()).catch(() => {
      throw new WalletError('NETWORK');
    });
    const body = (await response.json().catch(() => null)) as (ChainStatus & { error?: WalletErrorCode }) | null;
    if (!response.ok || !body || body.error) throw new WalletError(body?.error ?? 'INTERNAL');
    return body;
  },

  async postShares(body: CreateSharesBody) {
    const response = await request('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as SignedManifest;
  },
};

scope.onmessage = async ({ data }) => {
  appOrigin = data.appOrigin ?? null;
  const response = await handleWorkerRequest(data.request, { ...deps, manifestPubKey: data.manifestPubKey });
  scope.postMessage(response);
  // The buffers have already been overwritten in `handleWorkerRequest`. JS strings cannot be wiped.
  scope.close();
};
