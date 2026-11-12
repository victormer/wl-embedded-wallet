export interface ChainRow {
  chainId: string;
  name: string;
  rpc: string;
  bundler: string;
  paymaster: string;
  policy: 'yes' | 'no';
  transactions: string;
}

export function summarize(raw: string): { problems: string[]; rows: ChainRow[] };
