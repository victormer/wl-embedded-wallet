import { Client } from 'pg';

/** Empties the database. Only used against the temporary Postgres from `pnpm test:pg`. */
export async function resetPostgres(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}
