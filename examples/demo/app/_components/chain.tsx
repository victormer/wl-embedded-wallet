import type { PublicDemoChain } from '@/server/chains';

export type ChainOption = PublicDemoChain;

// Each network's own public color (in globals.css), as a plain square: no third-party logo files, no inline styles.
const NETWORK_FAMILIES: Record<number, 'ethereum' | 'polygon' | 'base'> = {
  1: 'ethereum',
  11155111: 'ethereum',
  137: 'polygon',
  80002: 'polygon',
  8453: 'base',
  84532: 'base',
};

/** 14 px tile in the network's color; neutral for a chain without one (local development chains). */
export function ChainTile({ chainId }: { chainId: number }) {
  return <span className="chain-tile" data-network={NETWORK_FAMILIES[chainId] ?? 'other'} aria-hidden="true" />;
}

export function ChainBadge({ chain }: { chain: Pick<ChainOption, 'chainId' | 'name'> }) {
  return (
    <span className="chain-badge">
      <ChainTile chainId={chain.chainId} />
      {chain.name}
    </span>
  );
}

/** Explorer links exist only when the chain declares an `explorerUrl` (already validated, no trailing slash). */
export function explorerAddressUrl(chain: ChainOption | null | undefined, address: string): string | null {
  return chain?.explorerUrl ? `${chain.explorerUrl}/address/${address}` : null;
}

export function explorerTxUrl(chain: ChainOption | null | undefined, hash: string): string | null {
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${hash}` : null;
}
