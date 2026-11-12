'use client';

import { createVaultClient, VaultError, type VaultChain } from '@wl-embedded-wallet/sdk/client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deploymentNotice, messageFor } from '@/lib/messages';
import { SignForms } from './sign-forms';
import { ChainTile, explorerAddressUrl, explorerTxUrl, type ChainOption } from '../_components/chain';
import { CopyValue } from '../_components/copy-value';
import { ArrowUpRight, Download, ExternalLink, LifeBuoy, LockOpen, LogOut, RotateCw } from '../_components/icons';
import { Notice } from '../_components/notice';
import { SiteHeader } from '../_components/site-shell';

export type { ChainOption } from '../_components/chain';

type WalletState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'none' }
  | { status: 'ready'; address: `0x${string}`; owner: `0x${string}`; deployed: boolean | null; deployable: boolean; sponsored: boolean; transactionsSponsored: boolean; chainError: string | null };
type ActionNotice = { kind: 'ok' | 'error'; text: string; code?: string; link?: { href: string; label: string } };

// Only the chain is sent: the demo server resolves the RPC, never the browser.
async function requestToken(chain?: VaultChain): Promise<string> {
  const response = await fetch('/api/vault/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chain ? { chainId: chain.chainId } : {}),
  });
  if (!response.ok) throw new Error('TOKEN');
  const { token } = (await response.json()) as { token: string };
  return token;
}

function codeOf(error: unknown): string {
  return error instanceof VaultError ? error.code : 'INTERNAL';
}

const PROTECTS = ['Seed rebuilt only in the browser, in the vault’s origin', 'Shares verified by a signed manifest', 'Emergency Kit and code work offline'];

export function WalletPanel({ email, vaultOrigin, chains }: { email: string; vaultOrigin: string; chains: ChainOption[] }) {
  const router = useRouter();
  const client = useMemo(() => createVaultClient({ vaultOrigin, getToken: requestToken }), [vaultOrigin]);
  const [wallet, setWallet] = useState<WalletState>({ status: 'loading' });
  const [chainId, setChainId] = useState<number | null>(chains[0]?.chainId ?? null);
  const chain = useMemo<VaultChain | null>(() => (chainId === null ? null : { chainId }), [chainId]);
  const selected = chains.find((option) => option.chainId === chainId) ?? null;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const deployButton = useRef<HTMLButtonElement>(null);

  const goToDeploy = useCallback(() => {
    const button = deployButton.current;
    if (!button) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    button.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    button.focus({ preventScroll: true });
  }, []);

  const loadWallet = useCallback(async () => {
    try {
      const response = await fetch(chainId === null ? '/api/wallet' : `/api/wallet?chainId=${chainId}`, { cache: 'no-store' });
      if (response.status === 401) {
        router.replace('/');
        return;
      }
      if (!response.ok) throw new Error('WALLET');
      const body = (await response.json()) as {
        exists: boolean;
        address: `0x${string}` | null;
        owner: `0x${string}` | null;
        deployed?: boolean | null;
        deployable?: boolean;
        sponsored?: boolean;
        transactionsSponsored?: boolean;
        chainError?: string;
      };
      setWallet(
        body.exists && body.address && body.owner
          ? {
              status: 'ready',
              address: body.address,
              owner: body.owner,
              deployed: body.deployed ?? null,
              deployable: body.deployable ?? false,
              sponsored: body.sponsored ?? false,
              transactionsSponsored: body.transactionsSponsored ?? false,
              chainError: body.chainError ?? null,
            }
          : { status: 'none' },
      );
    } catch {
      setWallet({ status: 'error' });
    }
  }, [chainId, router]);

  useEffect(() => {
    void loadWallet();
  }, [loadWallet]);

  // `operation` opens the popup: it must be called within the user gesture, with nothing async before it.
  async function runOperation<T extends { address: string }>(operation: () => Promise<T>, success: (result: T) => Omit<ActionNotice, 'kind'>) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      setNotice({ kind: 'ok', ...success(result) });
      await loadWallet();
    } catch (error) {
      const code = codeOf(error);
      setNotice({ kind: 'error', text: messageFor(code), code });
    }
    setBusy(false);
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/');
  }

  const deployment = wallet.status === 'ready' ? deploymentNotice(wallet.deployed, wallet.chainError) : null;
  const deploymentTone = wallet.status !== 'ready' ? 'neutral' : wallet.chainError ? 'error' : wallet.deployed ? 'ok' : wallet.deployed === null ? 'muted' : 'neutral';

  return (
    <>
      <SiteHeader
        page="wallet"
        actions={
          <button type="button" className="btn btn-ghost-dark" data-testid="logout-button" onClick={logout}>
            <LogOut size={14} />
            <span className="btn-label">Sign out</span>
          </button>
        }
      />

      <div className="workspace">
        <div className="page-head">
          <h1 className="headline">Your wallet</h1>
          <p className="page-meta">
            Signed in as{' '}
            <span className="page-meta-strong" data-testid="user-email">
              {email}
            </span>
            <span className="dot-sep" aria-hidden="true" />
            <span className="page-meta-count">{chains.length === 1 ? '1 testnet' : `${chains.length} testnets`}</span>
          </p>
        </div>

        <div className="workspace-grid">
          <div className="workspace-main">
            {busy && (
              <Notice kind="pending" data-testid="action-pending">
                Complete the operation in the vault window.
              </Notice>
            )}
            {notice && (
              <Notice kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid={notice.kind === 'error' ? 'action-error' : 'action-success'} data-code={notice.code}>
                {notice.text}
                {notice.link && (
                  <>
                    {' '}
                    <a className="inline-link" href={notice.link.href} target="_blank" rel="noopener noreferrer">
                      {notice.link.label}
                      <ExternalLink size={12} />
                    </a>
                  </>
                )}
              </Notice>
            )}

            <section className={wallet.status === 'ready' ? 'panel wallet-card seam' : 'panel wallet-card'} aria-labelledby="wallet-title">
              <div className="panel-head">
                <h2 className="panel-title" id="wallet-title">
                  Safe account
                </h2>
                {wallet.status === 'ready' && selected && (
                  <span className="chain-badge">
                    <ChainTile chainId={selected.chainId} />
                    {selected.name}
                  </span>
                )}
              </div>

              <div className="panel-body">
                {wallet.status === 'loading' && (
                  <div className="skeleton-stack" aria-busy="true">
                    <p className="label" data-testid="wallet-loading">
                      Checking the vault…
                    </p>
                    <span className="skeleton skeleton-line" />
                    <span className="skeleton skeleton-line short" />
                    <span className="skeleton skeleton-chip" />
                  </div>
                )}

                {wallet.status === 'error' && (
                  <div className="stack">
                    <Notice kind="error" data-testid="wallet-error">
                      {messageFor('VAULT_UNAVAILABLE')}
                    </Notice>
                    <div className="row">
                      <button type="button" className="btn btn-outline" data-testid="wallet-retry" onClick={() => void loadWallet()}>
                        <RotateCw size={14} />
                        Retry
                      </button>
                    </div>
                  </div>
                )}

                {wallet.status === 'none' && (
                  <div className="empty-state" data-testid="wallet-empty">
                    <h3 className="empty-title">No wallet yet</h3>
                    <p className="empty-text">Activate it in the vault: your keys never pass through this app.</p>
                    <div className="row row-center">
                      <button
                        type="button"
                        className="btn btn-brand"
                        data-testid="activate-button"
                        disabled={busy}
                        onClick={() => void runOperation(() => client.activate(), () => ({ text: 'Wallet activated.' }))}
                      >
                        Activate wallet
                        <span className="brand-chip" aria-hidden="true">
                          <ArrowUpRight size={14} strokeWidth={2.25} />
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline"
                        data-testid="relink-button"
                        disabled={busy}
                        onClick={() => void runOperation(() => client.relink(), ({ address }) => ({ text: `Wallet linked to this account: ${address}` }))}
                      >
                        I already have a wallet
                      </button>
                    </div>
                  </div>
                )}

                {wallet.status === 'ready' && (
                  <div className="stack">
                    <div className="field">
                      <span className="label">Safe address · the same on every chain</span>
                      <CopyValue
                        className="copy-value-lg"
                        value={wallet.address}
                        copyLabel="Copy the Safe address"
                        href={explorerAddressUrl(selected, wallet.address)}
                        hrefLabel={selected ? `View the Safe on the ${selected.name} explorer` : undefined}
                        data-testid="wallet-address"
                      />
                    </div>
                    <div className="field">
                      <span className="label">Owner · the Shamir-split key that controls the Safe</span>
                      <CopyValue
                        value={wallet.owner}
                        copyLabel="Copy the owner address"
                        href={explorerAddressUrl(selected, wallet.owner)}
                        hrefLabel={selected ? `View the owner on the ${selected.name} explorer` : undefined}
                        data-testid="wallet-owner"
                      />
                    </div>

                    <div className="chain-row">
                      <label className="field chain-field">
                        <span className="label">Network</span>
                        <span className="select-wrap">
                          {chainId !== null && <ChainTile chainId={chainId} />}
                          <select className="input" data-testid="chain-select" value={chainId ?? ''} disabled={busy} onChange={(event) => setChainId(Number(event.target.value))}>
                            {chains.map((option) => (
                              <option key={option.chainId} value={option.chainId}>
                                {option.name} ({option.chainId})
                              </option>
                            ))}
                          </select>
                        </span>
                      </label>
                      {selected?.nativeCurrency && (
                        <div className="field chain-fact">
                          <span className="label">Native currency</span>
                          <span className="chain-fact-value">{selected.nativeCurrency}</span>
                        </div>
                      )}
                    </div>

                    <p className={`status-line tone-${deploymentTone}`} data-testid="wallet-deployed" data-deployed={String(wallet.deployed)} data-code={wallet.chainError ?? undefined}>
                      <span className="sq" aria-hidden="true" />
                      <span>{deployment?.text}</span>
                    </p>

                    {wallet.deployed === false && !wallet.deployable && (
                      <Notice kind="caution" data-testid="deploy-unavailable">
                        This chain has no bundler configured in the vault: the wallet cannot be deployed here.
                      </Notice>
                    )}
                    {wallet.deployed === false && chain && (
                      <div className="deploy-row">
                        <button
                          ref={deployButton}
                          type="button"
                          className="btn"
                          data-testid="deploy-button"
                          disabled={busy || !wallet.deployable}
                          onClick={() =>
                            void runOperation(
                              () => client.deploy(chain),
                              ({ transactionHash }) => {
                                const href = transactionHash ? explorerTxUrl(selected, transactionHash) : null;
                                return {
                                  text: wallet.sponsored ? 'Wallet deployed at no cost.' : 'Wallet deployed.',
                                  ...(href ? { link: { href, label: 'View the transaction' } } : {}),
                                };
                              },
                            )
                          }
                        >
                          Deploy on this chain
                        </button>
                        {wallet.deployable && wallet.sponsored && <span className="chip blue">Sponsored</span>}
                        {wallet.deployable && !wallet.sponsored && (
                          <span className="hint">{selected?.nativeCurrency ? `Gas is paid in ${selected.nativeCurrency} from the Safe’s balance.` : 'Gas is paid from the Safe’s balance.'}</span>
                        )}
                      </div>
                    )}

                    <div className="vault-actions">
                      <span className="label">Vault actions</span>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-outline"
                          data-testid="unlock-button"
                          disabled={busy}
                          onClick={() => void runOperation(() => client.unlock(), ({ address }) => ({ text: `Unlock succeeded: ${address}` }))}
                        >
                          <LockOpen size={14} />
                          Test unlock
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline"
                          data-testid="recover-button"
                          disabled={busy}
                          onClick={() => void runOperation(() => client.recover(), ({ address }) => ({ text: `Recovery succeeded: ${address}` }))}
                        >
                          <LifeBuoy size={14} />I lost my passkey
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline"
                          data-testid="export-button"
                          disabled={busy}
                          onClick={() => void runOperation(() => client.export(), () => ({ text: 'Seed downloaded in the vault.' }))}
                        >
                          <Download size={14} />
                          Download the seed
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {wallet.status === 'ready' && chain && (
              <SignForms
                key={chain.chainId}
                client={client}
                address={wallet.address}
                chain={chain}
                chainOption={selected}
                deployed={wallet.deployed}
                deployable={wallet.deployable}
                transactionsSponsored={wallet.transactionsSponsored}
                busy={busy}
                setBusy={setBusy}
                onGoToDeploy={goToDeploy}
              />
            )}
          </div>

          <aside className="workspace-side" aria-label="Session">
            <section className="panel" aria-labelledby="session-title">
              <div className="panel-head">
                <h2 className="panel-title" id="session-title">
                  Session
                </h2>
              </div>
              <dl className="facts-list">
                <div>
                  <dt className="label">Vault origin</dt>
                  <dd className="mono small">{vaultOrigin}</dd>
                </div>
                <div>
                  <dt className="label">Networks</dt>
                  <dd>
                    <ul className="chain-list">
                      {chains.map((option) => (
                        <li key={option.chainId} className={option.chainId === chainId ? 'is-current' : undefined}>
                          <ChainTile chainId={option.chainId} />
                          <span className="chain-list-name">{option.name}</span>
                          <span className="chain-list-meta">
                            {option.nativeCurrency ? `${option.nativeCurrency} · ` : ''}
                            {option.chainId}
                          </span>
                          {option.explorerUrl && (
                            <a className="copy-button" href={option.explorerUrl} target="_blank" rel="noopener noreferrer" aria-label={`${option.name} explorer`} title={`${option.name} explorer`}>
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              </dl>
            </section>
            <section className="panel" aria-labelledby="protects-title">
              <div className="panel-head">
                <h2 className="panel-title" id="protects-title">
                  What the vault protects
                </h2>
              </div>
              <div className="panel-body">
                <p className="muted">This app only receives addresses, signatures and transaction hashes. Keys live in the vault window, on its own origin.</p>
                <ul className="facts">
                  {PROTECTS.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
