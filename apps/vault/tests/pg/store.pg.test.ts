import { describe, expect, it } from 'vitest';
import { closeDb, getStore, ping } from '../../server/store';
import { storeContract } from '../store/contract';
import { resetPostgres } from '../store/postgres-test';

const url = process.env.TEST_DATABASE_URL as string;

storeContract('Postgres', async () => {
  await resetPostgres(url);
  return url;
});

describe('selection by DATABASE_URL', () => {
  it('opens Postgres, answers the ping, and an unreachable URL does not reveal the password', async () => {
    await resetPostgres(url);
    process.env.DATABASE_URL = url;
    await expect(ping()).resolves.toBeUndefined();
    await closeDb();

    process.env.DATABASE_URL = 'postgres://vault:secret-that-must-not-leak@127.0.0.1:1/vault';
    const failure = await getStore().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain('secret-that-must-not-leak');
    delete process.env.DATABASE_URL;
    await closeDb();
  });
});
