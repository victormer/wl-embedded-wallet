export const RUNTIME_CONFIG_ID = 'vault-config';

export interface RuntimeConfig {
  rpId: string;
  manifestPubKey: string;
  brand: string;
}

/** The layout delivers the configuration in the HTML: B+C cannot make any API call. */
export function readRuntimeConfig(root: Pick<Document, 'getElementById'> = document): RuntimeConfig {
  const data = root.getElementById(RUNTIME_CONFIG_ID)?.dataset;
  const { rpId, manifestPubkey, brand } = data ?? {};
  if (!rpId || !manifestPubkey) throw new Error('Missing vault configuration');
  return { rpId, manifestPubKey: manifestPubkey, brand: brand ?? '' };
}
