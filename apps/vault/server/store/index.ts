import type { SqlDriver } from './driver';
import { migrate } from './migrate';
import { createSqlStore } from './sql-store';
import type { VaultStore } from './types';

export * from './types';

const POSTGRES_URL = /^postgres(ql)?:\/\//;
const SQLITE_PREFIX = 'sqlite:';
const DEVELOPMENT_DATABASE = `${SQLITE_PREFIX}data/vault.db`;

/** Each adapter is loaded only if used: a Postgres deployment does not open `node:sqlite`. */
export async function openDriver(url: string): Promise<SqlDriver> {
  if (POSTGRES_URL.test(url)) {
    const { openPostgres } = await import('./postgres');
    const poolSize = Number(process.env.DATABASE_POOL_SIZE) || undefined;
    return openPostgres(url, poolSize);
  }
  if (url.startsWith(SQLITE_PREFIX)) {
    const { openSqlite } = await import('./sqlite');
    return openSqlite(url.slice(SQLITE_PREFIX.length));
  }
  throw new Error('DATABASE_URL must start with postgres:// or sqlite:');
}

/** Opens the database and applies pending migrations. */
export async function openStore(url: string): Promise<VaultStore> {
  const driver = await openDriver(url);
  try {
    await migrate(driver);
  } catch (error) {
    await driver.close().catch(() => undefined);
    throw error;
  }
  return createSqlStore(driver);
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is missing');
  return DEVELOPMENT_DATABASE;
}

// On `globalThis` so hot reload, which re-instantiates the module, does not open another connection.
const holder = globalThis as typeof globalThis & { __vaultStore?: { url: string; store: Promise<VaultStore> } };

export async function getStore(): Promise<VaultStore> {
  const url = databaseUrl();
  if (holder.__vaultStore?.url === url) return holder.__vaultStore.store;
  await closeDb();
  const store = openStore(url);
  holder.__vaultStore = { url, store };
  // A failure is not cached: the database may come back.
  store.catch(() => {
    if (holder.__vaultStore?.store === store) holder.__vaultStore = undefined;
  });
  return store;
}

export async function closeDb(): Promise<void> {
  const current = holder.__vaultStore;
  holder.__vaultStore = undefined;
  await current?.store.then((store) => store.close()).catch(() => undefined);
}

export const ping: VaultStore['ping'] = async () => (await getStore()).ping();
export const upsertUser: VaultStore['upsertUser'] = async (...args) => (await getStore()).upsertUser(...args);
export const getUser: VaultStore['getUser'] = async (...args) => (await getStore()).getUser(...args);
export const markExported: VaultStore['markExported'] = async (...args) => (await getStore()).markExported(...args);
export const createSession: VaultStore['createSession'] = async (...args) => (await getStore()).createSession(...args);
export const getSession: VaultStore['getSession'] = async (...args) => (await getStore()).getSession(...args);
export const setSessionChain: VaultStore['setSessionChain'] = async (...args) => (await getStore()).setSessionChain(...args);
export const deleteSession: VaultStore['deleteSession'] = async (...args) => (await getStore()).deleteSession(...args);
export const consumeJti: VaultStore['consumeJti'] = async (...args) => (await getStore()).consumeJti(...args);
export const createSet: VaultStore['createSet'] = async (...args) => (await getStore()).createSet(...args);
export const getSet: VaultStore['getSet'] = async (...args) => (await getStore()).getSet(...args);
export const getActiveSet: VaultStore['getActiveSet'] = async (...args) => (await getStore()).getActiveSet(...args);
export const getAccount: VaultStore['getAccount'] = async (...args) => (await getStore()).getAccount(...args);
export const activateSet: VaultStore['activateSet'] = async (...args) => (await getStore()).activateSet(...args);
export const findActiveSetsByOwner: VaultStore['findActiveSetsByOwner'] = async (...args) => (await getStore()).findActiveSetsByOwner(...args);
export const createWebauthnChallenge: VaultStore['createWebauthnChallenge'] = async (...args) => (await getStore()).createWebauthnChallenge(...args);
export const consumeWebauthnChallenge: VaultStore['consumeWebauthnChallenge'] = async (...args) => (await getStore()).consumeWebauthnChallenge(...args);
export const getActiveSetByCredential: VaultStore['getActiveSetByCredential'] = async (...args) => (await getStore()).getActiveSetByCredential(...args);
export const advanceCredentialCounter: VaultStore['advanceCredentialCounter'] = async (...args) => (await getStore()).advanceCredentialCounter(...args);
export const createRelinkNonce: VaultStore['createRelinkNonce'] = async (...args) => (await getStore()).createRelinkNonce(...args);
export const getRelinkNonce: VaultStore['getRelinkNonce'] = async (...args) => (await getStore()).getRelinkNonce(...args);
export const relinkWallet: VaultStore['relinkWallet'] = async (...args) => (await getStore()).relinkWallet(...args);
export const listWalletRelinks: VaultStore['listWalletRelinks'] = async (...args) => (await getStore()).listWalletRelinks(...args);
export const hitRateLimit: VaultStore['hitRateLimit'] = async (...args) => (await getStore()).hitRateLimit(...args);
export const recordShareARelease: VaultStore['recordShareARelease'] = async (...args) => (await getStore()).recordShareARelease(...args);
export const listShareAReleases: VaultStore['listShareAReleases'] = async (...args) => (await getStore()).listShareAReleases(...args);
export const getSponsoredDeployment: VaultStore['getSponsoredDeployment'] = async (...args) => (await getStore()).getSponsoredDeployment(...args);
export const prepareSponsoredDeployment: VaultStore['prepareSponsoredDeployment'] = async (...args) => (await getStore()).prepareSponsoredDeployment(...args);
export const claimSponsoredDeployment: VaultStore['claimSponsoredDeployment'] = async (...args) => (await getStore()).claimSponsoredDeployment(...args);
export const completeSponsoredDeployment: VaultStore['completeSponsoredDeployment'] = async (...args) => (await getStore()).completeSponsoredDeployment(...args);
export const releaseSponsoredDeployment: VaultStore['releaseSponsoredDeployment'] = async (...args) => (await getStore()).releaseSponsoredDeployment(...args);
